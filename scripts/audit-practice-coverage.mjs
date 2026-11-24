import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { defaultCatalogDatabasePath } from "../server/config.mjs";
import { getLessons } from "../server/db/catalog.mjs";
import { isVocabularyLesson, lessonOrder } from "../shared/domain/catalog.ts";
import { hanLength } from "../shared/domain/characters.ts";
import { generateCurrentLessonPractice, generateScreeningPractice } from "../shared/domain/practice.ts";
import { createDefaultState } from "../shared/domain/state.ts";

const catalog = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
try {
  const lessons = getLessons(catalog).sort((left, right) => lessonOrder(left) - lessonOrder(right));
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const last = lessons.at(-1);
  if (!last) throw new Error("词库没有可审计的课次");
  const boundary = { ...last, id: "coverage-end", sortOrder: (last.sortOrder ?? last.number) + 1, words: [], textbookWords: [] };
  const simulation = (lesson) => createDefaultState({ grade: lesson.grade, lessonId: lesson.id });
  const current = lessons.filter(isVocabularyLesson).flatMap((lesson) =>
    generateCurrentLessonPractice(lessons, simulation(lesson)).map(({ word }) => word));
  const currentById = new Map(current.map((word) => [word.id, word]));
  const historyFor = (lesson, scope = lessons) => {
    const words = generateScreeningPractice(scope, simulation(lesson), Number.MAX_SAFE_INTEGER).map(({ word }) => word);
    for (const word of words) assert.strictEqual(word, currentById.get(word.id), `历史题与当课题不一致：${word.lessonTitle} · ${word.text}`);
    return words;
  };
  const isBareSingle = (word) => hanLength(word.text) === 1 && !word.textbookHint;

  const audit = (words) => {
    const single = words.filter((word) => hanLength(word.text) === 1);
    const withoutSentence = words.filter((word) => !word.textbookHint);
    return {
      stats: {
        total: words.length,
        single: single.length,
        singleWithoutHint: single.filter(isBareSingle).length,
        distinctSingle: new Set(single.map((word) => word.text)).size,
        withoutSentence: withoutSentence.length,
        multiCharWithoutSentence: withoutSentence.filter((word) => hanLength(word.text) > 1).length,
      },
      needsReview: words.filter((word) => hanLength(word.text) === 1 || !word.textbookHint).map((word) => ({
        grade: word.grade,
        term: lessonsById.get(word.lessonId)?.unit,
        lesson: word.lessonTitle,
        word: word.text,
        pinyin: word.pinyin,
        single: hanLength(word.text) === 1,
        withoutSentence: !word.textbookHint,
      })),
    };
  };
  const historyProgress = lessons.map((lesson) => ({
    grade: lesson.grade, term: lesson.unit, lesson: lesson.title, singleWithoutHint: historyFor(lesson).filter(isBareSingle).length,
  }));
  const invalidHints = current.flatMap((word) => {
    if (!word.textbookHint) return [];
    const parts = word.textbookHint.split("〔　〕");
    const missingBlank = parts.length === 1;
    const showsAnswer = parts.some((part) => part.includes(word.text));
    if (!missingBlank && !showsAnswer) return [];
    return [{ id: word.id, lesson: word.lessonTitle, word: word.text, hint: word.textbookHint, missingBlank, showsAnswer }];
  });
  const lessonPractice = audit(current);
  console.log(JSON.stringify({
    textbookWords: audit(lessons.flatMap((lesson) => lesson.textbookWords ?? [])),
    lessonPractice,
    historyPractice: audit(historyFor(boundary, [...lessons, boundary])),
    historyProgress: {
      checkedLessons: historyProgress.length,
      withSingleWithoutHint: historyProgress.filter((row) => row.singleWithoutHint > 0),
    },
    invalidHints,
  }, null, 2));
  if (lessonPractice.stats.withoutSentence > 0 || invalidHints.length > 0) process.exitCode = 1;
} finally {
  catalog.close();
}
