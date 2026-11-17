import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, defaultCatalogDatabasePath, defaultLearningDatabasePath } from "../config.mjs";
import { catalogSchemaSql, learningSchemaSql } from "./schema.mjs";
import { migrateLearningDatabase } from "./migrations.mjs";

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

export const openLearningDatabase = (databasePath = defaultLearningDatabasePath) => {
  const db = openDatabaseWithSchema(databasePath, learningSchemaSql);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  migrateLearningDatabase(db);
  return db;
};

export const requireCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => {
  if (!existsSync(databasePath)) {
    throw new Error(`Catalog SQLite database not found at ${databasePath}. Provide the catalog database before starting the server.`);
  }
  return openCatalogDatabase(databasePath);
};
