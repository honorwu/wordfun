import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SubmitReviewRequest, ToggleWordIssueRequest } from "../../shared/contracts.ts";
import type { AppState, DictationWord, LessonSummary, PracticeData, PracticeMode, Progress, QuestionCarryover, ReviewActivity, ReviewLog } from "../../shared/types.ts";
import { lessonOrder } from "../../shared/domain/catalog.ts";
import { createDefaultState } from "../../shared/domain/state.ts";
import { toggleWordIssue as applyToggleWordIssue } from "../../shared/domain/wordIssues.ts";
import {
  fetchAppData, fetchParentData, fetchPractice, resolveRemoteWordIssue,
  submitRemoteReview, supplementRemoteReview, toggleRemoteWordIssue, updateRemoteProgress,
} from "../lib/api";
import { localDateKey } from "../lib/dates";
import type { ViewMode } from "./types";

// 管理远程数据的生命周期；所有写入通过服务端增量意图接口顺序执行。
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
  const [pendingSaves, setPendingSaves] = useState(0);
  const [saveFailure, setSaveFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [todayKey, setTodayKey] = useState(() => localDateKey(new Date()));

  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const correctionSavingRef = useRef(false);
  const practiceData = practiceRound?.id === roundId ? practiceRound.data : null;
  const needsSave = pendingSaves > 0 || saveFailure !== null;

  const enqueueMutation = useCallback((run: () => Promise<void>, errorPrefix: string) => {
    setPendingSaves((count) => count + 1);
    const task = mutationQueueRef.current.catch(() => undefined).then(async () => {
      try {
        await run();
        setSaveFailure(null);
      } catch (error: unknown) {
        const message = error instanceof Error ? `${errorPrefix}：${error.message}` : errorPrefix;
        setSaveFailure({
          message,
          retry: () => {
            setSaveFailure(null);
            void enqueueMutation(run, errorPrefix);
          },
        });
        onSaveError(message);
      } finally {
        setPendingSaves((count) => Math.max(0, count - 1));
      }
    });
    mutationQueueRef.current = task;
    return task;
  }, [onSaveError]);

  useEffect(() => {
    let active = true;
    fetchAppData()
      .then((data) => {
        if (!active) return;
        setLessons(data.lessons);
        setPracticeRound({ id: 0, data: data.practice });
        setReviewActivity(data.activity);
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

  const updateProgress = useCallback((progress: Progress) => {
    setState((current) => ({ ...current, progress }));
    void enqueueMutation(async () => {
      const response = await updateRemoteProgress(progress);
      setState((current) => ({ ...current, progress: response.progress }));
    }, "课次进度保存失败");
  }, [enqueueMutation]);

  const submitReview = useCallback((payload: SubmitReviewRequest) => {
    void enqueueMutation(async () => {
      const response = await submitRemoteReview(payload);
      setState((current) => ({
        ...current,
        wordStats: { ...current.wordStats, ...response.wordStats },
        charStats: { ...current.charStats, ...response.charStats },
        logs: [response.log, ...current.logs.filter((log) => log.id !== response.log.id)],
      }));
      setReviewActivity((current) => [
        { id: response.log.id, date: response.log.date, count: response.log.wordIds.length },
        ...current.filter((item) => item.id !== response.log.id),
      ]);
      setParentReady(false);
    }, "学习记录保存失败");
  }, [enqueueMutation]);

  const saveCorrection = useCallback(async (logId: string, corrections: Array<{ wordId: string; char: string }>) => {
    if (correctionSavingRef.current) throw new Error("正在保存补记，请稍候");
    correctionSavingRef.current = true;
    setCorrectionSaving(true);
    try {
      await mutationQueueRef.current.catch(() => undefined);
      const response = await supplementRemoteReview(logId, corrections);
      if (response.appliedCount > 0) {
        setState((current) => ({
          ...current,
          wordStats: { ...current.wordStats, ...response.wordStats },
          charStats: { ...current.charStats, ...response.charStats },
          logs: [response.log, ...current.logs.filter((log) => log.id !== response.log.id)],
        }));
        setHistoricalLogs((current) => current.map((log) => (log.id === response.log.id ? response.log : log)));
      }
      return response.appliedCount;
    } finally {
      correctionSavingRef.current = false;
      setCorrectionSaving(false);
    }
  }, []);

  const toggleIssue = useCallback((payload: ToggleWordIssueRequest) => {
    setState((current) => ({
      ...current,
      wordIssues: applyToggleWordIssue(current.wordIssues, payload.word, payload.lessonLabel, payload.kind),
    }));
    void enqueueMutation(async () => {
      const response = await toggleRemoteWordIssue(payload);
      setState((current) => ({ ...current, wordIssues: response.wordIssues }));
    }, "词库问题标记保存失败");
  }, [enqueueMutation]);

  const resolveIssue = useCallback((issueId: string, resolved: boolean) => {
    setState((current) => ({
      ...current,
      wordIssues: current.wordIssues.map((issue) =>
        issue.id === issueId ? { ...issue, resolvedAt: resolved ? new Date().toISOString() : undefined } : issue,
      ),
    }));
    void enqueueMutation(async () => {
      const response = await resolveRemoteWordIssue(issueId, resolved);
      setState((current) => ({ ...current, wordIssues: response.wordIssues }));
    }, "词库问题状态保存失败");
  }, [enqueueMutation]);

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

  const allLessons = useMemo(() => [...lessons].sort((a, b) => lessonOrder(a) - lessonOrder(b)), [lessons]);
  const selectedSummary = allLessons.find((lesson) => lesson.id === state.progress.lessonId) ?? allLessons[0];
  const selectedLesson = practiceData?.lesson ?? selectedSummary;
  const practiceItems = practiceData?.items ?? [];
  const saveError = saveFailure?.message ?? "";
  const fetchError = practiceFailure?.roundId === roundId && practiceFailure.retryCount === retryCount ? practiceFailure.message : "";
  const practiceError = practiceData ? "" : saveFailure ? saveError : fetchError;
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
  const stats = useMemo(() => {
    const activity = new Map(reviewActivity.map((item) => [item.id, item]));
    for (const log of state.logs) activity.set(log.id, { id: log.id, date: log.date, count: log.wordIds.length });
    let todayCount = 0;
    for (const item of activity.values()) {
      if (localDateKey(new Date(item.date)) === todayKey) todayCount += item.count;
    }
    return { ...(practiceData?.stats ?? { historyTotal: 0, historyReviewed: 0, historyUnreviewed: 0, pendingMistakes: 0, waitingReview: 0 }), todayCount };
  }, [practiceData, reviewActivity, state.logs, todayKey]);

  const retryLoad = useCallback(() => {
    if (saveFailure) {
      saveFailure.retry();
      return;
    }
    setRetryCount((count) => count + 1);
  }, [saveFailure]);

  return {
    state, updateProgress, submitReview, saveCorrection, toggleIssue, resolveIssue,
    allLessons, selectedLesson, practiceItems, practiceLoading, practiceWaitingForSave, practiceError,
    allKnownWords, parentState, questions, reviewCarryover, stats, parentReady, parentError, isReady, loadError, correctionSaving,
    invalidateParentData: () => setParentReady(false),
    retryLoad,
  };
}
