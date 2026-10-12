import assert from "node:assert/strict";
import { createServer } from "vite";
import { getCompanionWords, getLessons, requireCatalogDatabase } from "../server/db.mjs";

const vite = await createServer({
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});
const catalogDb = requireCatalogDatabase();

try {
  const {
    addMissedWrongChars,
    applyReviewResult,
    charReviewKey,
    generateCurrentLessonPractice,
    generateScreeningPractice,
    getEligibleCharacterWords,
    getScreeningTargetChars,
    fullDictationCharsForWord,
    lessonOrder,
  } = await vite.ssrLoadModule("/src/lib/scheduler.ts");
  const lessons = getLessons(catalogDb);
  const companionWords = getCompanionWords(catalogDb);
  const regularLessons = lessons.filter((lesson) => lesson.lessonKind !== "classical_poetry");
  const duplicatePrompts = [];
  const coverageErrors = [];
  const textbookErrors = [];
  const promptKey = (word) => `${word.text}\u0000${word.pinyin}`;
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
    const textbookWords = lesson.textbookWords ?? [];
    const textbookPrompts = new Set(textbookWords.map(promptKey));
    const textbookChars = new Set(textbookWords.flatMap(fullDictationCharsForWord));
    const uncoveredChars = new Set(lesson.words.flatMap((word) => word.chars).filter((char) => !textbookChars.has(char)));
    sourceCardCount += textbookWords.length + uncoveredChars.size;
    mergedCardCount += items.length;

    const seenPrompts = new Set();
    for (const item of items) {
      const key = promptKey(item.word);
      if (seenPrompts.has(key)) {
        duplicatePrompts.push(`${lesson.title}：${item.word.text}`);
      }
      seenPrompts.add(key);
      if (textbookPrompts.has(key)) {
        const missingTargets = fullDictationCharsForWord(item.word).filter((char) => !item.word.chars.includes(char));
        if (missingTargets.length > 0) textbookErrors.push(`${lesson.title}：${item.word.text} 未默写整词`);
      } else if (item.word.chars.some((char) => textbookChars.has(char))) {
        coverageErrors.push(`${lesson.title}：补充题重复覆盖词语表生字 ${item.word.text}`);
      }
    }

    const missingWords = textbookWords.filter((word) => !seenPrompts.has(promptKey(word)));
    if (missingWords.length > 0) textbookErrors.push(`${lesson.title}：遗漏词语表 ${missingWords.map((word) => word.text).join("、")}`);
    const expectedOrder = [...textbookPrompts];
    const actualOrder = items.slice(0, expectedOrder.length).map((item) => promptKey(item.word));
    if (actualOrder.some((key, index) => key !== expectedOrder[index])) textbookErrors.push(`${lesson.title}：词语表未按课本顺序排在前面`);

    const expectedChars = new Set([...textbookChars, ...lesson.words.flatMap((word) => word.chars)]);
    const actualCharCounts = new Map();
    for (const char of items.flatMap((item) => item.word.chars)) {
      actualCharCounts.set(char, (actualCharCounts.get(char) ?? 0) + 1);
    }
    const missingChars = [...expectedChars].filter((char) => !actualCharCounts.has(char));
    const repeatedChars = [...actualCharCounts].filter(([char, count]) => uncoveredChars.has(char) && count !== 1).map(([char]) => char);
    if (missingChars.length > 0 || repeatedChars.length > 0) {
      coverageErrors.push(`${lesson.title}：缺少 ${missingChars.join("、") || "无"}；重复 ${repeatedChars.join("、") || "无"}`);
    }
  }

  if (duplicatePrompts.length > 0 || coverageErrors.length > 0 || textbookErrors.length > 0) {
    throw new Error([...duplicatePrompts, ...coverageErrors, ...textbookErrors].slice(0, 20).join("\n"));
  }

  const cricketLesson = lessons.find((lesson) => lesson.grade === 4 && lesson.unit === 1 && lesson.number === 10);
  assert.equal(cricketLesson?.title, "蟋蟀的住宅");
  const state = { progress: { grade: 4, lessonId: cricketLesson.id }, wordStats: {}, charStats: {}, logs: [] };
  const items = generateCurrentLessonPractice(lessons, state, companionWords);
  assert.equal(items.length, 23);
  assert.deepEqual(items.slice(0, 10).map((item) => item.word.text), ["住宅", "选择", "住址", "大厅", "柔弱", "平坦", "光滑", "修理", "重要", "增长"]);
  const masteredState = {
    ...state,
    charStats: Object.fromEntries(items.flatMap((item) => item.word.chars).map((char) => [char, { attempts: 1, mistakes: 0, streak: 1 }])),
  };
  assert.deepEqual(generateCurrentLessonPractice(lessons, masteredState, companionWords).slice(0, 10).map((item) => item.word.text), items.slice(0, 10).map((item) => item.word.text));
  assert.equal(generateCurrentLessonPractice(lessons, masteredState, companionWords).length, 23);

  const flatItem = items.find((item) => item.word.text === "平坦");
  assert.deepEqual(flatItem.word.chars, ["平", "坦"]);
  const reviewed = applyReviewResult(state, [flatItem], new Set([charReviewKey(flatItem.word.id, "坦")]));
  assert.equal(reviewed.charStats.平.mistakes, 0);
  assert.equal(reviewed.charStats.坦.mistakes, 1);

  const nextLesson = lessons.find((lesson) => lesson.grade === 4 && lesson.unit === 1 && lesson.number === 11);
  assert.ok(nextLesson);
  const historyState = { ...state, progress: { grade: 4, lessonId: nextLesson.id } };
  const historyChars = getScreeningTargetChars(lessons, historyState.progress, companionWords);
  for (const char of ["柔", "弱", "平", "坦", "光", "滑"]) assert.ok(historyChars.includes(char));
  const selectiveHistoryState = {
    ...historyState,
    charStats: Object.fromEntries(historyChars.filter((char) => char !== "坦").map((char) => [char, { attempts: 1, mistakes: 0, streak: 1 }])),
  };
  const selectiveHistory = generateScreeningPractice(lessons, selectiveHistoryState, 20, companionWords);
  assert.deepEqual(selectiveHistory.map((item) => [item.word.text, item.word.chars]), [["平坦", ["坦"]]]);
  const recentMistakeState = { ...selectiveHistoryState, charStats: { ...selectiveHistoryState.charStats, 坦: { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date().toISOString() } } };
  assert.equal(generateScreeningPractice(lessons, recentMistakeState, 20, companionWords).length, 0);
  recentMistakeState.charStats.坦.lastReviewedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  assert.equal(generateScreeningPractice(lessons, recentMistakeState, 20, companionWords)[0]?.word.text, "平坦");
  assert.ok(generateScreeningPractice(lessons, historyState, 20, companionWords).every((item) => lessonOrder(lessons.find((lesson) => lesson.id === item.word.lessonId)) < lessonOrder(nextLesson)));

  const legacyWord = getEligibleCharacterWords(lessons, state.progress, companionWords).find((word) => word.id === `${cricketLesson.id}-char-宅`);
  assert.equal(legacyWord.text, "住宅");
  assert.deepEqual(legacyWord.chars, ["宅"]);
  const legacyState = {
    ...state,
    wordStats: { [legacyWord.id]: { attempts: 1, mistakes: 0, streak: 1 } },
    charStats: { 宅: { attempts: 1, mistakes: 0, streak: 1 }, 住: { attempts: 1, mistakes: 0, streak: 1 } },
    logs: [{ id: "legacy-review", date: new Date().toISOString(), practiceMode: "lesson", wordIds: [legacyWord.id], wrongWordIds: [] }],
  };
  const wordById = new Map([legacyWord, ...items.map((item) => item.word)].map((word) => [word.id, word]));
  assert.equal(addMissedWrongChars(legacyState, "legacy-review", [{ wordId: legacyWord.id, char: "住" }], wordById), legacyState);
  assert.equal(addMissedWrongChars(legacyState, "legacy-review", [{ wordId: legacyWord.id, char: "宅" }], wordById).charStats.宅.mistakes, 1);

  const singleTextbookWord = { id: "single-textbook", text: "光", pinyin: "guāng", chars: ["光"], grade: 4, lessonId: "single-lesson", lessonTitle: "单字词", category: "一类" };
  const singleLesson = {
    id: "single-lesson", grade: 4, unit: 1, number: 1, title: "单字词",
    words: [{ ...singleTextbookWord, id: "single-character" }],
    textbookWords: [singleTextbookWord],
    textCompanions: { 光: [{ text: "光滑", pinyin: "guāng huá", chars: ["光", "滑"] }] },
  };
  assert.deepEqual(generateCurrentLessonPractice([singleLesson], { ...state, progress: { grade: 4, lessonId: singleLesson.id } }).map((item) => item.word.text), ["光"]);

  console.log(
    JSON.stringify(
      {
        lessonsAudited: regularLessons.length,
        sourceCardCount,
        mergedCardCount,
        removedDuplicateCards: sourceCardCount - mergedCardCount,
        duplicatePrompts: 0,
        characterCoverageErrors: 0,
        textbookCoverageErrors: 0,
        cricketLessonPrompts: items.length,
      },
      null,
      2,
    ),
  );
} finally {
  catalogDb.close();
  await vite.close();
}
