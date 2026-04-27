import { builtInLessons } from "../data/builtInCurriculum";
import type { AppState, CharacterCategory, DictationWord, Grade, Lesson, Progress } from "../types";

const STORAGE_KEY = "ziqu-state-v2";

const defaultProgress: Progress = {
  grade: 3,
  lessonId: builtInLessons.find((lesson) => lesson.grade === 3)?.id ?? builtInLessons[0].id,
};

export const createDefaultState = (): AppState => ({
  progress: defaultProgress,
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

export const loadState = (): AppState => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createDefaultState();
    }

    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...createDefaultState(),
      ...parsed,
      customLessons: (parsed.customLessons ?? []).map(normalizeLesson),
      customWords: (parsed.customWords ?? []).map(normalizeWord),
    };
  } catch {
    return createDefaultState();
  }
};

export const saveState = (state: AppState) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
