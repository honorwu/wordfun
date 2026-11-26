import type { AppState, CharacterStat, Progress, ReviewItemPresentation, ReviewLog, WordStat } from "../types.ts";
import { normalizeWordIssues } from "./wordIssues.ts";

const fallbackProgress: Progress = {
  grade: 3,
  lessonId: "",
};

export const createDefaultState = (progress: Progress = fallbackProgress): AppState => ({
  progress,
  wordStats: {},
  charStats: {},
  logs: [],
  wordIssues: [],
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

export const normalizeReviewItemPresentation = (presentation?: ReviewItemPresentation): ReviewItemPresentation | undefined => {
  if (typeof presentation?.pinyin !== "string" || typeof presentation.lessonId !== "string" || typeof presentation.lessonTitle !== "string") {
    return undefined;
  }
  const { pinyin, lessonId, lessonTitle, textbookHint, textbookExcerpt, mistakeReview, poem } = presentation;
  const hasPoem = typeof poem?.id === "string" && typeof poem.title === "string" && typeof poem.titlePinyin === "string"
    && Array.isArray(poem.lines) && poem.lines.every((line) => typeof line?.text === "string" && typeof line.pinyin === "string");
  return {
    pinyin, lessonId, lessonTitle,
    ...(typeof textbookHint === "string" && { textbookHint }),
    ...(typeof textbookExcerpt === "boolean" && { textbookExcerpt }),
    ...(mistakeReview === "word" || mistakeReview === "character" ? { mistakeReview } : {}),
    ...(hasPoem && { poem: {
      id: poem.id,
      title: poem.title,
      titlePinyin: poem.titlePinyin,
      ...(typeof poem.author === "string" && { author: poem.author }),
      ...(typeof poem.dynasty === "string" && { dynasty: poem.dynasty }),
      lines: poem.lines.map(({ text, pinyin }) => ({ text, pinyin })),
    } }),
  };
};

const normalizeLogs = (logs: AppState["logs"] | undefined): AppState["logs"] =>
  (logs ?? []).map(
    (log) =>
      ({
        id: log.id,
        date: log.date,
        practiceMode: log.practiceMode === "lesson" || log.practiceMode === "history" ? log.practiceMode : undefined,
        lessons: Array.isArray(log.lessons)
          ? Array.from(
              new Map(
                log.lessons
                  .filter((lesson) => typeof lesson?.id === "string" && lesson.id.length > 0)
                  .map((lesson) => [lesson.id, { id: lesson.id, title: typeof lesson.title === "string" ? lesson.title : "" }]),
              ).values(),
            )
          : undefined,
        wordIds: uniqueStrings(log.wordIds),
        wrongWordIds: uniqueStrings(log.wrongWordIds),
        wrongChars: Array.isArray(log.wrongChars)
          ? log.wrongChars.filter((item): item is { wordId: string; char: string } => typeof item?.wordId === "string" && typeof item?.char === "string")
          : undefined,
        reviewedItems: Array.isArray(log.reviewedItems)
          ? log.reviewedItems
              .filter((item) => typeof item?.wordId === "string" && item.wordId.length > 0)
              .map((item) => {
                const presentation = normalizeReviewItemPresentation(item.presentation);
                return {
                  wordId: item.wordId,
                  wordText: typeof item.wordText === "string" ? item.wordText : "",
                  reviewedChars: uniqueStrings(item.reviewedChars),
                  ...(presentation && { presentation }),
                };
              })
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
    wordIssues: normalizeWordIssues(state.wordIssues),
  };
};
