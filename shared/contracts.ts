import type { AppState, CharacterStat, DictationWord, LessonSummary, PracticeData, PracticeMode, Progress, QuestionCarryover, ReviewActivity, ReviewLog, WordIssue, WordIssueKind, WordStat } from "./types.ts";

// HTTP 数据契约。完整词库只留在后端，浏览器按页面请求所需的数据。
export interface AppDataResponse {
  lessons: LessonSummary[];
  state: Partial<AppState>;
  activity: ReviewActivity[];
  practice: PracticeData;
}

export interface PracticeRequest {
  progress: Progress;
  mode: PracticeMode;
}

export type PracticeResponse = PracticeData;

export interface ParentDataResponse {
  logs: ReviewLog[];
  questions: DictationWord[];
  reviewCarryover: Record<string, QuestionCarryover>;
}

export interface UpdateProgressRequest {
  progress: Progress;
}

export interface UpdateProgressResponse {
  progress: Progress;
}

export interface SubmitReviewRequest {
  practiceMode: PracticeMode;
  lessons: Array<{ id: string; title: string }>;
  wordIds: string[];
  wrongChars: Array<{ wordId: string; char: string }>;
}

export interface SubmitReviewResponse {
  log: ReviewLog;
  wordStats: Record<string, WordStat>;
  charStats: Record<string, CharacterStat>;
}

export interface SupplementReviewRequest {
  corrections: Array<{ wordId: string; char: string }>;
}

export interface SupplementReviewResponse {
  log: ReviewLog;
  appliedCount: number;
  wordStats: Record<string, WordStat>;
  charStats: Record<string, CharacterStat>;
}

export interface ToggleWordIssueRequest {
  word: DictationWord;
  lessonLabel: string;
  kind: WordIssueKind;
}

export interface ResolveWordIssueRequest {
  resolved: boolean;
}

export interface WordIssuesResponse {
  wordIssues: WordIssue[];
}

// 兼容旧客户端整包保存；新前端使用增量意图接口。
export type SaveStateRequest = AppState;
export interface SaveStateResponse { ok: true }
