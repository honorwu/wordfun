import type { CharacterStat, QuestionCarryover, WordStat } from "../types.ts";

const dayMs = 24 * 60 * 60 * 1000;
export const masteryNetCorrect = 1;
export const historyMistakeCooldownDays = 5;
export const historyMistakeWordLimit = 5;
export const historyRoundWordLimit = 20;
export const reviewCorrectionWindowMs = 3 * dayMs;

export const isWithinReviewCorrectionWindow = (date: string, now = Date.now()) => {
  const elapsed = now - Date.parse(date);
  return elapsed >= 0 && elapsed <= reviewCorrectionWindowMs;
};

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

const isWithinReviewInterval = (stat: Pick<WordStat, "lastReviewedAt" | "lastMistakeAt"> | undefined, now = Date.now()) => {
  const dates = [stat?.lastReviewedAt, stat?.lastMistakeAt].map((date) => Date.parse(date ?? "")).filter(Number.isFinite);
  return dates.length > 0 && now - Math.max(...dates) < historyMistakeCooldownDays * dayMs;
};

export const isHistoryCharCoolingDown = (stat?: CharacterStat) =>
  isPendingScreeningMistakeChar(stat) && isWithinReviewInterval(stat);

export const hasQuestionAttempt = (stat?: WordStat) => Boolean(stat && (stat.attempts > 0 || stat.lastReviewedAt));

export const isMasteredQuestion = (stat?: WordStat) => netCorrectCount(stat) >= masteryNetCorrect;

export const isPendingQuestionMistake = (stat?: WordStat) => Boolean(stat && stat.mistakes > 0 && !isMasteredQuestion(stat));

export const isQuestionCoolingDown = (stat?: WordStat) => isPendingQuestionMistake(stat) && isWithinReviewInterval(stat);

export const isQuestionCarryoverActive = (stat?: WordStat, carryover?: QuestionCarryover): carryover is QuestionCarryover =>
  Boolean(carryover && !isMasteredQuestion(stat) && (stat?.attempts ?? 0) <= carryover.baselineAttempts);

export const historyQuestionStatus = (stat?: WordStat, carryover?: QuestionCarryover, now = Date.now()) => {
  if (isMasteredQuestion(stat)) return "mastered";
  if (isPendingQuestionMistake(stat)) return isWithinReviewInterval(stat, now) ? "waiting" : "due";
  if (isQuestionCarryoverActive(stat, carryover)) return Date.parse(carryover.availableAt ?? "") > now ? "waiting" : "due";
  return "unreviewed";
};
