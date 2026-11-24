import type { AppState, DictationWord, Lesson, PracticeItem, Progress, QuestionCarryover } from "../types.ts";
import { uniqueChars, reviewCharsForWord } from "./characters.ts";
import { getDictationWords, lessonOrder, progressOrder, isVocabularyLesson } from "./catalog.ts";
import {
  hasQuestionAttempt, historyBasicWordLimit, historyMistakeWordLimit, historyRoundWordLimit,
  isMasteredQuestion, pendingQuestionDueAt, questionLearningState,
} from "./reviewPolicy.ts";

export const isMasteredWord = (word: DictationWord, state: AppState) => isMasteredQuestion(state.wordStats[word.id]);

export const generateCurrentLessonPractice = (lessons: Lesson[], state: AppState): PracticeItem[] => {
  const selectedLesson = lessons.find((lesson) => lesson.id === state.progress.lessonId);
  if (!selectedLesson) {
    return [];
  }
  const textbookWordIds = new Set((selectedLesson.textbookWords ?? []).map((word) => word.id));

  return (selectedLesson.dictationWords ?? []).map((word, index) => ({
    word,
    score: 1000 - index,
    reasons: [textbookWordIds.has(word.id) ? "词语表" : "课文取词"],
  }));
};

export const generatePoetryPractice = (lesson: Lesson): PracticeItem[] =>
  (lesson.dictationWords ?? []).map((word, index) => ({
    word,
    score: 1000 - index,
    reasons: ["古诗全文默写"],
  }));

const getScreeningLessons = (lessons: Lesson[], progress: Progress) => {
  const selectedOrder = progressOrder(progress, lessons);
  return lessons
    .filter((lesson) => lessonOrder(lesson) < selectedOrder && isVocabularyLesson(lesson))
    .sort((left, right) => lessonOrder(right) - lessonOrder(left));
};

export const getScreeningQuestions = (lessons: Lesson[], progress: Progress) =>
  getDictationWords(getScreeningLessons(lessons, progress));

export const getScreeningTargetChars = (lessons: Lesson[], progress: Progress) =>
  uniqueChars(getScreeningQuestions(lessons, progress).flatMap(reviewCharsForWord));

type HistoryGroup = NonNullable<PracticeItem["historyGroup"]>;
const historyReasons = { mistake: "错题再练", recent: "近课未练", basic: "基础未练" } as const;

export const generateScreeningPractice = (
  lessons: Lesson[],
  state: AppState,
  targetCount = historyRoundWordLimit,
  { carryover = {}, now = Date.now() }: {
    carryover?: Record<string, QuestionCarryover>;
    now?: number;
  } = {},
): PracticeItem[] => {
  const pastLessons = getScreeningLessons(lessons, state.progress).reverse();
  const textbookWordIds = new Set(pastLessons.flatMap((lesson) => (lesson.textbookWords ?? []).map((word) => word.id)));
  const due: Array<{ word: DictationWord; time: number }> = [];
  const freshByLesson: DictationWord[][] = [];
  const basicFresh: DictationWord[] = [];
  for (const lesson of pastLessons) {
    const fresh: DictationWord[] = [];
    for (const word of lesson.dictationWords ?? []) {
      const stat = state.wordStats[word.id];
      const carried = carryover[word.id];
      const learningState = questionLearningState(stat, carried);
      if (learningState === "pending") {
        const dueAt = pendingQuestionDueAt(stat, carried);
        if (dueAt <= now) due.push({ word, time: dueAt });
      } else if (learningState === "unreviewed") {
        fresh.push(word);
      }
    }
    freshByLesson.push(fresh);
    if (lesson.grade >= 2) basicFresh.push(...fresh);
  }

  // 同一时间沿用上面遍历的教材顺序，课内始终保留原题序。
  const oldestFirst = (a: { time: number }, b: { time: number }) => a.time === b.time ? 0 : a.time - b.time;
  const mistakes = due.sort(oldestFirst).slice(0, Math.min(targetCount, historyMistakeWordLimit)).map(({ word }) => word);
  const openSlots = targetCount - mistakes.length;
  const recentQuota = historyRoundWordLimit - historyBasicWordLimit - historyMistakeWordLimit;
  const basicLimit = Math.min(historyBasicWordLimit, Math.max(0, openSlots - recentQuota));
  const basic = basicFresh.slice(0, basicLimit);
  const basicIds = new Set(basic.map((word) => word.id));
  const recent = freshByLesson.reverse().flat()
    .filter((word) => !basicIds.has(word.id))
    .slice(0, openSlots - basic.length);

  const items: PracticeItem[] = [];
  const addGroup = (words: DictationWord[], historyGroup: HistoryGroup) => {
    for (const word of words) {
      items.push({
        word, historyGroup, score: targetCount - items.length,
        reasons: [historyReasons[historyGroup], textbookWordIds.has(word.id) ? "词语表" : "课文取词"],
        ...(historyGroup === "mistake" && { mistakeReview: state.wordStats[word.id]?.mistakes ? "word" : "character" }),
      });
    }
  };
  addGroup(mistakes, "mistake");
  addGroup(recent, "recent");
  addGroup(basic, "basic");
  return items;
};

export const summarizeCoverage = (words: DictationWord[], state: AppState) => {
  const chars = new Set(words.flatMap(reviewCharsForWord));
  const reviewedChars = new Set(words.filter((word) => hasQuestionAttempt(state.wordStats[word.id])).flatMap(reviewCharsForWord));
  const wrongWords = words.filter((word) => {
    const stat = state.wordStats[word.id];
    return stat && stat.mistakes > 0 && !isMasteredWord(word, state);
  }).length;
  const masteredWords = words.filter((word) => isMasteredWord(word, state)).length;

  return {
    totalWords: words.length,
    totalChars: chars.size,
    reviewedChars: reviewedChars.size,
    wrongWords,
    masteredWords,
  };
};
