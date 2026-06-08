import type { AppState, CharacterCategory, CharacterStat, DictationWord, Grade, Lesson, PrintLog, Progress, ReviewLog, UnsuitableWordFlag, WordStat } from "../types";

const fallbackProgress: Progress = {
  grade: 3,
  lessonId: "",
};

export const createDefaultState = (progress: Progress = fallbackProgress): AppState => ({
  progress,
  wordStats: {},
  charStats: {},
  unsuitableWords: {},
  customLessons: [],
  customWords: [],
  logs: [],
  printLogs: [],
});

const normalizeCategory = (category: unknown): CharacterCategory => (category === "一类" ? "一类" : "二类");

const normalizeWord = (word: DictationWord): DictationWord => ({
  ...word,
  category: normalizeCategory(word.category),
});

const normalizeLesson = (lesson: Lesson): Lesson => ({
  ...lesson,
  words: lesson.words.map(normalizeWord),
});

const uniqueStrings = (values: unknown): string[] => (Array.isArray(values) ? Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))) : []);

const normalizeGrade = (grade: unknown): Grade => {
  const value = Number(grade);
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : 1;
};

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

const normalizeUnsuitableWords = (
  words: Partial<Record<string, Partial<UnsuitableWordFlag>>> | undefined,
): AppState["unsuitableWords"] =>
  Object.fromEntries(
    Object.entries(words ?? {})
      .filter((entry): entry is [string, Partial<UnsuitableWordFlag>] => Boolean(entry[1]) && typeof entry[1]?.text === "string")
      .map(([wordId, word]) => {
        const firstFlaggedAt = word.firstFlaggedAt || word.lastFlaggedAt || new Date(0).toISOString();
        return [
          wordId,
          {
            wordId: word.wordId || wordId,
            text: word.text || "",
            pinyin: word.pinyin || "",
            grade: normalizeGrade(word.grade),
            lessonId: word.lessonId || "",
            lessonTitle: word.lessonTitle || "",
            category: normalizeCategory(word.category),
            flaggedCount: word.flaggedCount ?? 1,
            firstFlaggedAt,
            lastFlaggedAt: word.lastFlaggedAt || firstFlaggedAt,
          } satisfies UnsuitableWordFlag,
        ];
      }),
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

const normalizePrintLogs = (logs: AppState["printLogs"] | undefined): AppState["printLogs"] =>
  (logs ?? [])
    .filter((log): log is PrintLog => Boolean(log) && typeof log.id === "string" && Array.isArray(log.items))
    .map((log): PrintLog => ({
      id: log.id,
      date: log.date || new Date(0).toISOString(),
      localDate: log.localDate || (log.date || "").slice(0, 10),
      practiceMode: log.practiceMode === "lesson" ? "lesson" : "screening",
      lessonId: log.lessonId || "",
      lessonLabel: log.lessonLabel || "",
      title: log.title || (log.practiceMode === "lesson" ? "本课词语默写" : "历史生字筛查"),
      rangeLabel: log.rangeLabel || "",
      items: log.items
        .filter((item) => Boolean(item?.word?.id))
        .map((item) => ({
          word: normalizeWord(item.word),
          reasons: uniqueStrings(item.reasons),
        })),
    }))
    .filter((log) => log.items.length > 0);

export const normalizeState = (state: Partial<AppState>, fallback = fallbackProgress): AppState => {
  const base = createDefaultState(fallback);
  return {
    ...base,
    ...state,
    progress: state.progress ?? base.progress,
    customLessons: (state.customLessons ?? []).map(normalizeLesson),
    customWords: (state.customWords ?? []).map(normalizeWord),
    wordStats: normalizeWordStats(state.wordStats),
    charStats: normalizeCharStats(state.charStats),
    unsuitableWords: normalizeUnsuitableWords(state.unsuitableWords),
    logs: normalizeLogs(state.logs),
    printLogs: normalizePrintLogs(state.printLogs),
  };
};

export const exportState = (state: AppState) => {
  const payload = JSON.stringify(state, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ziqu-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

export const isGrade = (value: number): value is Grade => [1, 2, 3, 4, 5].includes(value);
