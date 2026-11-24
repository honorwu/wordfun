// 供重建脚本和既有调用方使用的兼容入口；新代码按职责导入具体模块。
export { projectRoot, dataDir, defaultCatalogDatabasePath, defaultLearningDatabasePath, defaultStudentId, readJson } from "./config.mjs";
export { catalogSchemaSql, learningSchemaSql } from "./db/schema.mjs";
export { ensureDataDir, openCatalogDatabase, openLearningDatabase, requireCatalogDatabase } from "./db/connection.mjs";
export { runTransaction } from "./db/query.mjs";
export { getLessons } from "./db/catalog.mjs";
export { ensureDefaultStudent, getState, getReviewActivity, saveState } from "./db/learning.mjs";
