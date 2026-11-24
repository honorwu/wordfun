import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, DictationWord, LessonSummary, PracticeData, PracticeMode, QuestionCarryover, ReviewActivity, ReviewLog } from "../../shared/types.ts";
import { lessonOrder } from "../../shared/domain/catalog.ts";
import { createDefaultState } from "../../shared/domain/state.ts";
import { fetchAppData, fetchParentData, fetchPractice, saveRemoteState } from "../lib/api";
import type { ViewMode } from "./types";

// 管理远程数据的生命周期；练习阶段、批改草稿等页面状态由控制器维护。
export function useLearningData({ viewMode, practiceMode, onSaveError }: {
  viewMode: ViewMode;
  practiceMode: PracticeMode;
  onSaveError: (message: string) => void;
}) {
  const [state, setState] = useState<AppState>(() => createDefaultState());
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [practiceData, setPracticeData] = useState<PracticeData | null>(null);
  const [reviewActivity, setReviewActivity] = useState<ReviewActivity[]>([]);
  const [isPracticeLoading, setIsPracticeLoading] = useState(false);
  const [practiceError, setPracticeError] = useState("");
  const [parentReady, setParentReady] = useState(false);
  const [parentError, setParentError] = useState("");
  const [questions, setQuestions] = useState<DictationWord[]>([]);
  const [historicalLogs, setHistoricalLogs] = useState<ReviewLog[]>([]);
  const [reviewCarryover, setReviewCarryover] = useState<Record<string, QuestionCarryover>>({});
  const [inheritedMasteredChars, setInheritedMasteredChars] = useState<string[]>([]);
  const [retryCount, setRetryCount] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState("");

  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const savedStateRef = useRef<AppState | null>(null);
  const practiceSourceRef = useRef<{ progress: AppState["progress"]; wordStats: AppState["wordStats"]; mode: PracticeMode } | null>(null);

  useEffect(() => {
    let active = true;
    fetchAppData()
      .then((data) => {
        if (!active) return;
        setLessons(data.lessons);
        setPracticeData(data.practice);
        setReviewActivity(data.activity);
        savedStateRef.current = data.state;
        practiceSourceRef.current = { progress: data.state.progress, wordStats: data.state.wordStats, mode: "lesson" };
        setState(data.state);
        setIsReady(true);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "词库加载失败");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isReady || state === savedStateRef.current) return;
    const timeout = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          // 以队列中最近一次写入成功的状态为准，未确认的场次随下一次保存重发。
          const savedLogs = new Map(savedStateRef.current?.logs.map((log) => [log.id, log]));
          const logs = state.logs.filter((log) => savedLogs.get(log.id) !== log);
          await saveRemoteState({ ...state, logs });
          savedStateRef.current = state;
        })
        .catch((error: unknown) => {
          onSaveError(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [isReady, state, onSaveError]);

  useEffect(() => {
    if (!isReady) return;
    const source = practiceSourceRef.current;
    if (source?.progress === state.progress && source.wordStats === state.wordStats && source.mode === practiceMode) {
      setIsPracticeLoading(false);
      setPracticeError("");
      return;
    }
    const controller = new AbortController();
    setIsPracticeLoading(true);
    setPracticeError("");
    fetchPractice(state.progress, state.wordStats, practiceMode, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        practiceSourceRef.current = { progress: state.progress, wordStats: state.wordStats, mode: practiceMode };
        setPracticeData(data);
        setIsPracticeLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPracticeError(error instanceof Error ? error.message : "题目加载失败");
        setIsPracticeLoading(false);
      });
    return () => controller.abort();
  }, [isReady, state.progress, state.wordStats, practiceMode, retryCount]);

  useEffect(() => {
    if (!isReady || viewMode !== "parent" || parentReady) return;
    const controller = new AbortController();
    setParentError("");
    fetchParentData(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setQuestions(data.questions);
        setHistoricalLogs(data.logs);
        setReviewCarryover(data.reviewCarryover ?? {});
        setInheritedMasteredChars(data.inheritedMasteredChars ?? []);
        setParentReady(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setParentError(error instanceof Error ? error.message : "学习记录加载失败");
      });
    return () => controller.abort();
  }, [isReady, viewMode, parentReady, retryCount]);

  const allLessons = useMemo(() => [...lessons].sort((a, b) => lessonOrder(a) - lessonOrder(b)), [lessons]);
  const selectedSummary = allLessons.find((lesson) => lesson.id === state.progress.lessonId) ?? allLessons[0];
  const selectedLesson = practiceData && practiceData.lesson.id === selectedSummary?.id ? practiceData.lesson : selectedSummary;
  const practiceItems = practiceData?.items ?? [];
  const practiceLoading = isPracticeLoading || practiceData?.lesson.id !== selectedSummary?.id || practiceData?.mode !== practiceMode;
  const allKnownWords = useMemo(() => new Map([
    ...questions,
    ...practiceItems.map((item) => item.word),
  ].map((word) => [word.id, word])), [questions, practiceItems]);
  const parentState = useMemo(() => {
    const logs = new Map(historicalLogs.map((log) => [log.id, log]));
    for (const log of state.logs) logs.set(log.id, log);
    return { ...state, logs: [...logs.values()].sort((a, b) => b.date.localeCompare(a.date)) };
  }, [state, historicalLogs]);
  const stats = useMemo(() => {
    const activity = new Map(reviewActivity.map((item) => [item.id, item]));
    for (const log of state.logs) activity.set(log.id, { id: log.id, date: log.date, count: log.wordIds.length });
    const today = new Date().toDateString();
    let todayCount = 0;
    for (const item of activity.values()) {
      if (new Date(item.date).toDateString() === today) todayCount += item.count;
    }
    return { ...(practiceData?.stats ?? { historyTotal: 0, historyReviewed: 0, historyInherited: 0, historyUnreviewed: 0, pendingMistakes: 0, waitingReview: 0 }), todayCount };
  }, [practiceData, reviewActivity, state.logs]);

  return {
    state, setState, allLessons, selectedLesson, practiceItems, practiceLoading, practiceError,
    allKnownWords, parentState, questions, reviewCarryover, inheritedMasteredChars, stats, parentReady, parentError, isReady, loadError,
    invalidateParentData: () => setParentReady(false),
    retryLoad: () => setRetryCount((count) => count + 1),
  };
}
