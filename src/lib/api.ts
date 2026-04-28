import type { AppState, CompanionDictionary, Lesson, Progress } from "../types";
import { normalizeState } from "./storage";

export interface AppData {
  lessons: Lesson[];
  companionWords: CompanionDictionary;
  state: AppState;
  builtInLessonCount: number;
  builtInWordCount: number;
}

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
};

const fallbackProgress = (lessons: Lesson[]): Progress => {
  const lesson = lessons.find((item) => item.grade === 3) ?? lessons[0];
  return {
    grade: lesson?.grade ?? 3,
    lessonId: lesson?.id ?? "",
  };
};

export const fetchAppData = async (): Promise<AppData> => {
  const data = await requestJson<Omit<AppData, "state"> & { state: Partial<AppState> }>("/api/app-data");
  return {
    ...data,
    state: normalizeState(data.state, fallbackProgress(data.lessons)),
  };
};

export const saveRemoteState = async (state: AppState) => {
  await requestJson<{ ok: true }>("/api/state", {
    method: "PUT",
    body: JSON.stringify(state),
  });
};
