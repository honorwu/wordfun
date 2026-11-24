import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLegacyLessonResolver, migrateLegacyHistory } from "./legacy-history.mjs";
import { seedLegacyReview } from "./legacy-review-seed.mjs";
import { allRows, hasTable, oneRow, runTransaction } from "./query.mjs";
import { learningSchemaSql } from "./schema.mjs";

const requiredTables = ["students", "progress", "char_stats", "word_stats", "review_logs", "review_log_words"];
const preservedTables = ["students", "progress", "char_stats", "char_word_evidence", "review_logs", "review_log_lessons", "word_issues"];
const preparedTables = ["word_stats", "review_log_words", "review_log_chars", "review_log_reviewed_chars", "inherited_char_mastery", "review_carryover"];

const validateDatabase = (db, label) => {
  if (oneRow(db, "PRAGMA integrity_check")?.integrity_check !== "ok" || oneRow(db, "PRAGMA foreign_key_check")) {
    throw new Error(`${label}未通过 SQLite 完整性检查`);
  }
};

const copySharedColumns = (source, target, table, convert = (row) => row) => {
  if (!hasTable(source, table)) return;
  const legacyColumns = new Set(allRows(source, `PRAGMA table_info("${table}")`).map(({ name }) => name));
  const columns = allRows(target, `PRAGMA table_info("${table}")`)
    .map(({ name }) => name).filter((name) => legacyColumns.has(name));
  if (!columns.length) throw new Error(`旧学习库表 ${table} 缺少可迁移的字段`);
  const names = columns.map((name) => `"${name}"`).join(", ");
  const insert = target.prepare(`INSERT INTO "${table}" (${names}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of source.prepare(`SELECT ${names} FROM "${table}"`).iterate()) {
    const converted = convert(row);
    insert.run(...columns.map((column) => converted[column]));
  }
  if (table === "char_stats" && !legacyColumns.has("streak")) {
    target.exec("UPDATE char_stats SET streak = attempts WHERE mistakes = 0");
  }
};

const writeLearningDatabase = (source, target, catalogDb) => {
  const resolveLesson = createLegacyLessonResolver(catalogDb);
  const grades = new Map(allRows(catalogDb, "SELECT id, grade FROM lessons").map(({ id, grade }) => [id, grade]));
  const containsMigratedData = ["inherited_char_mastery", "review_carryover"].some((table) =>
    hasTable(source, table) && oneRow(source, `SELECT 1 FROM "${table}" LIMIT 1`),
  );
  runTransaction(target, () => {
    for (const table of preservedTables) {
      copySharedColumns(source, target, table, table === "progress" && !containsMigratedData ? (row) => {
        const lessonId = resolveLesson(row.lesson_id);
        return lessonId ? { ...row, lesson_id: lessonId, grade: grades.get(lessonId) ?? row.grade } : row;
      } : undefined);
    }
    if (containsMigratedData) {
      for (const table of preparedTables) copySharedColumns(source, target, table);
    } else {
      migrateLegacyHistory({ source, target, catalogDb });
      seedLegacyReview({ target, catalogDb });
    }
  });
};

export const bootstrapLegacyLearningDatabase = ({ legacyPath, learningPath, catalogDb }) => {
  if (!legacyPath || existsSync(learningPath) || !existsSync(legacyPath)) return false;

  const source = new DatabaseSync(legacyPath, { readOnly: true });
  let staging;
  try {
    source.exec("PRAGMA busy_timeout=5000;");
    runTransaction(source, () => {
      if (requiredTables.some((table) => !hasTable(source, table))) {
        throw new Error("旧学习库缺少必要的学习记录表");
      }
      validateDatabase(source, "旧学习库");
      const directory = path.dirname(learningPath);
      mkdirSync(directory, { recursive: true });
      staging = mkdtempSync(path.join(directory, ".learning-migration-"));
      const filename = path.join(staging, "learning.sqlite");
      const target = new DatabaseSync(filename);
      try {
        target.exec(learningSchemaSql);
        writeLearningDatabase(source, target, catalogDb);
        validateDatabase(target, "重建的学习库");
      } finally {
        target.close();
      }
      chmodSync(filename, 0o600);
    });
    try {
      // Temporary and final files share a filesystem. An existing target wins a startup race.
      linkSync(path.join(staging, "learning.sqlite"), learningPath);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    source.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
};
