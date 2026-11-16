import type { AppState, DictationWord, LessonSummary, PracticeData, Progress, ReviewActivity, ReviewLog } from "../types";
import { normalizeState } from "./storage";

export interface AppData {
  lessons: LessonSummary[];
  state: AppState;
  activity: ReviewActivity[];
  practice: PracticeData;
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

const fallbackProgress = (lessons: LessonSummary[]): Progress => {
  const lesson = lessons.find((item) => item.grade === 3) ?? lessons[0];
  return {
    grade: lesson?.grade ?? 3,
    lessonId: lesson?.id ?? "",
  };
};

let appDataRequest: Promise<AppData> | undefined;

export const fetchAppData = (): Promise<AppData> => {
  // 合并开发模式 StrictMode 同时发起的启动请求；完成后不缓存学习状态。
  appDataRequest ??= requestJson<Omit<AppData, "state"> & { state: Partial<AppState> }>("/api/app-data")
    .then((data) => ({ ...data, state: normalizeState(data.state, fallbackProgress(data.lessons)) }))
    .finally(() => { appDataRequest = undefined; });
  return appDataRequest;
};

export const fetchPractice = (progress: Progress, charStats: AppState["charStats"], mode: PracticeData["mode"], signal: AbortSignal) =>
  requestJson<PracticeData>("/api/practice", { method: "POST", body: JSON.stringify({ progress, charStats, mode }), signal });

export const fetchParentData = (state: AppState, signal: AbortSignal) =>
  requestJson<{ logs: ReviewLog[]; words: DictationWord[] }>("/api/parent-data", {
    method: "POST",
    body: JSON.stringify({ progress: state.progress, wordIds: state.logs.flatMap((log) => log.wordIds) }),
    signal,
  });

export const saveRemoteState = async (state: AppState) => {
  await requestJson<{ ok: true }>("/api/state", {
    method: "PUT",
    body: JSON.stringify({ ...state, mergeLogs: true }),
  });
};
