import { createServer } from "vite";
import { getCompanionWords, getLessons, requireCatalogDatabase } from "../server/db.mjs";

const vite = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});
const catalogDb = requireCatalogDatabase();

try {
  const { generateCurrentLessonPractice } = await vite.ssrLoadModule("/src/lib/scheduler.ts");
  const lessons = getLessons(catalogDb);
  const companionWords = getCompanionWords(catalogDb);
  const regularLessons = lessons.filter((lesson) => lesson.lessonKind !== "classical_poetry");
  const duplicatePrompts = [];
  const coverageErrors = [];
  let sourceCardCount = 0;
  let mergedCardCount = 0;

  for (const lesson of regularLessons) {
    const state = {
      progress: { grade: lesson.grade, lessonId: lesson.id },
      wordStats: {},
      charStats: {},
      logs: [],
    };
    const items = generateCurrentLessonPractice(lessons, state, companionWords);
    sourceCardCount += lesson.words.length;
    mergedCardCount += items.length;

    const seenPrompts = new Set();
    for (const item of items) {
      const promptKey = `${item.word.text}\u0000${item.word.pinyin}`;
      if (seenPrompts.has(promptKey)) {
        duplicatePrompts.push(`${lesson.title}：${item.word.text}`);
      }
      seenPrompts.add(promptKey);
    }

    const expectedChars = new Set(lesson.words.flatMap((word) => word.chars));
    const actualCharCounts = new Map();
    for (const char of items.flatMap((item) => item.word.chars)) {
      actualCharCounts.set(char, (actualCharCounts.get(char) ?? 0) + 1);
    }
    const missingChars = [...expectedChars].filter((char) => !actualCharCounts.has(char));
    const repeatedChars = [...actualCharCounts].filter(([, count]) => count !== 1).map(([char]) => char);
    if (missingChars.length > 0 || repeatedChars.length > 0) {
      coverageErrors.push(`${lesson.title}：缺少 ${missingChars.join("、") || "无"}；重复 ${repeatedChars.join("、") || "无"}`);
    }
  }

  if (duplicatePrompts.length > 0 || coverageErrors.length > 0) {
    throw new Error([...duplicatePrompts, ...coverageErrors].slice(0, 20).join("\n"));
  }

  console.log(
    JSON.stringify(
      {
        lessonsAudited: regularLessons.length,
        sourceCardCount,
        mergedCardCount,
        removedDuplicateCards: sourceCardCount - mergedCardCount,
        duplicatePrompts: 0,
        characterCoverageErrors: 0,
      },
      null,
      2,
    ),
  );
} finally {
  catalogDb.close();
  await vite.close();
}
