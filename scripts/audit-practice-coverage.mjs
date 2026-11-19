import { DatabaseSync } from "node:sqlite";
import { defaultCatalogDatabasePath } from "../server/config.mjs";
import { getCompanionWords, getLessons } from "../server/db/catalog.mjs";
import { isVocabularyLesson, lessonOrder } from "../shared/domain/catalog.ts";
import { hanLength } from "../shared/domain/characters.ts";
import { generateCurrentLessonPractice, generateScreeningPractice } from "../shared/domain/practice.ts";
import { createDefaultState } from "../shared/domain/state.ts";

const catalog = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
try {
  const lessons = getLessons(catalog).sort((left, right) => lessonOrder(left) - lessonOrder(right));
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const companions = getCompanionWords(catalog);
  const last = lessons.at(-1);
  if (!last) throw new Error("词库没有可审计的课次");
  const boundary = { ...last, id: "coverage-end", sortOrder: (last.sortOrder ?? last.number) + 1, words: [], textbookWords: [] };
  const simulation = (lesson) => createDefaultState({ grade: lesson.grade, lessonId: lesson.id });
  const history = generateScreeningPractice([...lessons, boundary], simulation(boundary), Number.MAX_SAFE_INTEGER, companions);

  const audit = (words) => {
    const single = words.filter((word) => hanLength(word.text) === 1);
    const withoutSentence = words.filter((word) => !word.textbookHint);
    return {
      stats: {
        total: words.length,
        single: single.length,
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
  console.log(JSON.stringify({
    textbookWords: audit(lessons.flatMap((lesson) => lesson.textbookWords ?? [])),
    lessonPractice: audit(lessons.filter(isVocabularyLesson).flatMap((lesson) =>
      generateCurrentLessonPractice(lessons, simulation(lesson), companions).map((item) => item.word))),
    historyPractice: audit(history.map((item) => item.word)),
  }, null, 2));
} finally {
  catalog.close();
}
