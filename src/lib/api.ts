import type {
  AppDataResponse, ParentDataResponse, PracticeRequest, PracticeResponse,
  ResolveWordIssueRequest, SaveStateRequest, SaveStateResponse,
  SubmitReviewRequest, SubmitReviewResponse, SupplementReviewRequest, SupplementReviewResponse,
  ToggleWordIssueRequest, UpdateProgressRequest, UpdateProgressResponse, WordIssuesResponse,
} from "../../shared/contracts.ts";
import type { AppState, LessonSummary, PracticeMode, Progress } from "../../shared/types.ts";
import { normalizeState } from "../../shared/domain/state.ts";

export type AppData = Omit<AppDataResponse, "state"> & { state: AppState };

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
  appDataRequest ??= requestJson<AppDataResponse>("/api/app-data")
    .then((data) => ({ ...data, state: normalizeState(data.state, fallbackProgress(data.lessons)) }))
    .finally(() => { appDataRequest = undefined; });
  return appDataRequest;
};

export const fetchPractice = (progress: Progress, mode: PracticeMode, signal: AbortSignal) =>
  requestJson<PracticeResponse>("/api/practice", { method: "POST", body: JSON.stringify({ progress, mode } satisfies PracticeRequest), signal });

export const fetchParentData = (signal: AbortSignal) =>
  requestJson<ParentDataResponse>("/api/parent-data", { method: "POST", signal });

export const updateRemoteProgress = (progress: Progress) =>
  requestJson<UpdateProgressResponse>("/api/progress", {
    method: "PUT",
    body: JSON.stringify({ progress } satisfies UpdateProgressRequest),
  });

export const submitRemoteReview = (payload: SubmitReviewRequest) =>
  requestJson<SubmitReviewResponse>("/api/reviews", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const supplementRemoteReview = (logId: string, corrections: SupplementReviewRequest["corrections"]) =>
  requestJson<SupplementReviewResponse>(`/api/reviews/${encodeURIComponent(logId)}/corrections`, {
    method: "POST",
    body: JSON.stringify({ corrections } satisfies SupplementReviewRequest),
  });

export const toggleRemoteWordIssue = (payload: ToggleWordIssueRequest) =>
  requestJson<WordIssuesResponse>("/api/word-issues/toggle", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const resolveRemoteWordIssue = (issueId: string, resolved: boolean) =>
  requestJson<WordIssuesResponse>(`/api/word-issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    body: JSON.stringify({ resolved } satisfies ResolveWordIssueRequest),
  });

export const saveRemoteState = async (state: SaveStateRequest) => {
  await requestJson<SaveStateResponse>("/api/state", {
    method: "PUT",
    body: JSON.stringify(state),
  });
};
