import { BookOpen, Check, ChevronRight, ClipboardCheck, History, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DictationWord, Grade, LessonSummary, PracticeItem, PracticeLesson, PracticeStats, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import type { PracticeMode, PracticePhase, CorrectionItem } from "./types";
import { reviewCharsForWord } from "../../../shared/domain/index.ts";
import { findWordIssue } from "../../../shared/domain/wordIssues.ts";
import { gradeNames } from "../../data/metadata";
import { termLabel, lessonNumberLabel, lessonLabel, availableGrades } from "../../lib/lessonPresentation";
import { maskLessonTitle } from "./titleMask";
import { CorrectionView } from "./CorrectionView";
import { PoetryCard } from "./PoetryCard";
import { DictationCard } from "./DictationCard";
import { useSpeechPlayback } from "./useSpeechPlayback";
import { idleSpeechPlayback } from "./types";

export interface StudentViewProps {
  loading: boolean;
  loadError: string;
  onRetry: () => void;
  correctionItems: CorrectionItem[];
  hintedWordIds: ReadonlySet<string>;
  items: PracticeItem[];
  lastResult: { total: number; wrong: number };
  lesson: PracticeLesson;
  lessons: LessonSummary[];
  mode: PracticeMode;
  onFinish: () => void;
  onFinishCorrection: () => void;
  onRevealHint: (wordId: string) => void;
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
  onRetry,
  correctionItems,
  hintedWordIds,
  items,
  lastResult,
  lesson,
  lessons,
  mode,
  onFinish,
  onFinishCorrection,
  onRevealHint,
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
  const reviewPercent = stats.historyTotal > 0 ? Math.round((stats.historyReviewed / stats.historyTotal) * 100) : 0;
  const safeActiveItemIndex = Math.max(0, Math.min(activeItemIndex, Math.max(0, items.length - 1)));
  const isPoetryMode = mode === "lesson" && lesson.lessonKind === "classical_poetry";
  const { speechPlayback, stopPlayback, startDoublePlayback } = useSpeechPlayback({ items, isPoetryMode, phase, onActivate: setActiveItemIndex });
  const grades = availableGrades(lessons);
  const terms = Array.from(new Set(lessons.filter((item) => item.grade === lesson.grade).map((item) => item.unit))).sort();
  const scopedLessons = lessons.filter((item) => item.grade === lesson.grade && item.unit === lesson.unit);
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
  const protectedChars = useMemo(
    () => new Set(items.flatMap((item) => reviewCharsForWord(item.word))),
    [items],
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
          <h1>{lastResult.wrong === 0 ? "全部写对了！" : "订正完成，继续加油"}</h1>
          <p>
            这次完成了 <strong>{lastResult.total}</strong> 项内容，
            {lastResult.wrong === 0 ? "没有错字。" : <><strong>{lastResult.wrong}</strong> 个字已收进错字记录。</>}
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
        <div>
          <p className="eyebrow">我现在学到</p>
          <h1>{lessonLabel(lesson, displayedLessonTitle)}</h1>
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
        <div className="today-pill"><strong>{stats.todayCount}</strong><span>今天已默写</span></div>
      </div>

      <div className="practice-tabs" role="group" aria-label="复习方式">
        <button className={`lesson-mode ${mode === "lesson" ? "active" : ""}`} type="button" onClick={() => onSelectMode("lesson")}>
          <BookOpen size={21} /><span><strong>当课复习</strong><small>复习刚学的这一课</small></span>
        </button>
        <button className={`history-mode ${mode === "history" ? "active" : ""}`} type="button" onClick={() => onSelectMode("history")}>
          <History size={21} /><span><strong>历史复习</strong><small>从后往前，优先练不会的字</small></span>
        </button>
      </div>

      {mode === "history" && !loading && !loadError ? (
        <div className="history-progress">
          <div><span>历史复习进度</span><strong>{stats.historyReviewed} / {stats.historyTotal} 字已掌握</strong></div>
          <div className="progress-track"><i style={{ width: `${reviewPercent}%` }} /></div>
          <p>{stats.pendingMistakes > 0 ? `${stats.pendingMistakes} 个待巩固 · 每次练习间隔 7 天` : `已掌握 ${reviewPercent}%`}</p>
        </div>
      ) : null}

      {loading || loadError ? (
        <div className="empty-card" role="status">
          <h2>{loadError ? "题目加载失败" : "正在加载题目"}</h2>
          {loadError ? <><p>{loadError}</p><button className="primary-button" type="button" onClick={onRetry}>重新加载</button></> : null}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-card">
          <Check size={34} />
          <h2>{mode === "history" ? stats.waitingReview > 0 ? "错字正在间隔复习" : stats.historyTotal > 0 ? "以前的字都写对了" : "前面还没有可复习的课" : isPoetryMode ? "这一课还没有古诗正文" : "这一课还没有可默写的词语"}</h2>
          <p>{mode === "history" ? stats.waitingReview > 0 ? "待巩固的字每次练习后至少间隔 7 天，目前还没有到期。" : stats.historyTotal > 0 ? "继续学习新课后，再回来巩固吧。" : "学完下一课后，这里会从后往前复习。" : isPoetryMode ? "请让家长检查本课的古诗内容。" : "请选择其他课次。"}</p>
        </div>
      ) : (
        <>
          <div className="practice-heading">
            <div>
              <p className="eyebrow">{phase === "dictating" ? isPoetryMode ? "看题目拼音，背诵默写" : mode === "history" ? "先听词语，专练不会的字" : "先听词语，再动笔" : "完整答案"}</p>
              <h2>{phase === "dictating" ? isPoetryMode ? `古诗背诵默写 · 共 ${items.length} 篇` : mode === "history" ? `共 ${items.length} 题 · 只默写需要巩固的字` : `共 ${items.length} 题 · 每个字和拼音都要写` : "请点选写错的字"}</h2>
            </div>
            <div className="practice-status">
              <div className={`phase-badge ${phase}`}>
                {phase === "dictating" ? <><span>1</span> 正在默写</> : <><span>2</span> 自己批改</>}
              </div>
            </div>
          </div>

          {phase === "dictating" && !isPoetryMode ? (
            <div className="keyboard-guide" aria-label="键盘快捷操作">
              <strong>当前第 {safeActiveItemIndex + 1} / {items.length} 题</strong>
              <span><kbd>←</kbd><kbd>→</kbd> 上一题 / 下一题</span>
              <span><kbd>空格</kbd> 播放 / 停止 · 自动播 2 遍，间隔 10 秒</span>
            </div>
          ) : null}

          {phase === "reviewing" && !isPoetryMode ? (
            <p className="word-issue-guide">发现组词不合适或读音不准？在题卡下方标记，家长之后会统一核对。题目问题与写错的字分别标记。</p>
          ) : null}

          <div className={`dictation-grid ${isPoetryMode ? "poetry-grid" : ""}`}>
            {items.map((item, globalIndex) => {
              const poem = lesson.classicalTexts?.[globalIndex];
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
                  dictationLessonTitle={dictationLessonTitles.get(item.word.lessonId) ?? item.word.lessonTitle}
                  index={globalIndex}
                  item={item}
                  key={`${item.word.id}-${globalIndex}`}
                  hintRevealed={hintedWordIds.has(item.word.id)}
                  onActivate={() => activateItem(globalIndex)}
                  onTogglePlayback={() => void startDoublePlayback(globalIndex)}
                  onRevealHint={() => onRevealHint(item.word.id)}
                  playback={speechPlayback.index === globalIndex ? speechPlayback : idleSpeechPlayback}
                  protectedChars={protectedChars}
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
