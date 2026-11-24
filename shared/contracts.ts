import type { AppState, DictationWord, LessonSummary, PracticeData, PracticeMode, Progress, QuestionCarryover, ReviewActivity, ReviewLog } from "./types.ts";

// HTTP 数据契约。完整词库只留在后端，浏览器按页面请求所需的数据。
export interface AppDataResponse {
  lessons: LessonSummary[];
  state: Partial<AppState>;
  activity: ReviewActivity[];
  practice: PracticeData;
}

export interface PracticeRequest {
  progress: Progress;
  wordStats: AppState["wordStats"];
  mode: PracticeMode;
}

export type PracticeResponse = PracticeData;

export interface ParentDataResponse {
  logs: ReviewLog[];
  questions: DictationWord[];
  reviewCarryover: Record<string, QuestionCarryover>;
  inheritedMasteredChars: string[];
}

export type SaveStateRequest = AppState & { mergeLogs?: boolean };
export interface SaveStateResponse { ok: true }
