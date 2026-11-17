export type { PracticeMode } from "../../../shared/types.ts";

export type PracticePhase = "dictating" | "reviewing" | "correcting" | "done";
export type CorrectionMistake = { char: string; mistakeCount: number; repetitions: number };
export type CorrectionItem = { wordId: string; text: string; pinyin: string; wrongChars: CorrectionMistake[] };
export type PlaybackStage = "idle" | "first" | "waiting" | "second";
export type SpeechPlayback = { index: number | null; stage: PlaybackStage; countdown: number };

export const idleSpeechPlayback: SpeechPlayback = { index: null, stage: "idle", countdown: 0 };
