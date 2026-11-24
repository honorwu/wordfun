import type { PracticeItem } from "../../../shared/types.ts";

export type { PracticeMode } from "../../../shared/types.ts";

export const mistakeReviewLabels = { word: "曾写错", character: "错字复练" } as const;

export type PracticePhase = "dictating" | "reviewing" | "correcting" | "done";
export type CorrectionItem = {
  wordId: string;
  text: string;
  pinyin: string;
  mistakeReview?: PracticeItem["mistakeReview"];
  mistakeCount: number;
  wrongChars: Array<{ char: string; mistakeCount: number }>;
};
export type PlaybackStage = "idle" | "first" | "waiting" | "second";
export type SpeechPlayback = { index: number | null; stage: PlaybackStage; countdown: number };

export const idleSpeechPlayback: SpeechPlayback = { index: null, stage: "idle", countdown: 0 };
