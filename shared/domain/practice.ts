import type { AppState, DictationWord, Lesson, PracticeItem, Progress, QuestionCarryover, WordStat } from "../types.ts";
import { uniqueChars, reviewCharsForWord } from "./characters.ts";
import { getDictationWords, lessonOrder, progressOrder, getEligibleWords, isVocabularyLesson } from "./catalog.ts";
import { categoryWeights, daysSince, hasQuestionAttempt, historyMistakeWordLimit, historyQuestionStatus, historyRoundWordLimit, isMasteredQuestion, isPendingQuestionMistake, isQuestionMasteryInherited } from "./reviewPolicy.ts";

const wordScore = (word: DictationWord, state: AppState): PracticeItem => {
  const stat: WordStat | undefined = state.wordStats[word.id];
  const reasons: string[] = [];
  let score = 20 + (categoryWeights[word.category] ?? 0);

  if (word.grade === state.progress.grade) {
    score += 26;
    reasons.push("当前年级");
  } else {
    score += Math.max(0, 14 - (state.progress.grade - word.grade) * 4);
    reasons.push("穿插复习");
  }

  if (!stat) {
    score += 28;
    reasons.push("新词");
  } else {
    const unresolvedMistake = stat.mistakes > 0 && !isMasteredWord(word, state);
    const wrongRate = unresolvedMistake ? stat.mistakes / Math.max(1, stat.attempts) : 0;
    const due = Math.min(24, daysSince(stat.lastReviewedAt) * 2);
    score += wrongRate * 60 + (unresolvedMistake ? stat.mistakes * 9 : 0) + due - Math.min(18, stat.streak * 5);
    if (unresolvedMistake) {
      reasons.push("错题回炉");
    }
    if (due >= 10) {
      reasons.push("到期复习");
    }
  }

  return { word, score, reasons: Array.from(new Set(reasons)).slice(0, 3) };
};

const reviewIntervalDays = (stat?: WordStat) => {
  if (!stat) {
    return 0;
  }
  if (stat.mistakes > 0 && stat.streak < 2) {
    return 1;
  }
  if (stat.streak <= 0) {
    return 1;
  }
  if (stat.streak === 1) {
    return 2;
  }
  if (stat.streak === 2) {
    return 4;
  }
  if (stat.streak === 3) {
    return 7;
  }
  return Math.min(21, stat.streak * 5);
};

const isDueWord = (word: DictationWord, state: AppState) => {
  const stat = state.wordStats[word.id];
  return Boolean(stat && !isMasteredWord(word, state) && daysSince(stat.lastReviewedAt) >= reviewIntervalDays(stat));
};

export const isMasteredWord = (word: DictationWord, state: AppState) => isMasteredQuestion(state.wordStats[word.id]);

const withReason = (item: PracticeItem, reason: string): PracticeItem => ({
  ...item,
  reasons: [reason, ...item.reasons.filter((current) => current !== reason)].slice(0, 3),
});

const sortPracticeItems = (items: PracticeItem[]) => [...items].sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id));

export const termMistakeReason = "本学期错词";

const isGardenLesson = (lesson: Lesson) => lesson.title.startsWith("语文园地");

const currentTeachingUnitFloor = (lessons: Lesson[], selectedLesson?: Lesson) => {
  if (!selectedLesson) {
    return Number.NEGATIVE_INFINITY;
  }
  const previousGarden = lessons
    .filter(
      (lesson) =>
        lesson.grade === selectedLesson.grade &&
        lesson.unit === selectedLesson.unit &&
        lesson.number < selectedLesson.number &&
        isGardenLesson(lesson),
    )
    .sort((a, b) => b.number - a.number)[0];
  return previousGarden?.number ?? Number.NEGATIVE_INFINITY;
};

