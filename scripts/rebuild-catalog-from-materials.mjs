import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultCatalogDatabasePath, defaultLearningDatabasePath } from "../server/config.mjs";
import { hasTable, runTransaction } from "../server/db/query.mjs";
import { catalogSchemaSql } from "../server/db/schema.mjs";
import { hanChars, readMaterials, stableId } from "./textbook/materials.mjs";
import { resolveReviewedPrompts } from "./textbook/reviewed-prompts.mjs";

const writeCatalog = (db, { lessons, sources, wordSource }) => {
  const reviewedPrompts = resolveReviewedPrompts(lessons, sources);
  db.exec(catalogSchemaSql);
  const insert = (table, columns, prefix = "INSERT") =>
    db.prepare(`${prefix} INTO ${table} (${columns}) VALUES (${columns.split(", ").map(() => "?").join(", ")})`);
  const insertSource = insert("source_files", "path, kind, grade, term, sha256");
  const insertLesson = insert("lessons", "id, grade, term, term_name, unit_name, unit_index, section, lesson_number, sort_order, title, lesson_type, lesson_kind, is_classical, direct_dictation, source_file, source_row");
  const insertChar = insert("characters", "char, first_pinyin, first_lesson_id, first_grade, first_term", "INSERT OR IGNORE");
  const insertLessonChar = insert("lesson_characters", "lesson_id, char, category, pinyin, char_order, source_column");
  const insertWord = insert("words", "id, text, pinyin, word_kind, source_file, source_row");
  const insertWordChar = insert("word_characters", "word_id, char, char_order");
  const insertLessonWord = insert("lesson_words", "id, lesson_id, word_id, word_order, source_column");
  const insertContext = insert("textbook_word_contexts", "lesson_word_id, entry_id, context_type, context_text, original_context_text, hint_text, context_pdf_pages, wordlist_pdf_page, note");
  const insertHistoryCompanion = insert("lesson_history_companions", "lesson_id, char, word, pinyin, hint_text, source_row");
  const insertReviewedPrompt = insert("lesson_reviewed_prompts", "lesson_id, char, word, pinyin, hint_text, context_kind, source_text, source_rows");
  const insertPoem = insert("classical_texts", "id, lesson_id, grade, term, unit_index, title, title_pinyin, author, dynasty, source_file, text_order");
  const insertLine = insert("classical_lines", "text_id, line_order, text, pinyin");
  runTransaction(db, () => {
    insert("catalog_meta", "key, value").run("source_format", "dictation-textbook-v2");
    for (const [source, { kind, grade, term, content }] of sources) {
      insertSource.run(source, kind, grade, term, createHash("sha256").update(content).digest("hex"));
    }
    for (const lesson of lessons) {
      const { id, grade, term, number, sortOrder, title, kind, section, unit, unitIndex, source, chars, words, poems } = lesson;
      const classical = kind === "classical_poetry" ? 1 : 0;
      const lessonType = classical ? "古诗词" : section === "课文" || section === "识字" ? "正常课文" : "其他";
      insertLesson.run(id, grade, term, term === 1 ? "上册" : "下册", unit, unitIndex, section, number, sortOrder, title,
        lessonType, kind, classical, classical, source, 1);
      for (const { char, pinyin, order, column } of chars) {
        insertChar.run(char, pinyin, id, grade, term);
        insertLessonChar.run(id, char, column === "写字表" ? "一类" : "二类", pinyin || null, order, column);
      }
      for (const entry of words) {
        const wordId = stableId("textbook-word", id, entry.text);
        const lessonWordId = stableId("textbook-prompt", id, entry.text);
        insertWord.run(wordId, entry.text, entry.pinyin, "textbook", wordSource, entry.sourceRow);
        const sounds = entry.pinyin.split(/\s+/u);
        hanChars(entry.text).forEach((char, order) => {
          insertChar.run(char, sounds[order], id, grade, term);
          insertWordChar.run(wordId, char, order);
        });
        insertLessonWord.run(lessonWordId, id, wordId, entry.word_order - 1, "词语表");
        insertContext.run(lessonWordId, entry.entry_id, entry.context_type, entry.context_text, entry.original_context_text,
          entry.hint_text, entry.context_pdf_pages, entry.wordlist_pdf_page, entry.note);
      }
      for (const [order, poem] of poems.entries()) {
        const poemId = stableId("textbook-classical", id, poem.title);
        insertPoem.run(poemId, id, grade, term, unitIndex, poem.title, poem.titlePinyin, poem.author, poem.dynasty, source, order);
        poem.lines.forEach((line, index) => insertLine.run(poemId, index, line.text, line.pinyin));
      }
      for (const { char, word, pinyin, hint, sourceRow } of lesson.historyCompanions ?? []) {
        insertHistoryCompanion.run(id, char, word, pinyin, hint, sourceRow);
      }
    }
    for (const { lessonId, char, word, pinyin, hint, kind, source, rows } of reviewedPrompts) {
      insertReviewedPrompt.run(lessonId, char, word, pinyin, hint, kind, source, rows.join("、"));
    }
  });
};

const [materialRoot] = process.argv.slice(2);
if (!materialRoot || process.argv.length !== 3) {
  throw new Error("用法：node scripts/rebuild-catalog-from-materials.mjs <教材目录>");
}
if (defaultCatalogDatabasePath === defaultLearningDatabasePath) throw new Error("词库和学习库不能使用同一路径");
if (existsSync(defaultCatalogDatabasePath)) {
  const existing = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    if (!hasTable(existing, "catalog_meta") || hasTable(existing, "review_logs")) throw new Error("目标不是独立的教材词库，拒绝覆盖");
  } finally { existing.close(); }
}
const material = readMaterials(path.resolve(materialRoot));
mkdirSync(path.dirname(defaultCatalogDatabasePath), { recursive: true });
const staging = mkdtempSync(path.join(path.dirname(defaultCatalogDatabasePath), ".catalog-"));
try {
  const filename = path.join(staging, "catalog.sqlite");
  const db = new DatabaseSync(filename);
  try {
    writeCatalog(db, material);
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("教材数据库完整性检查失败");
    }
    console.log(JSON.stringify({
      lessons: db.prepare("SELECT COUNT(*) AS count FROM lessons").get().count,
      textbookWords: db.prepare("SELECT COUNT(*) AS count FROM textbook_words").get().count,
      textbookHints: db.prepare("SELECT COUNT(hint_text) AS count FROM textbook_word_contexts").get().count,
      historyCompanions: db.prepare("SELECT COUNT(*) AS count FROM lesson_history_companions").get().count,
      reviewedPrompts: db.prepare("SELECT COUNT(*) AS count FROM lesson_reviewed_prompts").get().count,
    }, null, 2));
  } finally { db.close(); }
  renameSync(filename, defaultCatalogDatabasePath);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
