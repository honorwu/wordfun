import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeItem } from "../../../shared/types.ts";
import type { PracticePhase, SpeechPlayback } from "./types";
import { idleSpeechPlayback } from "./types";

const secondPlaybackDelaySeconds = 10;

export function useSpeechPlayback({ items, isPoetryMode, phase, onActivate }: {
  items: PracticeItem[];
  isPoetryMode: boolean;
  phase: PracticePhase;
  onActivate: (index: number) => void;
}) {
  const [speechPlayback, setSpeechPlayback] = useState<SpeechPlayback>(idleSpeechPlayback);
  const speechRequestRef = useRef(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const repeatTimeoutRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const speechSafetyTimeoutRef = useRef<number | null>(null);

  const clearSpeechTimers = useCallback(() => {
    if (repeatTimeoutRef.current !== null) window.clearTimeout(repeatTimeoutRef.current);
    if (countdownIntervalRef.current !== null) window.clearInterval(countdownIntervalRef.current);
    if (speechSafetyTimeoutRef.current !== null) window.clearTimeout(speechSafetyTimeoutRef.current);
    repeatTimeoutRef.current = null;
    countdownIntervalRef.current = null;
    speechSafetyTimeoutRef.current = null;
  }, []);

  const stopPlayback = useCallback(() => {
    speechRequestRef.current += 1;
    clearSpeechTimers();
    utteranceRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeechPlayback(idleSpeechPlayback);
  }, [clearSpeechTimers]);

  const startDoublePlayback = useCallback(async (itemIndex: number) => {
    const item = items[itemIndex];
    if (!item || isPoetryMode || phase !== "dictating") return;
    if (speechPlayback.index === itemIndex && speechPlayback.stage !== "idle") {
      stopPlayback();
      return;
    }

    stopPlayback();
    const requestId = speechRequestRef.current + 1;
    speechRequestRef.current = requestId;
    onActivate(itemIndex);
    setSpeechPlayback({ index: itemIndex, stage: "first", countdown: 0 });

    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setSpeechPlayback(idleSpeechPlayback);
      return;
    }

    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          window.clearTimeout(timeout);
          window.speechSynthesis.removeEventListener("voiceschanged", finish);
          resolve();
        };
        const timeout = window.setTimeout(finish, 450);
        window.speechSynthesis.addEventListener("voiceschanged", finish);
      });
      voices = window.speechSynthesis.getVoices();
    }
    if (speechRequestRef.current !== requestId) return;

    const mainlandVoices = voices.filter((voice) => voice.lang.replace("_", "-").toLowerCase() === "zh-cn");
    const preferredVoice = mainlandVoices.find((voice) => /natural|premium|enhanced|tingting|ting-ting|xiaoxiao|yunxi|普通话/iu.test(voice.name)) ?? mainlandVoices[0];
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    if (speechRequestRef.current !== requestId) return;

    const speakPass = (pass: 1 | 2) => {
      if (speechRequestRef.current !== requestId) return;
      let settled = false;
      const utterance = new SpeechSynthesisUtterance(item.word.text);
      utterance.lang = "zh-CN";
      if (preferredVoice) utterance.voice = preferredVoice;
      utterance.rate = 0.82;
      utterance.pitch = 1;

      const settlePass = (completed: boolean) => {
        if (settled) return;
        settled = true;
        if (speechSafetyTimeoutRef.current !== null) window.clearTimeout(speechSafetyTimeoutRef.current);
        speechSafetyTimeoutRef.current = null;
        if (speechRequestRef.current !== requestId || utteranceRef.current !== utterance) return;
        utteranceRef.current = null;

        if (!completed || pass === 2) {
          setSpeechPlayback(idleSpeechPlayback);
          return;
        }

        let remaining = secondPlaybackDelaySeconds;
        setSpeechPlayback({ index: itemIndex, stage: "waiting", countdown: remaining });
        countdownIntervalRef.current = window.setInterval(() => {
          if (speechRequestRef.current !== requestId) return;
          remaining -= 1;
          if (remaining > 0) setSpeechPlayback({ index: itemIndex, stage: "waiting", countdown: remaining });
        }, 1000);
        repeatTimeoutRef.current = window.setTimeout(() => {
          if (countdownIntervalRef.current !== null) window.clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
          repeatTimeoutRef.current = null;
          speakPass(2);
        }, secondPlaybackDelaySeconds * 1000);
      };

      utterance.onend = () => settlePass(true);
      utterance.onerror = () => settlePass(false);
      utteranceRef.current = utterance;
      setSpeechPlayback({ index: itemIndex, stage: pass === 1 ? "first" : "second", countdown: 0 });
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        settlePass(false);
        return;
      }
      speechSafetyTimeoutRef.current = window.setTimeout(() => {
        if (speechRequestRef.current !== requestId || settled) return;
        settlePass(false);
        window.speechSynthesis.cancel();
      }, 20_000);
    };

    speakPass(1);
  }, [isPoetryMode, items, phase, speechPlayback.index, speechPlayback.stage, stopPlayback, onActivate]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) stopPlayback();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [stopPlayback]);

  useEffect(() => () => {
    speechRequestRef.current += 1;
    clearSpeechTimers();
    utteranceRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [clearSpeechTimers]);

  return { speechPlayback, stopPlayback, startDoublePlayback };
}
