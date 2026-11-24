import type { AppState, DictationWord, Lesson, PracticeItem, Progress, QuestionCarryover } from "../types.ts";
import { uniqueChars, reviewCharsForWord } from "./characters.ts";
import { getDictationWords, lessonOrder, progressOrder, isVocabularyLesson } from "./catalog.ts";
import { hasQuestionAttempt, historyMistakeWordLimit, historyQuestionStatus, historyRoundWordLimit, isMasteredQuestion } from "./reviewPolicy.ts";

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

export const generateScreeningPractice = (
  lessons: Lesson[],
  state: AppState,
  targetCount = historyRoundWordLimit,
  rotationSeed = 0,
  { carryover = {}, now = Date.now() }: {
    carryover?: Record<string, QuestionCarryover>;
    now?: number;
  } = {},
): PracticeItem[] => {
  const pastLessons = getScreeningLessons(lessons, state.progress);
  const textbookWordIds = new Set(pastLessons.flatMap((lesson) => (lesson.textbookWords ?? []).map((word) => word.id)));
  const questions = getDictationWords(pastLessons);
  const due: DictationWord[] = [];
  const unreviewed: DictationWord[] = [];
  for (const word of questions) {
    const stat = state.wordStats[word.id];
    const status = historyQuestionStatus(stat, carryover[word.id], now);
    if (status === "due") due.push(word);
    if (status === "unreviewed") unreviewed.push(word);
  }
  const mistakeLimit = Math.min(targetCount, historyMistakeWordLimit);
  const mistakeOffset = rotationSeed * mistakeLimit;
  const mistakes = due.slice(mistakeOffset, mistakeOffset + mistakeLimit);
  const newLimit = targetCount - mistakes.length;
  const newOffset = rotationSeed * newLimit;
  const needsFirstResult = unreviewed.slice(newOffset, newOffset + newLimit);

  return [...mistakes, ...needsFirstResult].map((word, index) => {
    const isMistakeReview = index < mistakes.length;
    return {
      word,
      score: targetCount - index,
      reasons: [isMistakeReview ? "错题再练" : "待完成整题", textbookWordIds.has(word.id) ? "词语表" : "课文取词"],
      ...(isMistakeReview && { mistakeReview: state.wordStats[word.id]?.mistakes ? "word" : "character" }),
    };
  });
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
