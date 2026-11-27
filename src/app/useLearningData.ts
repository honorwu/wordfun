import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, DictationWord, LessonSummary, PracticeData, PracticeMode, QuestionCarryover, ReviewActivity, ReviewLog } from "../../shared/types.ts";
import { lessonOrder } from "../../shared/domain/catalog.ts";
import { createDefaultState } from "../../shared/domain/state.ts";
import { fetchAppData, fetchParentData, fetchPractice, saveRemoteState } from "../lib/api";
import { localDateKey } from "../lib/dates";
import type { ViewMode } from "./types";

// 管理远程数据的生命周期；练习阶段、批改草稿等页面状态由控制器维护。
export function useLearningData({ viewMode, practiceMode, roundId, onSaveError }: {
  viewMode: ViewMode;
  practiceMode: PracticeMode;
  roundId: number;
  onSaveError: (message: string) => void;
}) {
  const [state, setState] = useState<AppState>(() => createDefaultState());
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [practiceRound, setPracticeRound] = useState<{ id: number; data: PracticeData } | null>(null);
  const [reviewActivity, setReviewActivity] = useState<ReviewActivity[]>([]);
  const [practiceFailure, setPracticeFailure] = useState<{ roundId: number; retryCount: number; message: string } | null>(null);
  const [parentReady, setParentReady] = useState(false);
  const [parentError, setParentError] = useState("");
  const [questions, setQuestions] = useState<DictationWord[]>([]);
  const [historicalLogs, setHistoricalLogs] = useState<ReviewLog[]>([]);
  const [reviewCarryover, setReviewCarryover] = useState<Record<string, QuestionCarryover>>({});
  const [retryCount, setRetryCount] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savedState, setSavedState] = useState<AppState | null>(null);
  const [saveFailure, setSaveFailure] = useState<{ state: AppState; retryCount: number; message: string } | null>(null);
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [todayKey, setTodayKey] = useState(() => localDateKey(new Date()));

  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const savedStateRef = useRef<AppState | null>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const correctionSavingRef = useRef(false);
  const practiceData = practiceRound?.id === roundId ? practiceRound.data : null;
  const needsSave = state !== savedState;

  const queueSave = useCallback((snapshot: AppState) => {
    const task = saveQueueRef.current.catch(() => undefined).then(async () => {
      if (snapshot === savedStateRef.current) return;
      const savedLogs = new Map(savedStateRef.current?.logs.map((log) => [log.id, log]));
      const logs = snapshot.logs.filter((log) => savedLogs.get(log.id) !== log);
      await saveRemoteState({ ...snapshot, logs });
      savedStateRef.current = snapshot;
      setSavedState(snapshot);
      setSaveFailure(null);
    });
    saveQueueRef.current = task;
    return task;
  }, []);

  const saveImmediately = useCallback((snapshot: AppState) => {
    window.clearTimeout(saveTimerRef.current);
    void queueSave(snapshot).catch((error: unknown) => {
      const message = error instanceof Error ? `学习记录保存失败：${error.message}` : "学习记录保存失败";
      setSaveFailure({ state: snapshot, retryCount, message });
      onSaveError(message);
    });
  }, [queueSave, retryCount, onSaveError]);

  useEffect(() => {
    let active = true;
    fetchAppData()
      .then((data) => {
        if (!active) return;
        setLessons(data.lessons);
        setPracticeRound({ id: 0, data: data.practice });
        setReviewActivity(data.activity);
        savedStateRef.current = data.state;
        setSavedState(data.state);
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
    if (!isReady || correctionSaving || state === savedStateRef.current) return;
    const timeout = window.setTimeout(() => {
      void queueSave(state).catch((error: unknown) => {
        const message = error instanceof Error ? `学习记录保存失败：${error.message}` : "学习记录保存失败";
        setSaveFailure({ state, retryCount, message });
        onSaveError(message);
      });
    }, 250);
    saveTimerRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [isReady, state, retryCount, correctionSaving, queueSave, onSaveError]);

  const saveCorrection = async (updatedState: AppState) => {
    if (correctionSavingRef.current) throw new Error("正在保存补记，请稍候");
    correctionSavingRef.current = true;
    setCorrectionSaving(true);
    window.clearTimeout(saveTimerRef.current);
    try {
      // 先提交当前批改，补记成功后再把更正应用到界面。
      await queueSave(state);
      await queueSave(updatedState);
      setState(updatedState);
    } finally {
      correctionSavingRef.current = false;
      setCorrectionSaving(false);
    }
  };

  useEffect(() => {
    // 一轮已出题期间只保存学习记录。下一轮从 SQLite 中同一份已确认的状态取题。
    if (!isReady || practiceData || needsSave || correctionSaving) return;
    const controller = new AbortController();
    setPracticeFailure(null);
    fetchPractice(state.progress, practiceMode, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setPracticeRound({ id: roundId, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPracticeFailure({ roundId, retryCount, message: error instanceof Error ? error.message : "题目加载失败" });
      });
    return () => controller.abort();
  }, [isReady, practiceData, needsSave, correctionSaving, state.progress, practiceMode, roundId, retryCount]);

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
        setParentReady(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setParentError(error instanceof Error ? error.message : "学习记录加载失败");
      });
    return () => controller.abort();
  }, [isReady, viewMode, parentReady, retryCount]);

  const allLessons = useMemo(() => [...lessons].sort((a, b) => lessonOrder(a) - lessonOrder(b)), [lessons]);
  const selectedSummary = allLessons.find((lesson) => lesson.id === state.progress.lessonId) ?? allLessons[0];
  const selectedLesson = practiceData?.lesson ?? selectedSummary;
  const practiceItems = practiceData?.items ?? [];
  const saveError = saveFailure?.state === state && saveFailure.retryCount === retryCount ? saveFailure.message : "";
  const fetchError = practiceFailure?.roundId === roundId && practiceFailure.retryCount === retryCount ? practiceFailure.message : "";
  const practiceError = practiceData ? "" : needsSave ? saveError : fetchError;
  const practiceLoading = !practiceData && !practiceError;
  const practiceWaitingForSave = isReady && !practiceData && (needsSave || correctionSaving);
  const allKnownWords = useMemo(() => new Map([
    ...questions,
    ...practiceItems.map((item) => item.word),
  ].map((word) => [word.id, word])), [questions, practiceItems]);
  const parentState = useMemo(() => {
    const logs = new Map(historicalLogs.map((log) => [log.id, log]));
    for (const log of state.logs) logs.set(log.id, log);
    return { ...state, logs: [...logs.values()].sort((a, b) => b.date.localeCompare(a.date)) };
  }, [state, historicalLogs]);
  useEffect(() => {
    if (!needsSave && !correctionSaving) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [needsSave, correctionSaving]);

  useEffect(() => {
    const refreshToday = () => setTodayKey(localDateKey(new Date()));
    document.addEventListener("visibilitychange", refreshToday);
    window.addEventListener("focus", refreshToday);
    return () => {
      document.removeEventListener("visibilitychange", refreshToday);
      window.removeEventListener("focus", refreshToday);
    };
  }, []);

  const stats = useMemo(() => {
    const activity = new Map(reviewActivity.map((item) => [item.id, item]));
    for (const log of state.logs) activity.set(log.id, { id: log.id, date: log.date, count: log.wordIds.length });
    let todayCount = 0;
    for (const item of activity.values()) {
      if (localDateKey(new Date(item.date)) === todayKey) todayCount += item.count;
    }
    return { ...(practiceData?.stats ?? { historyTotal: 0, historyReviewed: 0, historyUnreviewed: 0, pendingMistakes: 0, waitingReview: 0 }), todayCount };
  }, [practiceData, reviewActivity, state.logs, todayKey]);

  return {
    state, setState, saveImmediately, allLessons, selectedLesson, practiceItems, practiceLoading, practiceWaitingForSave, practiceError,
    allKnownWords, parentState, questions, reviewCarryover, stats, parentReady, parentError, isReady, loadError, correctionSaving, saveCorrection,
    invalidateParentData: () => setParentReady(false),
    retryLoad: () => setRetryCount((count) => count + 1),
  };
}
