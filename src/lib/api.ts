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
    let message = text;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === "string") message = payload.error;
    } catch {
      // 非 JSON 错误沿用服务器返回的原文。
    }
    throw new Error(message || `请求失败（${response.status}）`);
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
