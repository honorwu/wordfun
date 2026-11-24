import { useState } from "react";
import type { DictationWord, LessonSummary, WordIssueKind } from "../../shared/types.ts";
import { addMissedWrongChars, applyReviewResult } from "../../shared/domain/reviews.ts";
import type { MissedWrongCharCorrection } from "../../shared/domain/reviews.ts";
import { charReviewKey, fullDictationCharsForWord, reviewCharsForWord } from "../../shared/domain/characters.ts";
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
  const [phase, setPhase] = useState<PracticePhase>("dictating");
  const [wrongCharKeys, setWrongCharKeys] = useState<Set<string>>(() => new Set());
  const [hintedWordIds, setHintedWordIds] = useState<Set<string>>(() => new Set());
  const [correctionItems, setCorrectionItems] = useState<CorrectionItem[]>([]);
  const [savedMessage, setSavedMessage] = useState("");
  const [lastResult, setLastResult] = useState({ total: 0, wrongQuestions: 0, wrongChars: 0 });

  const {
    state, setState, allLessons, selectedLesson, practiceItems, practiceLoading, practiceError,
    allKnownWords, parentState, questions, reviewCarryover, inheritedMasteredChars, stats, parentReady, parentError, isReady, loadError,
    invalidateParentData, retryLoad,
  } = useLearningData({ viewMode, practiceMode, onSaveError: setSavedMessage });

  const resetPractice = (nextMode = practiceMode) => {
    setPracticeMode(nextMode);
    setPhase("dictating");
    setWrongCharKeys(new Set());
    setHintedWordIds(new Set());
    setCorrectionItems([]);
    setLastResult({ total: 0, wrongQuestions: 0, wrongChars: 0 });
  };

  const setProgress = (lesson: LessonSummary) => {
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
    const reviewedCharsByWord = new Map(
      practiceItems.map((item) => {
        if (practiceMode === "history") return [item.word.id, fullDictationCharsForWord(item.word)] as const;
        const baseReviewChars = hintedWordIds.has(item.word.id)
          ? reviewCharsForWord(item.word)
          : fullDictationCharsForWord(item.word);
        const explicitlyWrongChars = fullDictationCharsForWord(item.word).filter((char) =>
          wrongCharKeys.has(charReviewKey(item.word.id, char)),
        );
        return [item.word.id, Array.from(new Set([...baseReviewChars, ...explicitlyWrongChars]))] as const;
      }),
    );
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
    const nextState = applyReviewResult(state, practiceItems, wrongCharKeys, reviewedCharsByWord, {
      practiceMode,
      lessons: reviewedLessons,
    });
    const nextCorrectionItems = practiceItems.flatMap(({ word, mistakeReview }) => {
      const wrongChars = (reviewedCharsByWord.get(word.id) ?? [])
        .filter((char) => wrongCharKeys.has(charReviewKey(word.id, char)))
        .map((char) => ({ char, mistakeCount: nextState.charStats[char]?.mistakes ?? 1 }));
      if (wrongChars.length === 0) return [];
      return [{ wordId: word.id, text: word.text, pinyin: word.pinyin, mistakeReview, wrongChars, mistakeCount: nextState.wordStats[word.id].mistakes }];
    });
    setState(nextState);
    invalidateParentData();
    setCorrectionItems(nextCorrectionItems);
    setLastResult({
      total: practiceItems.length,
      wrongQuestions: nextCorrectionItems.length,
      wrongChars: new Set(nextCorrectionItems.flatMap((item) => item.wrongChars.map(({ char }) => char))).size,
    });
    setWrongCharKeys(new Set());
    setHintedWordIds(new Set());
    setPhase(nextCorrectionItems.length > 0 ? "correcting" : "done");
    setSavedMessage(nextCorrectionItems.length > 0 ? "批改结果已记录，请完成订正" : "批改结果已记录");
    window.setTimeout(() => setSavedMessage(""), 1800);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const supplementReviewMistakes = (logId: string, corrections: MissedWrongCharCorrection[]) => {
    const previousLog = parentState.logs.find((log) => log.id === logId);
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
    setState((current) => ({
      ...nextState,
      logs: [nextLog, ...current.logs.filter((log) => log.id !== logId)],
    }));
    setSavedMessage(appliedKeys.size === requestedKeys.size
      ? `已在原默写记录中补记 ${appliedKeys.size} 处错字`
      : `已补记 ${appliedKeys.size} 处，另有 ${requestedKeys.size - appliedKeys.size} 处未写入，请刷新核对`);
    window.setTimeout(() => setSavedMessage(""), 2200);
    return appliedKeys.size;
  };

  return {
    viewMode, setViewMode, savedMessage, loadError, isReady, selectedLesson, parentReady, parentError, retryLoad,
    studentProps: {
      items: practiceLoading || practiceError ? [] : practiceItems,
      loading: practiceLoading && !practiceError,
      loadError: practiceError,
      onRetry: retryLoad,
      correctionItems, hintedWordIds, lastResult,
      lesson: selectedLesson,
      lessons: allLessons,
      mode: practiceMode,
      onFinish: finishDictation,
      onFinishCorrection: () => {
        setPhase("done");
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      onRevealHint: (wordId) => setHintedWordIds((current) => new Set(current).add(wordId)),
      onRestart: () => resetPractice(practiceMode),
      onSave: saveReview,
      onSelectLesson: setProgress,
      onSelectMode: (mode) => resetPractice(mode),
      onToggleWrong: toggleWrongChar,
      onToggleIssue: toggleIssue,
      phase, stats, wrongCharKeys,
      wordIssues: state.wordIssues,
    } satisfies StudentViewProps,
    parentProps: {
      inheritedMasteredChars,
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
