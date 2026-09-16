import type { AppState, CharacterStat, Progress, ReviewLog, WordStat } from "../types";

const fallbackProgress: Progress = {
  grade: 3,
  lessonId: "",
};

export const createDefaultState = (progress: Progress = fallbackProgress): AppState => ({
  progress,
  wordStats: {},
  charStats: {},
  logs: [],
});

const uniqueStrings = (values: unknown): string[] => (Array.isArray(values) ? Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))) : []);

const normalizeWordStats = (stats: AppState["wordStats"] | undefined): AppState["wordStats"] =>
  Object.fromEntries(
    Object.entries(stats ?? {}).map(([wordId, stat]) => [
      wordId,
      {
        attempts: stat.attempts ?? 0,
        mistakes: stat.mistakes ?? 0,
        streak: stat.streak ?? 0,
        lastReviewedAt: stat.lastReviewedAt,
        lastMistakeAt: stat.lastMistakeAt,
      } satisfies WordStat,
    ]),
  );

const normalizeCharStats = (stats: AppState["charStats"] | undefined): AppState["charStats"] =>
  Object.fromEntries(
    Object.entries(stats ?? {}).map(([char, stat]) => [
      char,
      {
        attempts: stat.attempts ?? 0,
        mistakes: stat.mistakes ?? 0,
        streak: stat.streak ?? 0,
        correctWordTexts: uniqueStrings(stat.correctWordTexts),
        wrongWordTexts: uniqueStrings(stat.wrongWordTexts),
        lastReviewedAt: stat.lastReviewedAt,
        lastMistakeAt: stat.lastMistakeAt,
      } satisfies CharacterStat,
    ]),
  );

const normalizeLogs = (logs: AppState["logs"] | undefined): AppState["logs"] =>
  (logs ?? []).map(
    (log) =>
      ({
        id: log.id,
        date: log.date,
        wordIds: uniqueStrings(log.wordIds),
        wrongWordIds: uniqueStrings(log.wrongWordIds),
        wrongChars: Array.isArray(log.wrongChars)
          ? log.wrongChars.filter((item): item is { wordId: string; char: string } => typeof item?.wordId === "string" && typeof item?.char === "string")
          : undefined,
      }) satisfies ReviewLog,
  );

export const normalizeState = (state: Partial<AppState>, fallback = fallbackProgress): AppState => {
  const base = createDefaultState(fallback);
  return {
    ...base,
    ...state,
    progress: state.progress ?? base.progress,
    wordStats: normalizeWordStats(state.wordStats),
    charStats: normalizeCharStats(state.charStats),
    logs: normalizeLogs(state.logs),
  };
};
