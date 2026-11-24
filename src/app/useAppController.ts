import { useState } from "react";
import type { DictationWord, LessonSummary, WordIssueKind } from "../../shared/types.ts";
import { addMissedWrongChars, applyReviewResult } from "../../shared/domain/reviews.ts";
import type { MissedWrongCharCorrection } from "../../shared/domain/reviews.ts";
import { charReviewKey, fullDictationCharsForWord } from "../../shared/domain/characters.ts";
import { isWithinReviewCorrectionWindow } from "../../shared/domain/reviewPolicy.ts";
import { toggleWordIssue } from "../../shared/domain/wordIssues.ts";
import type { CorrectionItem, PracticeMode, PracticePhase } from "../features/practice/types";
import type { StudentViewProps } from "../features/practice/StudentView";
import type { ParentViewProps } from "../features/parent/ParentView";
import { lessonLabel } from "../lib/lessonPresentation";
import { useLearningData } from "./useLearningData";
import type { ViewMode } from "./types";

export function useAppController() {
  const [viewMode, setViewMode] = useState<ViewMode>("student");
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("lesson");
  const [roundId, setRoundId] = useState(0);
  const [phase, setPhase] = useState<PracticePhase>("dictating");
  const [wrongCharKeys, setWrongCharKeys] = useState<Set<string>>(() => new Set());
  const [pinyinShownWordIds, setPinyinShownWordIds] = useState<Set<string>>(() => new Set());
  const [correctionItems, setCorrectionItems] = useState<CorrectionItem[]>([]);
  const [savedMessage, setSavedMessage] = useState("");
  const [lastResult, setLastResult] = useState({ total: 0, wrongQuestions: 0, wrongChars: 0 });

  const {
    state, setState, allLessons, selectedLesson, practiceItems, practiceLoading, practiceError, practiceWaitingForSave,
    allKnownWords, parentState, questions, reviewCarryover, stats, parentReady, parentError, isReady, loadError, correctionSaving, saveCorrection,
    invalidateParentData, retryLoad,
  } = useLearningData({ viewMode, practiceMode, roundId, onSaveError: setSavedMessage });

  const resetPractice = (nextMode = practiceMode) => {
    setPracticeMode(nextMode);
    setRoundId((current) => current + 1);
    setPhase("dictating");
    setWrongCharKeys(new Set());
    setPinyinShownWordIds(new Set());
    setCorrectionItems([]);
    setLastResult({ total: 0, wrongQuestions: 0, wrongChars: 0 });
  };

  const setProgress = (lesson: LessonSummary) => {
    if (lesson.id === state.progress.lessonId) return;
    setState((current) => ({ ...current, progress: { grade: lesson.grade, lessonId: lesson.id } }));
    invalidateParentData();
    resetPractice();
  };

  const toggleWrongChar = (wordId: string, char: string) => {
    const key = charReviewKey(wordId, char);
    setWrongCharKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleIssue = (word: DictationWord, kind: WordIssueKind) => {
    const sourceLesson = allLessons.find((lesson) => lesson.id === word.lessonId);
    setState((current) => ({
      ...current,
      wordIssues: toggleWordIssue(current.wordIssues, word, sourceLesson ? lessonLabel(sourceLesson) : word.lessonTitle, kind),
    }));
  };

  const setIssueResolved = (id: string, resolved: boolean) => {
    setState((current) => ({
      ...current,
      wordIssues: current.wordIssues.map((issue) => issue.id === id ? { ...issue, resolvedAt: resolved ? new Date().toISOString() : undefined } : issue),
    }));
  };

  const finishDictation = () => {
    setPhase("reviewing");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveReview = () => {
    const reviewedLessons = practiceMode === "lesson"
      ? [{ id: selectedLesson.id, title: selectedLesson.title }]
      : Array.from(
          new Map(
            practiceItems.map((item) => {
              const sourceLesson = allLessons.find((lesson) => lesson.id === item.word.lessonId);
              return [item.word.lessonId, { id: item.word.lessonId, title: sourceLesson?.title ?? item.word.lessonTitle }];
            }),
          ).values(),
        );
    const nextState = applyReviewResult(state, practiceItems, wrongCharKeys, {
      practiceMode,
      lessons: reviewedLessons,
    });
    const nextCorrectionItems = practiceItems.flatMap(({ word, mistakeReview }) => {
      const wrongChars = fullDictationCharsForWord(word).filter((char) => wrongCharKeys.has(charReviewKey(word.id, char)));
      if (wrongChars.length === 0) return [];
      return [{
        wordId: word.id,
        text: word.text,
        pinyin: word.pinyin,
        textbookHint: word.textbookHint,
        mistakeReview,
        wrongChars,
        mistakeCount: nextState.wordStats[word.id].mistakes,
      }];
    });
    setState(nextState);
    invalidateParentData();
    setCorrectionItems(nextCorrectionItems);
    setLastResult({
      total: practiceItems.length,
      wrongQuestions: nextCorrectionItems.length,
      wrongChars: new Set(nextCorrectionItems.flatMap((item) => item.wrongChars)).size,
    });
    setWrongCharKeys(new Set());
    setPinyinShownWordIds(new Set());
    setPhase(nextCorrectionItems.length > 0 ? "correcting" : "done");
    setSavedMessage(nextCorrectionItems.length > 0 ? "批改完成，请完成订正" : "批改完成");
    window.setTimeout(() => setSavedMessage(""), 1800);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const supplementReviewMistakes = async (logId: string, corrections: MissedWrongCharCorrection[]) => {
    const previousLog = parentState.logs.find((log) => log.id === logId);
    if (!previousLog || !isWithinReviewCorrectionWindow(previousLog.date)) {
      throw new Error("只能补记完成后 3 天内的默写记录");
    }
    const nextState = addMissedWrongChars(parentState, logId, corrections, allKnownWords);
    const nextLog = nextState.logs.find((log) => log.id === logId);
    const previousKeys = new Set((previousLog?.wrongChars ?? []).map((item) => charReviewKey(item.wordId, item.char)));
    const requestedKeys = new Set(corrections.map((item) => charReviewKey(item.wordId, item.char)));
    const appliedKeys = new Set(
      (nextLog?.wrongChars ?? [])
        .map((item) => charReviewKey(item.wordId, item.char))
        .filter((key) => requestedKeys.has(key) && !previousKeys.has(key)),
    );
    if (!nextLog || appliedKeys.size === 0) {
      setSavedMessage("没有可写入的更正，请重新打开记录核对");
      window.setTimeout(() => setSavedMessage(""), 2200);
      return 0;
    }
    await saveCorrection({
      ...nextState,
      logs: [nextLog, ...state.logs.filter((log) => log.id !== logId)],
    });
    setSavedMessage(appliedKeys.size === requestedKeys.size
      ? `已在原默写记录中补记 ${appliedKeys.size} 处错字`
      : `已补记 ${appliedKeys.size} 处，另有 ${requestedKeys.size - appliedKeys.size} 处未写入，请刷新核对`);
    window.setTimeout(() => setSavedMessage(""), 2200);
    return appliedKeys.size;
  };

  return {
    viewMode, setViewMode, correctionSaving, savedMessage, loadError, isReady, selectedLesson, parentReady, parentError, retryLoad,
    studentProps: {
      items: practiceLoading || practiceError ? [] : practiceItems,
      loading: practiceLoading && !practiceError,
      loadError: practiceError,
      waitingForSave: practiceWaitingForSave,
      onRetry: retryLoad,
      correctionItems, pinyinShownWordIds, lastResult,
      lesson: selectedLesson,
      lessons: allLessons,
      mode: practiceMode,
      onFinish: finishDictation,
      onFinishCorrection: () => {
        setPhase("done");
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      onShowPinyin: (wordId) => setPinyinShownWordIds((current) => new Set(current).add(wordId)),
      onRestart: () => resetPractice(practiceMode),
      onSave: saveReview,
      onSelectLesson: setProgress,
      onSelectMode: (mode) => {
        if (mode !== practiceMode) resetPractice(mode);
      },
      onToggleWrong: toggleWrongChar,
      onToggleIssue: toggleIssue,
      phase, stats, wrongCharKeys,
      wordIssues: state.wordIssues,
    } satisfies StudentViewProps,
    parentProps: {
      questions,
      lessons: allLessons,
      onSupplementReviewMistakes: supplementReviewMistakes,
      onSetIssueResolved: setIssueResolved,
      reviewCarryover,
      selectedLesson,
      state: parentState,
      wordById: allKnownWords,
    } satisfies ParentViewProps,
  };
}
