import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, defaultCatalogDatabasePath, defaultLearningDatabasePath } from "../config.mjs";
import { CATALOG_FORMAT, catalogSchemaSql, learningSchemaSql } from "./schema.mjs";
import { hasTable, oneRow } from "./query.mjs";

export const ensureDataDir = () => {
  mkdirSync(dataDir, { recursive: true });
};

const openDatabaseWithSchema = (databasePath, schemaSql) => {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(schemaSql);
  return db;
};

export const openCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => openDatabaseWithSchema(databasePath, catalogSchemaSql);

const requiredLearningTables = {
  students: [],
  progress: [],
  word_stats: [],
  char_stats: ["streak", "last_mistake_at"],
  char_word_evidence: [],
  review_carryover: [],
  inherited_char_mastery: [],
  review_logs: ["practice_mode"],
  review_log_lessons: [],
  review_log_words: ["prompt_text"],
  review_log_chars: [],
  review_log_reviewed_chars: [],
  word_issues: [],
};

const requireLearningSchema = (databasePath) => {
  if (databasePath === ":memory:" || !statSync(databasePath, { throwIfNoEntry: false })?.size) return;

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name));
    const tableInfo = db.prepare("SELECT name FROM pragma_table_info(?)");
    const missing = Object.entries(requiredLearningTables).flatMap(([table, columns]) => {
      if (!tables.has(table)) return [table];
      if (columns.length === 0) return [];
      const available = new Set(tableInfo.all(table).map(({ name }) => name));
      return columns.filter((column) => !available.has(column)).map((column) => `${table}.${column}`);
    });
    if (missing.length > 0) {
      throw new Error(`学习库格式不符（缺少 ${missing.join("、")}）：${databasePath}。请将 ZIQU_LEARNING_DB_PATH 指向当前版学习库。`);
    }
  } finally {
    db.close();
  }
};

export const openLearningDatabase = (databasePath = defaultLearningDatabasePath) => {
  requireLearningSchema(databasePath);
  const db = openDatabaseWithSchema(databasePath, learningSchemaSql);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA optimize;");
  return db;
};

export const requireCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => {
  if (!existsSync(databasePath)) {
    throw new Error(`Catalog SQLite database not found at ${databasePath}. Provide the catalog database before starting the server.`);
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!hasTable(db, "catalog_meta") || !hasTable(db, "questions")
      || oneRow(db, "SELECT value FROM catalog_meta WHERE key = 'source_format'")?.value !== CATALOG_FORMAT) {
      throw new Error("教材词库格式不符，请用 npm run rebuild:catalog 重建后再启动");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
