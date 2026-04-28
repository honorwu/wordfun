import type { AppState, CharacterCategory, DictationWord, Grade, Lesson, Progress } from "../types";

const fallbackProgress: Progress = {
  grade: 3,
  lessonId: "",
};

export const createDefaultState = (progress: Progress = fallbackProgress): AppState => ({
  progress,
  wordStats: {},
  charStats: {},
  customLessons: [],
  customWords: [],
  logs: [],
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

export const normalizeState = (state: Partial<AppState>, fallback = fallbackProgress): AppState => {
  const base = createDefaultState(fallback);
  return {
    ...base,
    ...state,
    progress: state.progress ?? base.progress,
    customLessons: (state.customLessons ?? []).map(normalizeLesson),
    customWords: (state.customWords ?? []).map(normalizeWord),
    wordStats: state.wordStats ?? {},
    charStats: state.charStats ?? {},
    logs: state.logs ?? [],
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
