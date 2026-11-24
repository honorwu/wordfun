import { BookOpen, Check, ChevronRight, ClipboardCheck, History, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DictationWord, Grade, LessonSummary, PracticeItem, PracticeLesson, PracticeStats, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import type { PracticeMode, PracticePhase, CorrectionItem } from "./types";
import { fullDictationCharsForWord, historyMistakeCooldownDays, historyMistakeWordLimit } from "../../../shared/domain/index.ts";
import { findWordIssue } from "../../../shared/domain/wordIssues.ts";
import { gradeNames } from "../../data/metadata";
import { termLabel, lessonNumberLabel, shortBookLabel, availableGrades } from "../../lib/lessonPresentation";
import { createTextbookHintMask, maskLessonTitle } from "./titleMask";
import { CorrectionView } from "./CorrectionView";
import { PoetryCard } from "./PoetryCard";
import { DictationCard } from "./DictationCard";
import { useSpeechPlayback } from "./useSpeechPlayback";
import { idleSpeechPlayback } from "./types";

export interface StudentViewProps {
  loading: boolean;
  loadError: string;
  waitingForSave: boolean;
  onRetry: () => void;
  correctionItems: CorrectionItem[];
  pinyinShownWordIds: ReadonlySet<string>;
  items: PracticeItem[];
  lastResult: { total: number; wrongQuestions: number; wrongChars: number };
  lesson: PracticeLesson;
  lessons: LessonSummary[];
  mode: PracticeMode;
  onFinish: () => void;
  onFinishCorrection: () => void;
  onShowPinyin: (wordId: string) => void;
  onRestart: () => void;
  onSave: () => void;
  onSelectLesson: (lesson: LessonSummary) => void;
  onSelectMode: (mode: PracticeMode) => void;
  onToggleWrong: (wordId: string, char: string) => void;
  onToggleIssue: (word: DictationWord, kind: WordIssueKind) => void;
  phase: PracticePhase;
  stats: PracticeStats & { todayCount: number };
  wrongCharKeys: Set<string>;
  wordIssues: WordIssue[];
}

export function StudentView({
  loading,
  loadError,
  waitingForSave,
  onRetry,
  correctionItems,
  pinyinShownWordIds,
  items,
  lastResult,
  lesson,
  lessons,
  mode,
  onFinish,
  onFinishCorrection,
  onShowPinyin,
  onRestart,
  onSave,
  onSelectLesson,
  onSelectMode,
  onToggleWrong,
  onToggleIssue,
  phase,
  stats,
  wrongCharKeys,
  wordIssues,
}: StudentViewProps) {
  const [finishArmed, setFinishArmed] = useState(false);
  const [activeItemIndex, setActiveItemIndex] = useState(0);
  const mistakeWordCount = items.filter((item) => item.mistakeReview).length;
  const safeActiveItemIndex = Math.max(0, Math.min(activeItemIndex, Math.max(0, items.length - 1)));
  const isPoetryMode = mode === "lesson" && lesson.lessonKind === "classical_poetry";
  const { speechPlayback, stopPlayback, startDoublePlayback } = useSpeechPlayback({ items, isPoetryMode, phase, onActivate: setActiveItemIndex });
  const grades = availableGrades(lessons);
  const terms = Array.from(new Set(lessons.filter((item) => item.grade === lesson.grade).map((item) => item.unit))).sort();
  const scopedLessons = lessons.filter((item) => item.grade === lesson.grade && item.unit === lesson.unit);
  const bookLabelsByLesson = useMemo(() => new Map(lessons.map((item) => [item.id, shortBookLabel(item)])), [lessons]);
  const titleMaskWords = isPoetryMode
    ? (lesson.classicalTexts ?? []).map((poem) => ({ text: poem.title, pinyin: poem.titlePinyin }))
    : items.map((item) => item.word);
  const displayedLessonTitle = phase === "dictating" && mode === "lesson"
    ? maskLessonTitle(lesson.title, titleMaskWords)
    : lesson.title;
  const dictationLessonTitles = useMemo(() => {
    const wordsByLesson = new Map<string, DictationWord[]>();
    for (const item of items) {
      wordsByLesson.set(item.word.lessonId, [...(wordsByLesson.get(item.word.lessonId) ?? []), item.word]);
    }
    return new Map(
      [...wordsByLesson].map(([lessonId, lessonWords]) => [
        lessonId,
        maskLessonTitle(lessonWords[0].lessonTitle, lessonWords),
      ]),
    );
  }, [items]);
  const sentenceProtectedChars = useMemo(
    () => new Set(items.flatMap((item) => fullDictationCharsForWord(item.word))),
    [items],
  );
  const maskSentence = useMemo(
    () => createTextbookHintMask(items.map((item) => item.word), sentenceProtectedChars),
    [items, sentenceProtectedChars],
  );

  const pickFirstLesson = (grade: Grade, term?: number) => {
    const first = lessons.find((item) => item.grade === grade && (term ? item.unit === term : true));
    if (first) onSelectLesson(first);
  };

  useEffect(() => {
    stopPlayback();
    setActiveItemIndex(0);
    setFinishArmed(false);
  }, [items.length, lesson.id, mode, stopPlayback]);

  useEffect(() => {
    if (phase !== "dictating") {
      stopPlayback();
      return;
    }
    setActiveItemIndex(0);
  }, [phase, stopPlayback]);

  useEffect(() => {
    if (!finishArmed) return;
    const timeout = window.setTimeout(() => setFinishArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [finishArmed]);

  const activateItem = (nextIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
    if (clampedIndex !== safeActiveItemIndex) stopPlayback();
    setActiveItemIndex(clampedIndex);
  };

  const moveActiveItem = (direction: -1 | 1) => {
    const nextIndex = Math.max(0, Math.min(items.length - 1, safeActiveItemIndex + direction));
    if (nextIndex === safeActiveItemIndex) return;
    stopPlayback();
    setActiveItemIndex(nextIndex);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-item-index="${nextIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  const confirmFinish = () => {
    if (!finishArmed) {
      setFinishArmed(true);
      return;
    }
    stopPlayback();
    setFinishArmed(false);
    setActiveItemIndex(0);
    onFinish();
  };

  useEffect(() => {
    if (phase !== "dictating" || isPoetryMode || items.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea, [contenteditable='true']")) return;

      if (event.code === "Space") {
        if (event.repeat) return;
        event.preventDefault();
        void startDoublePlayback(safeActiveItemIndex);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        moveActiveItem(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPoetryMode, items.length, phase, safeActiveItemIndex, startDoublePlayback]);

  if (phase === "correcting") {
    return (
      <CorrectionView
        items={correctionItems}
        onFinish={onFinishCorrection}
      />
    );
  }

  if (phase === "done") {
    return (
      <section className="student-main">
        <div className="result-card">
          <span className="result-spark"><Sparkles size={34} /></span>
          <p className="eyebrow">默写完成</p>
          <h1>{lastResult.wrongQuestions === 0 ? "本轮默写完成" : "订正完成，继续加油"}</h1>
          <p>
            这次完成了 <strong>{lastResult.total}</strong> 道题，
            {lastResult.wrongQuestions === 0 ? "没有标记错字。" : <>共 <strong>{lastResult.wrongQuestions}</strong> 道错题，涉及 <strong>{lastResult.wrongChars}</strong> 个错字。</>}
          </p>
          <button className="primary-button large" type="button" onClick={onRestart}>
            {mode === "history" ? "继续往前复习" : "再默写一次"}<ChevronRight size={20} />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`student-main practice-mode-${mode}`}>
      <div className="lesson-banner">
        <div className="lesson-context">
          <p>当前课次 <strong>{gradeNames[lesson.grade]}{termLabel(lesson.unit)}</strong></p>
          <div className="today-pill">今天已默写 <strong>{stats.todayCount}</strong> 项</div>
        </div>
        <h1>{lessonNumberLabel(lesson, displayedLessonTitle)}</h1>
        <div className="student-lesson-picker" aria-label="选择当前课次">
          <label>
            <span>年级</span>
            <select value={lesson.grade} onChange={(event) => pickFirstLesson(Number(event.target.value) as Grade)}>
              {grades.map((grade) => <option key={grade} value={grade}>{gradeNames[grade]}</option>)}
            </select>
          </label>
          <label>
            <span>册别</span>
            <select value={lesson.unit} onChange={(event) => pickFirstLesson(lesson.grade, Number(event.target.value))}>
              {terms.map((term) => <option key={term} value={term}>{termLabel(term)}</option>)}
            </select>
          </label>
          <label className="student-lesson-field">
            <span>课次</span>
            <select value={lesson.id} onChange={(event) => {
              const nextLesson = lessons.find((item) => item.id === event.target.value);
              if (nextLesson) onSelectLesson(nextLesson);
            }}>
              {scopedLessons.map((item) => (
                <option key={item.id} value={item.id}>
                  {lessonNumberLabel(item, item.id === lesson.id ? displayedLessonTitle : item.title)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="practice-tabs" role="group" aria-label="复习方式">
        <button className="lesson-mode" aria-pressed={mode === "lesson"} type="button" onClick={() => onSelectMode("lesson")}>
          <span className="practice-tab-icon"><BookOpen size={18} aria-hidden="true" /></span>
          <span className="practice-tab-label"><strong>当课复习</strong><small>本课词语和生字</small></span>
          {mode === "lesson" && <Check className="practice-tab-check" size={16} aria-hidden="true" />}
        </button>
        <button className="history-mode" aria-pressed={mode === "history"} type="button" onClick={() => onSelectMode("history")}>
          <span className="practice-tab-icon"><History size={18} aria-hidden="true" /></span>
          <span className="practice-tab-label"><strong>历史复习</strong><small>最多 {historyMistakeWordLimit} 道错词</small></span>
          {mode === "history" && <Check className="practice-tab-check" size={16} aria-hidden="true" />}
        </button>
      </div>

      {mode === "history" && !loading && !loadError ? (
        <div className="history-progress">
          <div className="history-progress-label"><span>本课前整题已掌握</span><strong>{stats.historyReviewed} / {stats.historyTotal} 题</strong></div>
          <progress className="progress-track" value={stats.historyReviewed} max={Math.max(1, stats.historyTotal)} aria-label="本课之前的题目掌握进度" />
          <ul className="history-progress-details">
            <li>到期错题 <strong>{stats.pendingMistakes - stats.waitingReview}</strong></li>
            <li>等待复测 <strong>{stats.waitingReview}</strong></li>
            <li>待完成整题 <strong>{stats.historyUnreviewed}</strong></li>
          </ul>
        </div>
      ) : null}

      {loading || loadError ? (
        <div className="empty-card" role="status">
          <h2>{waitingForSave
            ? loadError ? "学习记录保存失败" : "正在保存学习记录"
            : loadError ? "题目加载失败" : "正在加载题目"}</h2>
          {loadError ? (
            <>
              <p>{loadError}</p>
              <button className="primary-button" type="button" onClick={onRetry}>{waitingForSave ? "重试保存" : "重新加载"}</button>
            </>
          ) : null}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-card">
          <Check size={34} />
          <h2>{mode === "history" ? stats.waitingReview > 0 ? "错题正在等待复测" : stats.historyTotal > 0 ? "本轮暂时没有复习题" : "前面还没有可复习的课" : isPoetryMode ? "这一课还没有古诗正文" : "这一课还没有可默写的词语"}</h2>
          <p>{mode === "history" ? stats.waitingReview > 0 ? `错题上次练过后满 ${historyMistakeCooldownDays} 天会再次出题。` : stats.historyTotal > 0 ? "继续学习新课后，再回来巩固吧。" : "学完下一课后，这里会从后往前复习。" : isPoetryMode ? "请让家长检查本课的古诗内容。" : "请选择其他课次。"}</p>
          {mode === "history" && stats.historyTotal > 0 ? (
            <button className="primary-button" type="button" onClick={onRestart}>重新出题</button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="practice-heading">
            <div className="practice-heading-row">
              <h2>{phase === "reviewing" ? "点选写错的字" : isPoetryMode ? `古诗默写 · ${items.length} 篇` : `本轮默写 · ${items.length} 题`}</h2>
              <span className="phase-badge" aria-live="polite">
                {phase === "reviewing" ? "自己批改" : isPoetryMode ? "正在默写" : `第 ${safeActiveItemIndex + 1} / ${items.length} 题`}
              </span>
            </div>
            {phase === "dictating" && (
              <div className="practice-details">
                <p>{isPoetryMode ? "按题目拼音默写整篇" : mode === "history"
                  ? `整词默写 · 错题复练 ${mistakeWordCount} 题 · 待完成 ${items.length - mistakeWordCount} 题`
                  : "听词语，写下每个字和拼音"}</p>
                {!isPoetryMode && (
                  <div className="keyboard-guide" aria-label="键盘快捷操作">
                    <span><kbd>←</kbd><kbd>→</kbd> 切换题目</span>
                    <span><kbd>空格</kbd> 播放 / 停止</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {phase === "reviewing" && !isPoetryMode ? (
            <p className="word-issue-guide">发现组词不合适或读音不准？在题卡下方标记，家长之后会统一核对。题目问题与写错的字分别标记。</p>
          ) : null}

          {phase === "dictating" && !isPoetryMode && items.some((item) => item.word.textbookHint) ? (
            <p className="muted sentence-guide">默写<span className="textbook-hint-blank">（　）</span>里的词语。提示里的拼音用来帮助阅读。</p>
          ) : null}

          <div className={`dictation-grid ${isPoetryMode ? "poetry-grid" : ""}`}>
            {items.map((item, globalIndex) => {
              const poem = lesson.classicalTexts?.[globalIndex];
              const bookLabel = bookLabelsByLesson.get(item.word.lessonId);
              const sourceTitle = phase === "reviewing" ? item.word.lessonTitle : dictationLessonTitles.get(item.word.lessonId) ?? item.word.lessonTitle;
              return isPoetryMode && poem ? (
                <PoetryCard
                  index={globalIndex}
                  item={item}
                  key={poem.id}
                  onToggleWrong={onToggleWrong}
                  poem={poem}
                  reviewing={phase === "reviewing"}
                  wrongCharKeys={wrongCharKeys}
                />
              ) : (
                <DictationCard
                  active={phase === "dictating" && globalIndex === safeActiveItemIndex}
                  lessonSource={bookLabel ? `${bookLabel} · ${sourceTitle}` : sourceTitle}
                  index={globalIndex}
                  item={item}
                  key={`${item.word.id}-${globalIndex}`}
                  pinyinShown={pinyinShownWordIds.has(item.word.id)}
                  onActivate={() => activateItem(globalIndex)}
                  onTogglePlayback={() => void startDoublePlayback(globalIndex)}
                  onShowPinyin={() => onShowPinyin(item.word.id)}
                  playback={speechPlayback.index === globalIndex ? speechPlayback : idleSpeechPlayback}
                  maskedSentence={item.word.textbookHint && maskSentence(item.word.textbookHint)}
                  reviewing={phase === "reviewing"}
                  onToggleWrong={onToggleWrong}
                  wrongCharKeys={wrongCharKeys}
                  issue={findWordIssue(wordIssues, item.word)}
                  onToggleIssue={(kind) => onToggleIssue(item.word, kind)}
                />
              );
            })}
          </div>

          <div className="sticky-actions">
            <div>
              {phase === "dictating" ? (
                <>
                  <strong>{finishArmed ? "确认要结束默写吗？" : isPoetryMode ? "题目、朝代、作者和全文都写好了吗？" : "所有题目都写好了吗？"}</strong>
                  <span>{finishArmed ? "请再次点击橙色按钮；4 秒后自动取消" : "结束后显示完整答案"}</span>
                </>
              ) : (
                <><strong>已标记 {wrongCharKeys.size} 个错字</strong><span>检查全部题目，只需点选写错的字</span></>
              )}
            </div>
            <div className="action-buttons">
              {phase === "dictating" ? (
                <button className={`primary-button ${finishArmed ? "finish-confirm" : ""}`} type="button" onClick={confirmFinish}>
                  <ClipboardCheck size={19} />{finishArmed ? "确认结束并看答案" : "结束默写"}
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={onSave}><Check size={19} />完成批改</button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
