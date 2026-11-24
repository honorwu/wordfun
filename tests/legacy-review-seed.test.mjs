import assert from "node:assert/strict";
import test from "node:test";
import { openCatalogDatabase, openLearningDatabase } from "../server/db/connection.mjs";
import { seedLegacyReview } from "../server/db/legacy-review-seed.mjs";
import { allRows, runTransaction } from "../server/db/query.mjs";

test("旧生字复练选择可考到的现题，合并同题并按学生保留冷却和练习基线", () => {
  const catalogDb = openCatalogDatabase(":memory:");
  const target = openLearningDatabase(":memory:");
  try {
    catalogDb.exec("INSERT INTO source_files (path, sha256) VALUES ('source.md', 'synthetic')");
    const insertLesson = catalogDb.prepare(
      `INSERT INTO lessons (id, grade, term, unit_name, unit_index, section,
        lesson_number, sort_order, title, lesson_kind, source_file)
       VALUES (?, 3, 1, '一', 1, '课文', ?, ?, ?, 'regular', 'source.md')`,
    );
    for (const [index, id] of ["first", "second", "current", "later"].entries()) {
      insertLesson.run(id, index + 1, index + 1, id);
    }
    const insertQuestion = catalogDb.prepare(
      `INSERT INTO questions (id, lesson_id, position, kind, text, pinyin, target_chars, source_file, source_row)
       VALUES (?, ?, ?, ?, ?, '', ?, 'source.md', 1)`,
    );
    for (const [id, lesson, position, kind, chars] of [
      ["single", "first", 0, "textbook", ["甲"]],
      ["known", "first", 1, "textbook", ["丁"]],
      ["both", "second", 0, "supplement", ["甲", "乙"]],
      ["current-alone", "current", 0, "textbook", ["乙"]],
      ["future-only", "later", 0, "textbook", ["丙"]],
      ["future-mastered", "later", 1, "textbook", ["乃"]],
    ]) {
      insertQuestion.run(id, lesson, position, kind, chars.join(""), JSON.stringify(chars));
    }
    target.exec(`
      INSERT INTO students (id, name) VALUES ('a', '甲'), ('b', '乙');
      INSERT INTO progress VALUES ('a', 3, 'current'), ('b', 3, 'first');
      INSERT INTO word_stats (student_id, word_id, attempts, mistakes, streak)
      VALUES ('a', 'both', 2, 1, 0), ('b', 'current-alone', 3, 3, 0);
    `);
    const insertChar = target.prepare(
      `INSERT INTO char_stats (student_id, char, attempts, mistakes, last_reviewed_at, last_mistake_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertChar.run("a", "甲", 1, 1, "2026-01-03T12:00:00.000Z", null);
    insertChar.run("a", "乙", 1, 1, "2026-01-02T12:00:00.000Z", "2026-01-04T12:00:00.000Z");
    insertChar.run("a", "丙", 1, 1, null, null);
    insertChar.run("a", "丁", 1, 0, null, null);
    insertChar.run("a", "乃", 1, 0, null, null);
    insertChar.run("a", "外", 1, 1, null, null);
    insertChar.run("b", "甲", 1, 0, null, null);
    insertChar.run("b", "乙", 1, 1, "2026-01-01T12:00:00.000Z", null);

    assert.deepEqual(runTransaction(target, () => seedLegacyReview({ target, catalogDb })), {
      inheritedChars: 2, carriedQuestions: 3,
    });
    assert.deepEqual(allRows(target, "SELECT student_id, char FROM inherited_char_mastery ORDER BY student_id")
      .map(Object.values), [["a", "丁"], ["b", "甲"]]);
    assert.deepEqual(allRows(target,
      "SELECT student_id, word_id, baseline_attempts, available_at FROM review_carryover ORDER BY student_id, word_id")
      .map(Object.values), [
      ["a", "both", 2, "2026-01-09T12:00:00.000Z"],
      ["a", "future-only", 0, null],
      ["b", "current-alone", 3, "2026-01-06T12:00:00.000Z"],
    ]);
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM word_stats").get().count, 2);
  } finally {
    target.close();
    catalogDb.close();
  }
});
