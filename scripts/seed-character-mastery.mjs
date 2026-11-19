import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultCatalogDatabasePath, defaultStudentId } from "../server/config.mjs";
import { getLessons } from "../server/db/catalog.mjs";
import { openLearningDatabase } from "../server/db/connection.mjs";
import { ensureDefaultStudent } from "../server/db/learning.mjs";
import { runTransaction } from "../server/db/query.mjs";
import { buildBookCharacterIndex, textbookCharacterSet } from "../shared/domain/characterMastery.ts";

const [sourcePath, outputPath, startingLesson] = process.argv.slice(2);
if (!sourcePath || !outputPath || process.argv.length > 5) {
  throw new Error("用法：node scripts/seed-character-mastery.mjs <备份.sqlite> <新学习库.sqlite> [新教材课名]");
}
const output = path.resolve(outputPath);
if (existsSync(output) || existsSync(`${output}-wal`) || existsSync(`${output}-shm`)) {
  throw new Error("目标已存在；请选择新路径，不覆盖已有学习库");
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
let stats;
try {
  if (!source.prepare("SELECT 1 FROM students WHERE id = ?").get(defaultStudentId)) throw new Error("备份中没有对应学生");
  stats = source.prepare("SELECT char, attempts, mistakes FROM char_stats WHERE student_id = ? AND attempts > 0 ORDER BY char").all(defaultStudentId);
} finally { source.close(); }

const catalog = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
try {
  const lessons = getLessons(catalog);
  const matches = startingLesson ? lessons.filter((lesson) => lesson.title === startingLesson) : [];
  if (startingLesson && matches.length !== 1) throw new Error("新教材中的起始课名不存在或不唯一");
  const activeChars = textbookCharacterSet(buildBookCharacterIndex(lessons));
  const matchedStats = stats.filter((stat) => activeChars.has(stat.char));
  const directory = path.dirname(output);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(path.join(directory, ".mastery-"));
  try {
    const tempFile = path.join(staging, "learning.sqlite");
    const learning = openLearningDatabase(tempFile);
    try {
      runTransaction(learning, () => {
        ensureDefaultStudent(learning, catalog, defaultStudentId);
        if (matches.length) learning.prepare("UPDATE progress SET grade = ?, lesson_id = ? WHERE student_id = ?")
          .run(matches[0].grade, matches[0].id, defaultStudentId);
        const insert = learning.prepare("INSERT INTO char_stats (student_id, char, attempts, mistakes) VALUES (?, ?, ?, ?)");
        for (const stat of matchedStats) insert.run(defaultStudentId, stat.char, stat.attempts, stat.mistakes);
      });
      if (learning.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || learning.prepare("PRAGMA foreign_key_check").get()) {
        throw new Error("新学习库完整性检查失败");
      }
    } finally { learning.close(); }
    chmodSync(tempFile, 0o600);
    linkSync(tempFile, output);
    console.log(JSON.stringify({ learningDatabase: output, imported: matchedStats.length }, null, 2));
  } finally { rmSync(staging, { recursive: true, force: true }); }
} finally { catalog.close(); }
