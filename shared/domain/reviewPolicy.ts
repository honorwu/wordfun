import type { CharacterCategory, CharacterStat } from "../types.ts";

const dayMs = 24 * 60 * 60 * 1000;
export const masteryNetCorrect = 1;
export const historyMistakeCooldownDays = 5;
export const historyMistakeWordLimit = 5;
export const historyRoundWordLimit = 20;

export const categoryWeights: Record<CharacterCategory, number> = { "一类": 9, "二类": 7 };

const localDayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export const daysSince = (date?: string) => {
  if (!date) {
    return 999;
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return 999;
  }
  const elapsed = localDayStart(new Date()) - localDayStart(parsed);
  return Math.max(0, Math.floor(elapsed / dayMs));
};

export const uniqueTexts = (texts?: string[]) => Array.from(new Set(texts ?? []));

export const charWrongWordCount = (stat?: CharacterStat) => uniqueTexts(stat?.wrongWordTexts).length;

export const charNetCorrectCount = (stat?: CharacterStat) => {
  const attempts = stat?.attempts ?? 0;
  const mistakes = stat?.mistakes ?? 0;
  const correctAttempts = Math.max(0, attempts - mistakes);
  return correctAttempts - mistakes;
};

export const hasWordTextEvidence = (stat: CharacterStat | undefined, wordText: string) =>
  Boolean(stat && (stat.correctWordTexts?.includes(wordText) || stat.wrongWordTexts?.includes(wordText)));

export const isMasteredChar = (stat?: CharacterStat) => charNetCorrectCount(stat) >= masteryNetCorrect;

export const isReviewedScreeningChar = (stat?: CharacterStat) => Boolean(stat && stat.attempts > 0);

export const isCorrectedScreeningChar = (stat?: CharacterStat) => isMasteredChar(stat);

export const isPendingScreeningMistakeChar = (stat?: CharacterStat) => Boolean(stat && stat.mistakes > 0 && !isMasteredChar(stat));

export const isHistoryCharCoolingDown = (stat?: CharacterStat) => {
  if (!isPendingScreeningMistakeChar(stat)) return false;
  const dates = [stat?.lastReviewedAt, stat?.lastMistakeAt].map((date) => Date.parse(date ?? "")).filter(Number.isFinite);
  return dates.length > 0 && Date.now() - Math.max(...dates) < historyMistakeCooldownDays * dayMs;
};
