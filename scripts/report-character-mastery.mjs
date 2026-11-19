import { DatabaseSync } from "node:sqlite";
import { defaultCatalogDatabasePath, defaultStudentId } from "../server/config.mjs";
import { getLessons } from "../server/db/catalog.mjs";
import { buildBookCharacterIndex, characterMastery } from "../shared/domain/characterMastery.ts";

const [learningPath, studentId = defaultStudentId] = process.argv.slice(2);
if (!learningPath || process.argv.length > 4) {
  throw new Error("用法：node scripts/report-character-mastery.mjs <学习库副本.sqlite> [学生 ID]");
}
const catalog = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
const learning = new DatabaseSync(learningPath, { readOnly: true });
try {
  if (!learning.prepare("SELECT 1 FROM students WHERE id = ?").get(studentId)) throw new Error("学习库中没有对应学生");
  const stats = new Map(learning.prepare("SELECT char, attempts, mistakes, last_reviewed_at FROM char_stats WHERE student_id = ?")
    .all(studentId).map((row) => [row.char, row]));
  const books = buildBookCharacterIndex(getLessons(catalog));
  const locations = new Map();
  for (const { grade, term, characters } of books) {
    for (const [char, textbookWords] of Object.entries(characters)) {
      const occurrences = locations.get(char) ?? [];
      occurrences.push({ grade, term, textbookWords });
      locations.set(char, occurrences);
    }
  }
  const groups = { mastered: [], corrected: [], pending: [], unreviewed: [] };
  const record = (char, stat) => ({
    char,
    status: characterMastery(stat),
    attempts: stat?.attempts ?? 0,
    mistakes: stat?.mistakes ?? 0,
    ...(stat?.last_reviewed_at ? { lastReviewedAt: stat.last_reviewed_at } : {}),
  });
  for (const [char, occurrences] of locations) {
    const item = record(char, stats.get(char));
    groups[item.status].push({ ...item, occurrences });
  }
  console.log(JSON.stringify({
    counts: Object.fromEntries(Object.entries(groups).map(([status, entries]) => [status, entries.length])),
    groups,
  }, null, 2));
} finally {
  learning.close();
  catalog.close();
}
