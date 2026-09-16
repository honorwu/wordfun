import {
  BarChart3,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  History,
  Home,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { gradeNames } from "./data/metadata";
import { fetchAppData, saveRemoteState } from "./lib/api";
import {
  applyReviewResult,
  charReviewKey,
  fullDictationCharsForWord,
  generateCurrentLessonPractice,
  generateScreeningPractice,
  isHistoryCharCoolingDown,
  isMasteredChar,
  isPendingScreeningMistakeChar,
  lessonOrder,
  reviewCharsForWord,
} from "./lib/scheduler";
import { createDefaultState } from "./lib/storage";
import type { AppState, ClassicalText, CompanionDictionary, DictationWord, Grade, Lesson, PracticeItem } from "./types";

const historyBatchSize = 20;

type ViewMode = "student" | "parent";
type PracticeMode = "lesson" | "history";
type PracticePhase = "dictating" | "reviewing" | "done";

const termLabel = (term: number) => (term === 2 ? "下册" : "上册");

const lessonNumberLabel = (lesson: Lesson) => {
  if (lesson.title.startsWith("语文园地")) return lesson.title;
  return Number.isInteger(lesson.number) ? `第${lesson.number}课·${lesson.title}` : lesson.title;
};

const lessonLabel = (lesson: Lesson) => `${gradeNames[lesson.grade]}${termLabel(lesson.unit)} · ${lessonNumberLabel(lesson)}`;

const formatDate = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));

const localDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const availableGrades = (lessons: Lesson[]) =>
  Array.from(new Set(lessons.map((lesson) => lesson.grade))).sort((a, b) => a - b) as Grade[];

const generatePoetryPractice = (lesson: Lesson): PracticeItem[] =>
  (lesson.classicalTexts ?? []).map((poem, index) => {
    const bodyText = poem.lines.map((line) => line.text).join("\n");
    const bodyPinyin = poem.lines.map((line) => line.pinyin).join("\n");
    const text = [poem.title, poem.dynasty, poem.author, bodyText].filter(Boolean).join("\n");
    const pinyin = [poem.titlePinyin, bodyPinyin].filter(Boolean).join("\n");
    const chars = Array.from(new Set(Array.from(text).filter((char) => /\p{Script=Han}/u.test(char))));
    return {
      word: {
        id: `poem-${poem.id}`,
        text,
        pinyin,
        chars,
        grade: lesson.grade,
        lessonId: lesson.id,
        lessonTitle: poem.title,
        category: "一类",
      },
      score: 1000 - index,
      reasons: ["古诗全文默写"],
    };
  });

