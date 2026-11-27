import { useState } from "react";
import type { DictationWord, LessonSummary, WordIssueKind } from "../../shared/types.ts";
import type { MissedWrongCharCorrection } from "../../shared/domain/reviews.ts";
import { charReviewKey, fullDictationCharsForWord } from "../../shared/domain/characters.ts";
import { canSupplementReview } from "../../shared/domain/reviewPolicy.ts";
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
    state, updateProgress, submitReview, saveCorrection, toggleIssue: toggleRemoteIssue, resolveIssue,
    allLessons, selectedLesson, practiceItems, practiceLoading, practiceError, practiceWaitingForSave,
    allKnownWords, parentState, questions, reviewCarryover, stats, parentReady, parentError, isReady, loadError, correctionSaving,
    invalidateParentData, retryLoad,
  } = useLearningData({ viewMode, practiceMode, roundId, onSaveError: setSavedMessage });

  const confirmLeaveActivePhase = () => {
    if (phase === "reviewing") {
      return window.confirm("当前正在批改，切换后本轮未提交的批改结果将清空，确定要切换吗？");
    }
    if (phase === "correcting") {
      return window.confirm("当前还未完成订正，确定要离开本轮订正吗？");
    }
    return true;
  };

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
    if (!confirmLeaveActivePhase()) return;
    updateProgress({ grade: lesson.grade, lessonId: lesson.id });
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
    toggleRemoteIssue({
      word,
      lessonLabel: sourceLesson ? lessonLabel(sourceLesson) : word.lessonTitle,
      kind,
    });
  };

  const setIssueResolved = (id: string, resolved: boolean) => {
    resolveIssue(id, resolved);
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
    const wrongChars = practiceItems.flatMap(({ word }) =>
      fullDictationCharsForWord(word)
        .filter((char) => wrongCharKeys.has(charReviewKey(word.id, char)))
        .map((char) => ({ wordId: word.id, char })),
    );
    const nextCorrectionItems = practiceItems.flatMap(({ word, mistakeReview }) => {
      const itemWrongChars = fullDictationCharsForWord(word).filter((char) => wrongCharKeys.has(charReviewKey(word.id, char)));
      if (itemWrongChars.length === 0) return [];
      const previousMistakes = state.wordStats[word.id]?.mistakes ?? 0;
      return [{
        wordId: word.id,
        text: word.text,
        pinyin: word.pinyin,
        textbookHint: word.textbookHint,
        mistakeReview,
        wrongChars: itemWrongChars,
        mistakeCount: previousMistakes + 1,
      }];
    });
    submitReview({
      practiceMode,
      lessons: reviewedLessons,
      wordIds: practiceItems.map(({ word }) => word.id),
      wrongChars,
    });
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
    if (!previousLog || !canSupplementReview(previousLog)) {
      throw new Error("只能补记完成后 3 天内的默写记录");
    }
    const requestedKeys = new Set(corrections.map((item) => charReviewKey(item.wordId, item.char)));
    const appliedCount = await saveCorrection(logId, corrections);
    if (appliedCount === 0) {
      setSavedMessage("没有可写入的更正，请重新打开记录核对");
      window.setTimeout(() => setSavedMessage(""), 2200);
      return 0;
    }
    setSavedMessage(appliedCount === requestedKeys.size
      ? `已在原默写记录中补记 ${appliedCount} 处错字`
      : `已补记 ${appliedCount} 处，另有 ${requestedKeys.size - appliedCount} 处未写入，请刷新核对`);
    window.setTimeout(() => setSavedMessage(""), 2200);
    return appliedCount;
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
        if (mode !== practiceMode && confirmLeaveActivePhase()) resetPractice(mode);
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
