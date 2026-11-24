import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");
export const dataDir = process.env.ZIQU_DATA_DIR ? path.resolve(process.env.ZIQU_DATA_DIR) : path.join(projectRoot, "data");
export const defaultCatalogDatabasePath = process.env.ZIQU_CATALOG_DB_PATH
  ? path.resolve(process.env.ZIQU_CATALOG_DB_PATH)
  : path.join(dataDir, "ziqu-catalog.sqlite");
export const defaultLearningDatabasePath = process.env.ZIQU_LEARNING_DB_PATH
  ? path.resolve(process.env.ZIQU_LEARNING_DB_PATH)
  : path.join(dataDir, "ziqu-learning-inherited-mastery.sqlite");
export const defaultStudentId = process.env.ZIQU_STUDENT_ID || "default-student";

export const readJson = (relativePath) => JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