function App() {
  const [state, setState] = useState<AppState>(() => createDefaultState());
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [companionWords, setCompanionWords] = useState<CompanionDictionary>({});
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("student");
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("lesson");
  const [phase, setPhase] = useState<PracticePhase>("dictating");
  const [wrongCharKeys, setWrongCharKeys] = useState<Set<string>>(() => new Set());
  const [hintedWordIds, setHintedWordIds] = useState<Set<string>>(() => new Set());
  const [savedMessage, setSavedMessage] = useState("");
  const [lastResult, setLastResult] = useState({ total: 0, wrong: 0 });
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    fetchAppData()
      .then((data) => {
        if (!active) return;
        setLessons(data.lessons);
        setCompanionWords(data.companionWords);
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
    if (!isReady) return;
    const timeout = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => saveRemoteState(state))
        .catch((error: unknown) => {
          setSavedMessage(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [isReady, state]);

  const allLessons = useMemo(() => [...lessons].sort((a, b) => lessonOrder(a) - lessonOrder(b)), [lessons]);
  const selectedLesson = allLessons.find((lesson) => lesson.id === state.progress.lessonId) ?? allLessons[0];

  const practiceItems = useMemo(() => {
    if (!selectedLesson) return [];
    if (practiceMode === "lesson") {
      if (selectedLesson.lessonKind === "classical_poetry") return generatePoetryPractice(selectedLesson);
      return generateCurrentLessonPractice(allLessons, state, companionWords);
    }
    return generateScreeningPractice(allLessons, state, historyBatchSize, companionWords, 0);
  }, [allLessons, companionWords, practiceMode, selectedLesson, state]);

  const allKnownWords = useMemo(
    () =>
      new Map(
        allLessons
          .flatMap((lesson) => [...lesson.words, ...(lesson.textbookWords ?? [])])
          .map((word) => [word.id, word]),
      ),
    [allLessons],
  );

  const stats = useMemo(() => {
    if (!selectedLesson) return { historyTotal: 0, historyReviewed: 0, pendingMistakes: 0, waitingReview: 0, todayCount: 0 };
    const selectedOrder = lessonOrder(selectedLesson);
    const historyWords = allLessons
      .filter((lesson) => lessonOrder(lesson) < selectedOrder && lesson.lessonKind !== "classical_poetry")
      .flatMap((lesson) => lesson.words);
    const uniqueHistoryWords = [...new Map(historyWords.map((word) => [word.id, word])).values()];
    const historyChars = Array.from(new Set(uniqueHistoryWords.flatMap((word) => reviewCharsForWord(word))));
    const reviewed = historyChars.filter((char) => {
      return isMasteredChar(state.charStats[char]);
    }).length;
    const pendingMistakes = historyChars.filter((char) => {
      return isPendingScreeningMistakeChar(state.charStats[char]);
    }).length;
    const waitingReview = historyChars.filter((char) => isHistoryCharCoolingDown(state.charStats[char])).length;
    const today = new Date().toDateString();
    const todayCount = state.logs
      .filter((log) => new Date(log.date).toDateString() === today)
      .reduce((sum, log) => sum + log.wordIds.length, 0);
    return { historyTotal: historyChars.length, historyReviewed: reviewed, pendingMistakes, waitingReview, todayCount };
  }, [allLessons, selectedLesson, state.charStats, state.logs]);

  const resetPractice = (nextMode = practiceMode) => {
    setPracticeMode(nextMode);
    setPhase("dictating");
    setWrongCharKeys(new Set());
    setHintedWordIds(new Set());
    setLastResult({ total: 0, wrong: 0 });
  };

  const setProgress = (lesson: Lesson) => {
    setState((current) => ({ ...current, progress: { grade: lesson.grade, lessonId: lesson.id } }));
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

  const finishDictation = () => {
    setPhase("reviewing");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveReview = () => {
    const reviewedCharsByWord = new Map(
      practiceItems.map((item) => [
        item.word.id,
        selectedLesson?.lessonKind === "classical_poetry" || practiceMode === "history" || hintedWordIds.has(item.word.id)
          ? reviewCharsForWord(item.word)
          : fullDictationCharsForWord(item.word),
      ]),
    );
    const wrongCount = practiceItems.reduce(
      (sum, item) => sum + (reviewedCharsByWord.get(item.word.id) ?? []).filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))).length,
      0,
    );
    setState((current) => applyReviewResult(current, practiceItems, wrongCharKeys, reviewedCharsByWord));
    setLastResult({ total: practiceItems.length, wrong: wrongCount });
    setWrongCharKeys(new Set());
    setHintedWordIds(new Set());
    setPhase("done");
    setSavedMessage("批改结果已记录");
    window.setTimeout(() => setSavedMessage(""), 1800);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (loadError) return <StatusScreen title="词库加载失败" detail={loadError} />;
  if (!isReady || !selectedLesson) return <StatusScreen title="正在整理词库" detail="马上就好……" />;

  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="brand" type="button" onClick={() => setViewMode("student")} aria-label="回到学生默写">
          <span className="brand-mark">字</span>
          <span><strong>字趣</strong><small>每天认真写好一点</small></span>
        </button>
        <nav className="view-tabs" aria-label="页面切换">
          <button className={viewMode === "student" ? "active" : ""} type="button" onClick={() => setViewMode("student")}>
            <Home size={18} />开始默写
          </button>
          <button className={viewMode === "parent" ? "active" : ""} type="button" onClick={() => setViewMode("parent")}>
            <BarChart3 size={18} />家长看板
          </button>
        </nav>
      </header>

      {viewMode === "student" ? (
        <StudentView
          items={practiceItems}
          hintedWordIds={hintedWordIds}
          lastResult={lastResult}
          lesson={selectedLesson}
          lessons={allLessons}
          mode={practiceMode}
          onFinish={finishDictation}
          onRevealHint={(wordId) => setHintedWordIds((current) => new Set(current).add(wordId))}
          onRestart={() => resetPractice(practiceMode)}
          onSave={saveReview}
          onSelectLesson={setProgress}
          onSelectMode={(mode) => resetPractice(mode)}
          onToggleWrong={toggleWrongChar}
          phase={phase}
          stats={stats}
          wrongCharKeys={wrongCharKeys}
        />
      ) : (
        <ParentView
          selectedLesson={selectedLesson}
          state={state}
          wordById={allKnownWords}
        />
      )}

      {savedMessage ? <div className="toast">{savedMessage}</div> : null}
    </main>
  );
}

function StudentView({
  hintedWordIds,
  items,
  lastResult,
  lesson,
  lessons,
  mode,
  onFinish,
  onRevealHint,
  onRestart,
  onSave,
  onSelectLesson,
  onSelectMode,
  onToggleWrong,
  phase,
  stats,
  wrongCharKeys,
}: {
  hintedWordIds: ReadonlySet<string>;
  items: PracticeItem[];
  lastResult: { total: number; wrong: number };
  lesson: Lesson;
  lessons: Lesson[];
  mode: PracticeMode;
  onFinish: () => void;
  onRevealHint: (wordId: string) => void;
  onRestart: () => void;
  onSave: () => void;
  onSelectLesson: (lesson: Lesson) => void;
  onSelectMode: (mode: PracticeMode) => void;
  onToggleWrong: (wordId: string, char: string) => void;
  phase: PracticePhase;
  stats: { historyTotal: number; historyReviewed: number; pendingMistakes: number; waitingReview: number; todayCount: number };
  wrongCharKeys: Set<string>;
}) {
  const pageSize = 4;
  const [itemPage, setItemPage] = useState(0);
  const [finishArmed, setFinishArmed] = useState(false);
  const reviewPercent = stats.historyTotal > 0 ? Math.round((stats.historyReviewed / stats.historyTotal) * 100) : 0;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(itemPage, totalPages - 1);
  const visibleItems = items.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const isLastPage = safePage === totalPages - 1;
  const isPoetryMode = mode === "lesson" && lesson.lessonKind === "classical_poetry";
  const grades = availableGrades(lessons);
  const terms = Array.from(new Set(lessons.filter((item) => item.grade === lesson.grade).map((item) => item.unit))).sort();
  const scopedLessons = lessons.filter((item) => item.grade === lesson.grade && item.unit === lesson.unit);

  const pickFirstLesson = (grade: Grade, term?: number) => {
    const first = lessons.find((item) => item.grade === grade && (term ? item.unit === term : true));
    if (first) onSelectLesson(first);
  };

  useEffect(() => {
    setItemPage(0);
    setFinishArmed(false);
  }, [lesson.id, mode, items.length]);

  useEffect(() => {
    if (!finishArmed) return;
    const timeout = window.setTimeout(() => setFinishArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [finishArmed]);

  const goToPage = (nextPage: number) => {
    setItemPage(Math.max(0, Math.min(totalPages - 1, nextPage)));
    setFinishArmed(false);
    window.requestAnimationFrame(() => document.querySelector(".practice-heading")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const confirmFinish = () => {
    if (!finishArmed) {
      setFinishArmed(true);
      return;
    }
    setFinishArmed(false);
    setItemPage(0);
    onFinish();
  };

  if (phase === "done") {
    return (
      <section className="student-main">
        <div className="result-card">
          <span className="result-spark"><Sparkles size={34} /></span>
          <p className="eyebrow">默写完成</p>
          <h1>{lastResult.wrong === 0 ? "全部写对了！" : "批改完成，继续加油"}</h1>
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
    <section className="student-main">
      <div className="lesson-banner">
        <div>
          <p className="eyebrow">我现在学到</p>
          <h1>{lessonLabel(lesson)}</h1>
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
                {scopedLessons.map((item) => <option key={item.id} value={item.id}>{lessonNumberLabel(item)}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="today-pill"><strong>{stats.todayCount}</strong><span>今天已默写</span></div>
      </div>

      <div className="practice-tabs" role="group" aria-label="复习方式">
        <button className={mode === "lesson" ? "active" : ""} type="button" onClick={() => onSelectMode("lesson")}>
          <BookOpen size={21} /><span><strong>当课复习</strong><small>复习刚学的这一课</small></span>
        </button>
        <button className={mode === "history" ? "active" : ""} type="button" onClick={() => onSelectMode("history")}>
          <History size={21} /><span><strong>历史复习</strong><small>从后往前，优先练不会的字</small></span>
        </button>
      </div>

      {mode === "history" ? (
        <div className="history-progress">
          <div><span>历史复习进度</span><strong>{stats.historyReviewed} / {stats.historyTotal} 字已掌握</strong></div>
          <div className="progress-track"><i style={{ width: `${reviewPercent}%` }} /></div>
          <p>{stats.pendingMistakes > 0 ? `${stats.pendingMistakes} 个待巩固 · 错后间隔 7 天` : `已掌握 ${reviewPercent}%`}</p>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="empty-card">
          <Check size={34} />
          <h2>{mode === "history" ? stats.waitingReview > 0 ? "错字正在间隔复习" : stats.historyTotal > 0 ? "以前的字都写对了" : "前面还没有可复习的课" : isPoetryMode ? "这一课还没有古诗正文" : "这一课还没有可默写的词语"}</h2>
          <p>{mode === "history" ? stats.waitingReview > 0 ? "写错后至少间隔 7 天，目前还没有到期的字。" : stats.historyTotal > 0 ? "继续学习新课后，再回来巩固吧。" : "学完下一课后，这里会从后往前复习。" : isPoetryMode ? "请让家长检查本课的古诗内容。" : "请选择其他课次。"}</p>
        </div>
      ) : (
        <>
          <div className="practice-heading">
            <div>
              <p className="eyebrow">{phase === "dictating" ? isPoetryMode ? "看题目拼音，背诵默写" : mode === "history" ? "先听词语，专练不会的字" : "先听词语，再动笔" : "完整答案"}</p>
              <h2>{phase === "dictating" ? isPoetryMode ? `古诗背诵默写 · 共 ${items.length} 篇` : mode === "history" ? `本组 ${visibleItems.length} 题 · 只默写需要巩固的字` : `本组 ${visibleItems.length} 题 · 每个字和拼音都要写` : "请点选写错的字"}</h2>
            </div>
            <div className="practice-status">
              <span className="page-counter">第 {safePage + 1} / {totalPages} 组</span>
              <div className={`phase-badge ${phase}`}>
                {phase === "dictating" ? <><span>1</span> 正在默写</> : <><span>2</span> 自己批改</>}
              </div>
            </div>
          </div>

          <div className={`dictation-grid ${isPoetryMode ? "poetry-grid" : ""}`}>
            {visibleItems.map((item, index) => {
              const globalIndex = safePage * pageSize + index;
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
                  focusOnly={mode === "history"}
                  index={globalIndex}
                  item={item}
                  key={`${item.word.id}-${globalIndex}`}
                  hintRevealed={hintedWordIds.has(item.word.id)}
                  onRevealHint={() => onRevealHint(item.word.id)}
                  reviewing={phase === "reviewing"}
                  onToggleWrong={onToggleWrong}
                  wrongCharKeys={wrongCharKeys}
                />
              );
            })}
          </div>

          <div className="sticky-actions">
            <div>
              {phase === "dictating" ? (
                <>
                  <strong>{finishArmed ? "确认要结束默写吗？" : isLastPage ? isPoetryMode ? "题目、朝代、作者和全文都写好了吗？" : "最后一组写好了吗？" : "这一组写好了吗？"}</strong>
                  <span>{finishArmed ? "请再次点击橙色按钮；4 秒后自动取消" : isLastPage ? "结束后显示完整答案" : "进入下一组，不会提前显示答案"}</span>
                </>
              ) : (
                <><strong>已标记 {wrongCharKeys.size} 个错字</strong><span>{isLastPage ? "只需点选写错的字" : "批改好这一组，再继续下一组"}</span></>
              )}
            </div>
            <div className="action-buttons">
              {safePage > 0 ? <button className="secondary-button" type="button" onClick={() => goToPage(safePage - 1)}><ChevronLeft size={18} />上一组</button> : null}
              {!isLastPage ? (
                <button className="primary-button" type="button" onClick={() => goToPage(safePage + 1)}>下一组<ChevronRight size={19} /></button>
              ) : phase === "dictating" ? (
                <button className={`primary-button ${finishArmed ? "finish-confirm" : ""}`} type="button" onClick={confirmFinish}>
                  <ClipboardCheck size={19} />{finishArmed ? "确认结束并看答案" : "结束默写"}
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={() => { setItemPage(0); onSave(); }}><Check size={19} />完成批改</button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function PoetryCard({
  index,
  item,
  onToggleWrong,
  poem,
  reviewing,
  wrongCharKeys,
}: {
  index: number;
  item: PracticeItem;
  onToggleWrong: (wordId: string, char: string) => void;
  poem: ClassicalText;
  reviewing: boolean;
  wrongCharKeys: Set<string>;
}) {
  const poemChars = item.word.chars;
  const wrongCount = poemChars.filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))).length;
  const renderReviewText = (text: string, keyPrefix: string) => Array.from(text).map((char, charIndex) => {
    if (!/\p{Script=Han}/u.test(char)) return <span className="poetry-heading-punctuation" key={`${keyPrefix}-${charIndex}`}>{char}</span>;
    const isWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
    return (
      <button
        className={isWrong ? "wrong" : ""}
        type="button"
        key={`${keyPrefix}-${char}-${charIndex}`}
        onClick={() => onToggleWrong(item.word.id, char)}
        aria-pressed={isWrong}
        aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}
      >
        {char}
      </button>
    );
  });

  return (
    <article className={`poetry-card ${reviewing ? "revealed" : ""} ${wrongCount > 0 ? "has-wrong" : ""}`}>
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span>古诗背诵默写</span>
        {reviewing ? <b>{wrongCount > 0 ? `${wrongCount} 个错字` : "待批改"}</b> : null}
      </div>
      <header className={`poetry-title ${reviewing ? "answer-title" : "prompt-title"}`}>
        {reviewing ? (
          <>
            <h3>{renderReviewText(poem.title, "title")}</h3>
            {poem.author ? <span className="poetry-byline">{renderReviewText(`${poem.dynasty ? `〔${poem.dynasty}〕` : ""}${poem.author}`, "byline")}</span> : null}
            {poem.titlePinyin ? <small>{poem.titlePinyin}</small> : null}
          </>
        ) : (
          <>
            <p>{poem.titlePinyin || "题目拼音待补充"}</p>
            <small>根据拼音默写题目</small>
          </>
        )}
      </header>
      {reviewing ? (
        <div className="poetry-answer">
          {poem.lines.map((line, lineIndex) => (
            <div className="poetry-line" key={`${poem.id}-${lineIndex}`}>
              <div className="poetry-chars">
                {Array.from(line.text).map((char, charIndex) => {
                  if (!/\p{Script=Han}/u.test(char)) return <span className="poetry-punctuation" key={`${char}-${charIndex}`}>{char}</span>;
                  const isWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
                  return (
                    <button
                      className={isWrong ? "wrong" : ""}
                      type="button"
                      key={`${char}-${charIndex}`}
                      onClick={() => onToggleWrong(item.word.id, char)}
                      aria-pressed={isWrong}
                      aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}
                    >
                      {char}
                    </button>
                  );
                })}
              </div>
              <p>{line.pinyin}</p>
            </div>
          ))}
          <p className="poetry-review-hint">只需点击写错的字，未点选的字会记为正确。</p>
        </div>
      ) : (
        <div className="poetry-memory-prompt">
          <BookOpen size={28} />
          <strong>请默写题目、朝代、作者和全文</strong>
          <span>只提供题目拼音 · 不播放语音</span>
          <div className="poetry-writing-lines" aria-hidden="true">
            {poem.lines.map((_, lineIndex) => <i key={lineIndex} />)}
          </div>
        </div>
      )}
    </article>
  );
}

function DictationCard({
  focusOnly,
  hintRevealed,
  index,
  item,
  onRevealHint,
  onToggleWrong,
  reviewing,
  wrongCharKeys,
}: {
  focusOnly: boolean;
  hintRevealed: boolean;
  index: number;
  item: PracticeItem;
  onRevealHint: () => void;
  onToggleWrong: (wordId: string, char: string) => void;
  reviewing: boolean;
  wrongCharKeys: Set<string>;
}) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const speechRequestRef = useRef(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const chars = Array.from(item.word.text).filter((char) => /\p{Script=Han}/u.test(char));
  const syllables = item.word.pinyin
    .split(/\s+/u)
    .map((syllable) => syllable.replace(/[，。！？；：、,.!?;:]/gu, ""))
    .filter(Boolean);
  const targets = new Set(reviewCharsForWord(item.word));
  const helpersVisible = reviewing || hintRevealed;
  const restrictReviewToTargets = focusOnly || hintRevealed;
  const reviewTargets = restrictReviewToTargets ? targets : new Set(fullDictationCharsForWord(item.word));
  const targetIndexes = new Set<number>();
  chars.forEach((char, index) => {
    if (targets.has(char)) targetIndexes.add(index);
  });
  const hasWrong = [...reviewTargets].some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));

  useEffect(() => () => {
    speechRequestRef.current += 1;
    utteranceRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const speak = async () => {
    if (!("speechSynthesis" in window)) {
      setIsSpeaking(false);
      return;
    }
    const requestId = speechRequestRef.current + 1;
    speechRequestRef.current = requestId;
    utteranceRef.current = null;
    window.speechSynthesis.cancel();
    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 350);
        window.speechSynthesis.addEventListener("voiceschanged", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      voices = window.speechSynthesis.getVoices();
    }
    if (speechRequestRef.current !== requestId) return;
    const mainlandVoices = voices.filter((voice) => voice.lang.replace("_", "-").toLowerCase() === "zh-cn");
    const preferredVoice = mainlandVoices.find((voice) => /natural|premium|enhanced|tingting|ting-ting|xiaoxiao|yunxi|普通话/iu.test(voice.name)) ?? mainlandVoices[0];
    const utterance = new SpeechSynthesisUtterance(item.word.text);
    utterance.lang = "zh-CN";
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.rate = 0.82;
    utterance.pitch = 1;
    const finish = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setIsSpeaking(false);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    utteranceRef.current = utterance;
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  return (
    <article className={`dictation-card ${chars.length >= 5 ? "long-word" : ""} ${reviewing ? "revealed" : ""} ${hasWrong ? "has-wrong" : ""}`}>
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span>{item.word.lessonTitle}</span>
        {reviewing ? <b>{hasWrong ? "有错字" : "待批改"}</b> : null}
      </div>
      <div className="card-listen-actions">
        <button className={isSpeaking ? "listen-button speaking" : "listen-button"} type="button" onClick={() => void speak()}>
          <Volume2 size={19} />{isSpeaking ? "正在播放…" : "听词语"}
        </button>
        {!reviewing ? (
          <button className={hintRevealed ? "hint-button revealed" : "hint-button"} type="button" onClick={onRevealHint} disabled={hintRevealed}>
            <Eye size={17} />{hintRevealed ? "提示已显示" : "没听清？查看提示"}
          </button>
        ) : null}
      </div>
      <div className="word-cells" aria-label={`第 ${index + 1} 题`}>
        {chars.map((char, charIndex) => {
          const isCoreTarget = targetIndexes.has(charIndex);
          const isReviewTarget = !restrictReviewToTargets || isCoreTarget;
          const displayAsTarget = !helpersVisible || isCoreTarget;
          const isWrong = isReviewTarget && wrongCharKeys.has(charReviewKey(item.word.id, char));
          const showPinyin = reviewing || (hintRevealed && isCoreTarget);
          const cellHint = reviewing
            ? isReviewTarget ? (isWrong ? "写错了" : "点击标错") : "提示字，不计分"
            : hintRevealed
              ? isCoreTarget ? "按拼音默写" : "提示字"
              : "待默写";
          return (
            <div className={`word-cell ${displayAsTarget ? "target" : "helper"} ${isWrong ? "wrong" : ""}`} key={`${char}-${charIndex}`}>
              <span className={`pinyin ${showPinyin ? "answer-pinyin" : "dictation-pinyin-hidden"}`}>
                {showPinyin ? syllables[charIndex] ?? "" : ""}
              </span>
              {isReviewTarget && reviewing ? (
                <button type="button" onClick={() => onToggleWrong(item.word.id, char)} aria-pressed={isWrong} aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}>
                  <strong>{char}</strong><small>{isWrong ? "写错了" : "点击标错"}</small>{isWrong ? <X size={17} /> : <Check size={17} />}
                </button>
              ) : (
                <div className="character-box">
                  {helpersVisible && !isCoreTarget ? <strong>{char}</strong> : <span className="writing-line" />}
                </div>
              )}
              <em>{cellHint}</em>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ParentView({
  selectedLesson,
  state,
  wordById,
}: {
  selectedLesson: Lesson;
  state: AppState;
  wordById: Map<string, DictationWord>;
}) {
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const pendingWrongChars = Object.entries(state.charStats)
    .filter(([, stat]) => stat.mistakes > 0 && !isMasteredChar(stat))
    .sort((left, right) => right[1].mistakes - left[1].mistakes);
  const wrongChars = pendingWrongChars.slice(0, 24);
  const totalPracticeCount = state.logs.reduce((total, log) => total + log.wordIds.length, 0);
  const totalCheckinDays = new Set(state.logs.map((log) => localDateKey(new Date(log.date)))).size;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const recentCheckinDays = new Set(
    state.logs
      .filter((log) => {
        const practiceDay = new Date(log.date);
        practiceDay.setHours(0, 0, 0, 0);
        const dayDifference = (todayStart.getTime() - practiceDay.getTime()) / 86_400_000;
        return dayDifference >= 0 && dayDifference < 7;
      })
      .map((log) => localDateKey(new Date(log.date))),
  ).size;
  const totalCharacterAttempts = Object.values(state.charStats).reduce((total, stat) => total + stat.attempts, 0);
  const totalCharacterMistakes = Object.values(state.charStats).reduce((total, stat) => total + stat.mistakes, 0);
  const accuracy = totalCharacterAttempts > 0
    ? Math.max(0, Math.round(((totalCharacterAttempts - totalCharacterMistakes) / totalCharacterAttempts) * 100))
    : null;
  const activityByDate = state.logs.reduce<Map<string, number>>((result, log) => {
    const key = localDateKey(new Date(log.date));
    result.set(key, (result.get(key) ?? 0) + log.wordIds.length);
    return result;
  }, new Map());
  const calendarYear = calendarMonth.getFullYear();
  const calendarMonthIndex = calendarMonth.getMonth();
  const calendarOffset = (new Date(calendarYear, calendarMonthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calendarYear, calendarMonthIndex + 1, 0).getDate();
  const calendarDays = Array.from({ length: calendarOffset + daysInMonth }, (_, index) =>
    index < calendarOffset ? null : new Date(calendarYear, calendarMonthIndex, index - calendarOffset + 1),
  );
  while (calendarDays.length % 7 !== 0) calendarDays.push(null);
  const checkedDays = calendarDays.filter((date) => date && activityByDate.has(localDateKey(date))).length;

  return (
    <section className="parent-main">
      <div className="parent-title">
        <div>
          <p className="eyebrow">家长看板</p>
          <h1>学习情况一览</h1>
          <p>默写记录、打卡习惯和待巩固错字会自动汇总在这里。课次由孩子在默写首页选择。</p>
        </div>
        <div className="current-course"><span>当前学习进度</span><strong>{lessonLabel(selectedLesson)}</strong></div>
      </div>

      <div className="parent-grid">
        <section className="panel overview-panel">
          <div className="panel-heading"><BarChart3 size={20} /><h2>学习概览</h2></div>
          <div className="overview-stats">
            <div className="overview-stat"><strong>{totalPracticeCount}</strong><span>累计默写（项）</span></div>
            <div className="overview-stat"><strong>{totalCheckinDays}</strong><span>累计打卡（天）</span></div>
            <div className="overview-stat"><strong>{recentCheckinDays}</strong><span>近 7 天打卡</span></div>
            <div className="overview-stat"><strong>{accuracy === null ? "—" : `${accuracy}%`}</strong><span>累计字准确率</span></div>
            <div className="overview-stat attention"><strong>{pendingWrongChars.length}</strong><span>待巩固错字</span></div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading"><History size={20} /><h2>最近默写</h2></div>
          <div className="recent-list">
            {state.logs.length === 0 ? <p className="muted">还没有默写记录。</p> : state.logs.slice(0, 6).map((log) => {
              const wrong = log.wrongChars?.length ?? log.wrongWordIds.length;
              const wrongText = log.wrongChars
                ? Array.from(new Set(log.wrongChars.map((item) => item.char))).join("、")
                : log.wrongWordIds.map((id) => wordById.get(id)?.text).filter(Boolean).join("、");
              return (
                <div className="recent-item" key={log.id}>
                  <span>{formatDate(log.date)}</span><strong>{log.wordIds.length} 项 · {wrong === 0 ? "全对" : `错 ${wrong} 字`}</strong><small>{wrongText || "表现很棒"}</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel wide calendar-panel">
          <div className="calendar-heading">
            <div className="panel-heading"><CalendarDays size={20} /><h2>打卡日历</h2></div>
            <div className="calendar-nav">
              <button type="button" onClick={() => setCalendarMonth(new Date(calendarYear, calendarMonthIndex - 1, 1))} aria-label="上一个月"><ChevronLeft size={18} /></button>
              <strong>{calendarYear} 年 {calendarMonthIndex + 1} 月</strong>
              <button type="button" onClick={() => setCalendarMonth(new Date(calendarYear, calendarMonthIndex + 1, 1))} aria-label="下一个月"><ChevronRight size={18} /></button>
            </div>
          </div>
          <div className="calendar-summary">本月已打卡 <strong>{checkedDays}</strong> 天</div>
          <div className="calendar-grid calendar-weekdays" aria-hidden="true">
            {["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>周{day}</span>)}
          </div>
          <div className="calendar-grid">
            {calendarDays.map((date, index) => {
              if (!date) return <span className="calendar-day blank" key={`blank-${index}`} />;
              const key = localDateKey(date);
              const practiceCount = activityByDate.get(key) ?? 0;
              const isToday = key === localDateKey(new Date());
              return (
                <div className={`calendar-day ${practiceCount > 0 ? "checked" : ""} ${isToday ? "today" : ""}`} key={key}>
                  <b>{date.getDate()}</b>
                  {practiceCount > 0 ? <><span><Check size={13} />已打卡</span><small>{practiceCount} 项</small></> : <small>{isToday ? "今天" : ""}</small>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel wide">
          <div className="panel-heading"><ClipboardCheck size={20} /><h2>待巩固错字</h2></div>
          {wrongChars.length === 0 ? <p className="muted">目前没有待巩固的错字。新的批改结果会自动记在这里。</p> : (
            <div className="wrong-char-list">{wrongChars.map(([char, stat]) => <span key={char}><strong>{char}</strong><small>错 {stat.mistakes} 次</small></span>)}</div>
          )}
        </section>

      </div>
    </section>
  );
}

function StatusScreen({ title, detail }: { title: string; detail: string }) {
  return <main className="status-screen"><span className="brand-mark">字</span><h1>{title}</h1><p>{detail}</p></main>;
}

export default App;