export const generatePractice = (lessons: Lesson[], state: AppState, targetCount = 20): PracticeItem[] => {
  const eligibleWords = getEligibleWords(lessons, state.progress);
  const wordPosition = new Map(eligibleWords.map((word, index) => [word.id, index]));
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const selectedLesson = lessonById.get(state.progress.lessonId);
  const selectedOrder = progressOrder(state.progress, lessons);
  const currentUnitFloor = currentTeachingUnitFloor(lessons, selectedLesson);
  const orderForWord = (word: DictationWord) => {
    const lesson = lessonById.get(word.lessonId);
    return lesson ? lessonOrder(lesson) : word.grade * 1000;
  };
  const lessonForWord = (word: DictationWord) => lessonById.get(word.lessonId);
  const isInCurrentTeachingUnit = (word: DictationWord) => {
    const lesson = lessonForWord(word);
    return Boolean(
      selectedLesson &&
        lesson &&
        lesson.grade === selectedLesson.grade &&
        lesson.unit === selectedLesson.unit &&
        lesson.number > currentUnitFloor &&
        lesson.number <= selectedLesson.number,
    );
  };
  const isInCurrentTerm = (word: DictationWord) => {
    const lesson = lessonForWord(word);
    return Boolean(selectedLesson && lesson && lesson.grade === selectedLesson.grade && lesson.unit === selectedLesson.unit && orderForWord(word) <= selectedOrder);
  };
  const isInCurrentGrade = (word: DictationWord) => word.grade === state.progress.grade && orderForWord(word) <= selectedOrder;
  const isPastWord = (word: DictationWord) => orderForWord(word) < selectedOrder;

  const actionableWords = [...new Map(eligibleWords.map((word) => [word.id, word])).values()].filter((word) => !isMasteredWord(word, state));
  if (actionableWords.length === 0) {
    return [];
  }

  const scored = actionableWords
    .map((word) => wordScore(word, state))
    .sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id));

  const selected = new Map<string, PracticeItem>();
  const addSelected = (item: PracticeItem, reason: string) => {
    if (selected.has(item.word.id)) {
      return false;
    }
    selected.set(item.word.id, withReason(item, reason));
    return true;
  };
  const addFrom = (items: PracticeItem[], count: number, reason: string) => {
    let added = 0;
    for (const item of sortPracticeItems(items)) {
      if (selected.size >= targetCount || added >= count) {
        break;
      }
      if (addSelected(item, reason)) {
        added += 1;
      }
    }
  };

  const currentLessonQuota = Math.ceil(targetCount * 0.4);
  const currentUnitQuota = Math.ceil(targetCount * 0.25);
  const currentTermQuota = Math.ceil(targetCount * 0.15);
  const pastQuota = Math.max(1, Math.floor(targetCount * 0.1));
  const currentGradeQuota = Math.max(0, targetCount - currentLessonQuota - currentUnitQuota - currentTermQuota - pastQuota);

  const currentLessonItems = scored.filter(
    (item) => selectedLesson && item.word.lessonId === selectedLesson.id && !isMasteredWord(item.word, state),
  );
  const currentUnitItems = scored.filter((item) => isInCurrentTeachingUnit(item.word));
  const currentTermItems = scored.filter((item) => isInCurrentTerm(item.word));
  const mistakeItems = scored.filter((item) => isPendingQuestionMistake(state.wordStats[item.word.id]));
  const dueItems = scored.filter((item) => isDueWord(item.word, state));
  const currentGradeItems = scored.filter((item) => isInCurrentGrade(item.word));
  const pastItems = scored.filter((item) => isPastWord(item.word));

  addFrom(currentLessonItems, currentLessonQuota, "当前课");
  addFrom(currentUnitItems, currentUnitQuota, "当前单元");
  addFrom(currentTermItems, currentTermQuota, "当前学期");
  addFrom(currentGradeItems, currentGradeQuota, "当前学年");
  addFrom(pastItems, pastQuota, "旧词穿插");
  addFrom(mistakeItems, targetCount, "错题回炉");
  addFrom(dueItems, targetCount, "到期复习");
  for (const item of scored) {
    if (selected.size >= targetCount) {
      break;
    }
    addSelected(item, "综合复习");
  }
  return [...selected.values()].sort((a, b) => {
    return orderForWord(b.word) - orderForWord(a.word) || (wordPosition.get(b.word.id) ?? 0) - (wordPosition.get(a.word.id) ?? 0);
  });
};

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

export const hasMistakeSignalForWord = (word: DictationWord, state: AppState) =>
  Boolean(state.wordStats[word.id]?.mistakes);

export const getCurrentTermTextbookWords = (lessons: Lesson[], progress: Progress) => {
  const selectedLesson = lessons.find((lesson) => lesson.id === progress.lessonId);
  if (!selectedLesson) {
    return [];
  }

  return lessons
    .filter((lesson) => lesson.grade === selectedLesson.grade && lesson.unit === selectedLesson.unit)
    .sort((a, b) => lessonOrder(a) - lessonOrder(b))
    .flatMap((lesson) => lesson.textbookWords ?? []);
};

export const generateTermReviewPractice = (lessons: Lesson[], state: AppState): PracticeItem[] =>
  getCurrentTermTextbookWords(lessons, state.progress).map((word, index) => {
    const isMistake = hasMistakeSignalForWord(word, state);
    return {
      word,
      score: isMistake ? 2000 - index : 1000 - index,
      reasons: isMistake ? [termMistakeReason, "词语表"] : ["词语表"],
    };
  });

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
  { carryover = {}, inheritedMasteredChars = new Set<string>(), now = Date.now() }: {
    carryover?: Record<string, QuestionCarryover>;
    inheritedMasteredChars?: ReadonlySet<string>;
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
    const status = historyQuestionStatus(stat, carryover[word.id], now, isQuestionMasteryInherited(word, stat, inheritedMasteredChars));
    if (status === "due") due.push(word);
    if (status === "unreviewed") unreviewed.push(word);
  }
  const mistakeLimit = Math.min(targetCount, historyMistakeWordLimit);
  const mistakeOffset = rotationSeed * mistakeLimit;
  const mistakes = due.slice(mistakeOffset, mistakeOffset + mistakeLimit);
  const newLimit = targetCount - mistakes.length;
  const newOffset = rotationSeed * newLimit;
  const needsFirstResult = unreviewed.slice(newOffset, newOffset + newLimit);

  return [...mistakes, ...needsFirstResult].map((word, index) => ({
    word,
    score: targetCount - index,
    reasons: [index < mistakes.length ? "错题再练" : "待完成整题", textbookWordIds.has(word.id) ? "词语表" : "课文取词"],
  }));
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
