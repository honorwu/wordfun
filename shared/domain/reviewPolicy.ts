import type { CharacterStat, QuestionCarryover, ReviewLog, WordStat } from "../types.ts";

const dayMs = 24 * 60 * 60 * 1000;
export const masteryNetCorrect = 1;
export const historyMistakeCooldownDays = 5;
export const historyMistakeWordLimit = 5;
export const historyBasicWordLimit = 5;
export const historyRoundWordLimit = 20;
export const reviewCorrectionWindowMs = 3 * dayMs;

export const isWithinReviewCorrectionWindow = (date: string, now = Date.now()) => {
  const elapsed = now - Date.parse(date);
  return elapsed >= 0 && elapsed <= reviewCorrectionWindowMs;
};

export const canSupplementReview = (log: Pick<ReviewLog, "practiceMode" | "date">, now = Date.now()) =>
  (log.practiceMode === "lesson" || log.practiceMode === "history") && isWithinReviewCorrectionWindow(log.date, now);

export const uniqueTexts = (texts?: string[]) => Array.from(new Set(texts ?? []));

export const charWrongWordCount = (stat?: CharacterStat) => uniqueTexts(stat?.wrongWordTexts).length;

const netCorrectCount = (stat?: Pick<WordStat, "attempts" | "mistakes">) => {
  const attempts = stat?.attempts ?? 0;
  const mistakes = stat?.mistakes ?? 0;
  const correctAttempts = Math.max(0, attempts - mistakes);
  return correctAttempts - mistakes;
};

export const charNetCorrectCount = (stat?: CharacterStat) => netCorrectCount(stat);

export const hasWordTextEvidence = (stat: CharacterStat | undefined, wordText: string) =>
  Boolean(stat && (stat.correctWordTexts?.includes(wordText) || stat.wrongWordTexts?.includes(wordText)));

export const isMasteredChar = (stat?: CharacterStat) => charNetCorrectCount(stat) >= masteryNetCorrect;

export const isReviewedScreeningChar = (stat?: CharacterStat) => Boolean(stat && stat.attempts > 0);

export const isCorrectedScreeningChar = (stat?: CharacterStat) => isMasteredChar(stat);

export const isPendingScreeningMistakeChar = (stat?: CharacterStat) => Boolean(stat && stat.mistakes > 0 && !isMasteredChar(stat));

const reviewTime = (value?: string | null) => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : -Infinity;
};

const nextMistakeReviewTime = (stat?: WordStat) =>
  Math.max(reviewTime(stat?.lastReviewedAt), reviewTime(stat?.lastMistakeAt)) + historyMistakeCooldownDays * dayMs;

export const isHistoryCharCoolingDown = (stat?: CharacterStat) =>
  isPendingScreeningMistakeChar(stat) && nextMistakeReviewTime(stat) > Date.now();

export const hasQuestionAttempt = (stat?: WordStat) => Boolean(stat && (stat.attempts > 0 || stat.lastReviewedAt));

export const isMasteredQuestion = (stat?: WordStat) =>
  Boolean(stat && stat.attempts > stat.mistakes && (stat.mistakes === 0 || stat.streak > 0));

export const isPendingQuestionMistake = (stat?: WordStat) => Boolean(stat && stat.mistakes > 0 && !isMasteredQuestion(stat));

export const isQuestionCoolingDown = (stat?: WordStat) => isPendingQuestionMistake(stat) && nextMistakeReviewTime(stat) > Date.now();

export const isQuestionCarryoverActive = (stat?: WordStat, carryover?: QuestionCarryover): carryover is QuestionCarryover =>
  Boolean(carryover && !isMasteredQuestion(stat) && (stat?.attempts ?? 0) <= carryover.baselineAttempts);

export const questionLearningState = (stat?: WordStat, carryover?: QuestionCarryover) => {
  if (isMasteredQuestion(stat)) return "mastered";
  if ((stat?.mistakes ?? 0) > 0 || isQuestionCarryoverActive(stat, carryover)) return "pending";
  // 旧记录可能只批改过部分字，整题首次判定仍需一次完整默写。
  return "unreviewed";
};

export const pendingQuestionDueAt = (stat?: WordStat, carryover?: QuestionCarryover) =>
  stat?.mistakes ? nextMistakeReviewTime(stat) : reviewTime(carryover?.availableAt);

export const historyQuestionStatus = (stat?: WordStat, carryover?: QuestionCarryover, now = Date.now()) => {
  const state = questionLearningState(stat, carryover);
  if (state !== "pending") return state;
  return pendingQuestionDueAt(stat, carryover) > now ? "waiting" : "due";
};
