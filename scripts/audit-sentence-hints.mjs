import { getCompanionWords, getLessons, requireCatalogDatabase } from "../server/db.mjs";
import { sentenceHintForWord } from "../src/lib/sentenceHints.ts";

const catalogDb = requireCatalogDatabase();
const lessons = getLessons(catalogDb);
const companionWords = getCompanionWords(catalogDb);

const byText = new Map();

for (const lesson of lessons) {
  for (const word of lesson.words) {
    byText.set(word.text, word);
  }
}

for (const [char, words] of Object.entries(companionWords)) {
  for (const word of words) {
    if (!byText.has(word.text)) {
      byText.set(word.text, {
        ...word,
        id: `companion-${char}-${word.text}`,
        grade: 1,
        lessonId: "",
        lessonTitle: "配词",
        category: "二类",
      });
    }
  }
}

const words = [...byText.values()].sort((a, b) => a.text.localeCompare(b.text, "zh-Hans-CN"));
const missing = [];
const counts = new Map();

for (const word of words) {
  const hint = sentenceHintForWord(word);
  counts.set(hint.source, (counts.get(hint.source) ?? 0) + 1);
  if (hint.source === "missing") {
    missing.push(word);
  }
}

console.log(
  JSON.stringify(
    {
      total: words.length,
      counts: Object.fromEntries(counts),
      missing: missing.length,
      missingSamples: missing.slice(0, 120).map((word) => word.text),
    },
    null,
    2,
  ),
);

if (process.argv.includes("--fail-on-missing") && missing.length > 0) {
  process.exitCode = 1;
}
