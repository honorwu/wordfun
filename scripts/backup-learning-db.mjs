import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultLearningDatabasePath } from "../server/config.mjs";

const formatTimestamp = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const [inputPath, outputPathArg] = process.argv.slice(2);
if (process.argv.length > 4) {
  throw new Error("用法：node scripts/backup-learning-db.mjs [学习库路径] [备份文件路径]");
}

const sourcePath = path.resolve(inputPath || defaultLearningDatabasePath);
if (!existsSync(sourcePath)) {
  throw new Error(`未找到学习库文件：${sourcePath}`);
}

const defaultTarget = path.join(
  path.dirname(sourcePath),
  "backups",
  `${path.basename(sourcePath, path.extname(sourcePath))}-${formatTimestamp()}.sqlite`,
);
const targetPath = path.resolve(outputPathArg || defaultTarget);
if (targetPath === sourcePath) {
  throw new Error("备份路径不能与源学习库路径相同");
}
if (existsSync(targetPath)) {
  throw new Error(`目标备份文件已存在：${targetPath}`);
}

mkdirSync(path.dirname(targetPath), { recursive: true });

// 使用 SQLite 原生 VACUUM INTO，在 WAL 模式下可在线热备份且不阻断读操作。
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  source.exec("PRAGMA busy_timeout = 5000;");
  source.prepare("VACUUM INTO ?").run(targetPath);
} catch (error) {
  rmSync(targetPath, { force: true });
  throw error;
} finally {
  source.close();
}

const verify = new DatabaseSync(targetPath, { readOnly: true });
try {
  const integrity = verify.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") {
    throw new Error(`备份文件完整性校验失败：${integrity}`);
  }
  const reviewLogs = verify.prepare("SELECT COUNT(*) AS count FROM review_logs").get()?.count ?? 0;
  console.log(JSON.stringify({
    source: sourcePath,
    backup: targetPath,
    bytes: statSync(targetPath).size,
    reviewLogs,
  }, null, 2));
} catch (error) {
  rmSync(targetPath, { force: true });
  throw error;
} finally {
  verify.close();
}
