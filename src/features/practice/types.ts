export type { PracticeMode } from "../../../shared/types.ts";

export type PracticePhase = "dictating" | "reviewing" | "correcting" | "done";
export type CorrectionItem = {
  wordId: string;
  text: string;
  pinyin: string;
  mistakeCount: number;
  wrongChars: Array<{ char: string; mistakeCount: number }>;
};
export type PlaybackStage = "idle" | "first" | "waiting" | "second";
export type SpeechPlayback = { index: number | null; stage: PlaybackStage; countdown: number };

export const idleSpeechPlayback: SpeechPlayback = { index: null, stage: "idle", countdown: 0 };
