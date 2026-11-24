import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultCatalogDatabasePath, defaultLearningDatabasePath, projectRoot } from "../server/config.mjs";
import { hasTable, runTransaction } from "../server/db/query.mjs";
import { CATALOG_FORMAT, catalogSchemaSql } from "../server/db/schema.mjs";
import { hanChars, readMaterials, stableId } from "./textbook/materials.mjs";
import { resolveReviewedPrompts } from "./textbook/reviewed-prompts.mjs";
import { compileSupplementWords } from "./textbook/dictation-words.mjs";

const writeCatalog = (db, { lessons, sources, wordSource }) => {
  const reviewedPrompts = Map.groupBy(resolveReviewedPrompts(lessons, sources), (entry) => entry.lessonId);
  db.exec(catalogSchemaSql);
  const insert = (table, columns) =>
    db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${columns.split(", ").map(() => "?").join(", ")})`);
  const insertSource = insert("source_files", "path, grade, term, sha256");
  const insertLesson = insert("lessons", "id, grade, term, unit_name, unit_index, section, lesson_number, sort_order, title, lesson_kind, source_file");
  const insertLessonChar = insert("lesson_characters", "lesson_id, char, category, pinyin, char_order");
  const insertQuestion = insert("questions", "id, lesson_id, position, kind, text, pinyin, target_chars, hint_text, source_file, source_row, source_details, poem");

  runTransaction(db, () => {
    insert("catalog_meta", "key, value").run("source_format", CATALOG_FORMAT);
    for (const [source, { grade, term, content }] of sources) {
      insertSource.run(source, grade, term, createHash("sha256").update(content).digest("hex"));
    }
    for (const lesson of lessons) {
      const { id, grade, term, number, sortOrder, title, kind, section, unit, unitIndex, source, chars, words, poems } = lesson;
      insertLesson.run(id, grade, term, unit, unitIndex, section, number, sortOrder, title, kind, source);

      for (const { char, pinyin, order, column } of chars) {
        insertLessonChar.run(id, char, column === "写字表" ? "一类" : "二类", pinyin, order);
      }
      for (const entry of words) {
        const { entry_id, context_type, context_text, original_context_text, context_pdf_pages, wordlist_pdf_page, note } = entry;
        const sourceDetails = JSON.stringify({ entry_id, context_type, context_text, original_context_text, context_pdf_pages, wordlist_pdf_page, note });
        insertQuestion.run(stableId("textbook-prompt", id, entry.text), id, entry.word_order - 1, "textbook", entry.text, entry.pinyin,
          JSON.stringify([...new Set(hanChars(entry.text))]), entry.hint_text, wordSource, entry.sourceRow, sourceDetails, null);
      }
      for (const [order, poem] of poems.entries()) {
        const { title, titlePinyin, author, dynasty, lines } = poem;
        const poemId = stableId("textbook-classical", id, title);
        const text = lines.map((line) => line.text).join("\n");
        const pinyin = lines.map((line) => line.pinyin).join("\n");
        const targets = [...new Set(hanChars([title, dynasty, author, text].filter(Boolean).join("\n")))];
        insertQuestion.run(`poem-${poemId}`, id, words.length + order, "poem", text, pinyin, JSON.stringify(targets), null,
          source, 1, null, JSON.stringify({ title, titlePinyin, author, dynasty }));
      }
      if (kind === "classical_poetry") continue;

      const supplements = compileSupplementWords(lesson, reviewedPrompts.get(id) ?? []);
      for (const [index, { prompt, targets }] of supplements.entries()) {
        const { word, pinyin, hint, kind: context_kind, source: source_text, rows: source_rows } = prompt;
        const details = JSON.stringify({ context_kind, source_text, source_rows });
        insertQuestion.run(`${id}-char-${targets[0]}`, id, words.length + poems.length + index, "supplement", word, pinyin,
          JSON.stringify(targets), hint, source, source_rows[0], details, null);
      }
    }
  });
};

const materialRoot = process.argv[2] ?? path.join(projectRoot, "textbook");
if (process.argv.length > 3) {
  throw new Error("用法：node scripts/rebuild-catalog-from-materials.mjs [教材目录]");
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
      textbookWords: db.prepare("SELECT COUNT(*) AS count FROM questions WHERE kind = 'textbook'").get().count,
      textbookHints: db.prepare("SELECT COUNT(hint_text) AS count FROM questions WHERE kind = 'textbook'").get().count,
      supplementWords: db.prepare("SELECT COUNT(*) AS count FROM questions WHERE kind = 'supplement'").get().count,
      supplementTargets: db.prepare("SELECT SUM(json_array_length(target_chars)) AS count FROM questions WHERE kind = 'supplement'").get().count,
      poemPrompts: db.prepare("SELECT COUNT(*) AS count FROM questions WHERE kind = 'poem'").get().count,
    }, null, 2));
  } finally { db.close(); }
  renameSync(filename, defaultCatalogDatabasePath);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
