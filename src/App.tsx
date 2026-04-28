import {
  BarChart3,
  BookOpen,
  Check,
  Download,
  FileText,
  History,
  Home,
  Printer,
  RefreshCw,
  RotateCcw,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import { gradeNames } from "./data/metadata";
import { fetchAppData, saveRemoteState } from "./lib/api";
import { applyReviewResult, charReviewKey, generatePractice, getEligibleLessons, getEligibleWords, isMasteredChar, isMasteredWord } from "./lib/scheduler";
import { createDefaultState, exportState, normalizeState } from "./lib/storage";
import type { AppState, CharacterCategory, CompanionDictionary, DictationWord, Grade, Lesson, PracticeItem } from "./types";

const targetCount = 20;

const categoryOptions: CharacterCategory[] = ["一类", "二类"];
const termOptions = [
  { label: "上册", value: 1 },
  { label: "下册", value: 2 },
] as const;

type Term = (typeof termOptions)[number]["value"];

type ViewMode = "student" | "parent";

type DashboardStats = {
  accuracy: number;
  masteredChars: number;
  masteredWords: number;
  pendingChars: number;
  reviewedChars: number;
  reviewedWords: number;
  todayPracticeCount: number;
  todayWrongCount: number;
  totalAttempts: number;
  totalChars: number;
  totalMistakes: number;
  totalWords: number;
  uniqueChars: string[];
  wrongWords: number;
};

const formatDate = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));

const todayText = () =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).format(new Date());

const termLabel = (term: number) => (term === 2 ? "下册" : "上册");

const lessonNumberLabel = (lesson: Lesson) => (lesson.title.startsWith("语文园地") ? lesson.title : `第${lesson.number}课 ${lesson.title}`);

const lessonLabel = (lesson: Lesson) => `${gradeNames[lesson.grade]}${termLabel(lesson.unit)} ${lessonNumberLabel(lesson)}`;

const sameLocalDay = (date: string) => new Date(date).toDateString() === new Date().toDateString();

const logWrongCharCount = (log: AppState["logs"][number]) => (log.wrongChars && log.wrongChars.length > 0 ? log.wrongChars.length : log.wrongWordIds.length);

const logWrongText = (log: AppState["logs"][number], wordById: Map<string, DictationWord>) =>
  log.wrongChars && log.wrongChars.length > 0
    ? log.wrongChars.map((item) => `${wordById.get(item.wordId)?.text ?? ""}：${item.char}`).join("、")
    : log.wrongWordIds.map((id) => wordById.get(id)?.text).filter(Boolean).join("、");

const mergeLessonCatalog = (baseLessons: Lesson[], customLessons: Lesson[]) => {
  const byId = new Map<string, Lesson>();
  for (const lesson of baseLessons) {
    byId.set(lesson.id, lesson);
  }
  for (const lesson of customLessons) {
    byId.set(lesson.id, lesson);
  }

  return [...byId.values()].sort((a, b) => a.grade - b.grade || a.unit - b.unit || a.number - b.number);
};

function App() {
  const [state, setState] = useState<AppState>(() => createDefaultState());
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [companionWords, setCompanionWords] = useState<CompanionDictionary>({});
  const [catalogInfo, setCatalogInfo] = useState({ builtInLessonCount: 0, builtInWordCount: 0 });
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("student");
  const [showAnswers, setShowAnswers] = useState(false);
  const [wrongCharKeys, setWrongCharKeys] = useState<Set<string>>(() => new Set());
  const [savedMessage, setSavedMessage] = useState("");

  useEffect(() => {
    let active = true;
    fetchAppData()
      .then((data) => {
        if (!active) {
          return;
        }
        setLessons(data.lessons);
        setCompanionWords(data.companionWords);
        setCatalogInfo({ builtInLessonCount: data.builtInLessonCount, builtInWordCount: data.builtInWordCount });
        setState(data.state);
        setIsReady(true);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "加载数据库失败");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }
    void saveRemoteState(state).catch((error: unknown) => {
      setSavedMessage(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
    });
  }, [isReady, state]);

  const allLessons = useMemo(() => mergeLessonCatalog(lessons, state.customLessons), [lessons, state.customLessons]);
  const selectedLesson = allLessons.find((lesson) => lesson.id === state.progress.lessonId) ?? allLessons[0];
  const selectedTerm = (selectedLesson?.unit === 2 ? 2 : 1) satisfies Term;
  const eligibleLessons = useMemo(() => getEligibleLessons(allLessons, state.progress), [allLessons, state.progress]);
  const eligibleWords = useMemo(
    () => getEligibleWords(allLessons, state.customWords, state.progress, companionWords),
    [allLessons, companionWords, state.customWords, state.progress],
  );
  const practiceItems = useMemo(() => generatePractice(allLessons, state, targetCount, companionWords), [allLessons, companionWords, state]);
  const allKnownWords = useMemo(() => {
    const byId = new Map([...allLessons.flatMap((lesson) => lesson.words), ...state.customWords].map((word) => [word.id, word]));
    for (const word of eligibleWords) {
      byId.set(word.id, word);
    }
    return [...byId.values()];
  }, [allLessons, eligibleWords, state.customWords]);
  const wordById = useMemo(() => new Map(allKnownWords.map((word) => [word.id, word])), [allKnownWords]);

  const stats = useMemo(() => {
    const uniqueChars = Array.from(new Set(eligibleWords.flatMap((word) => word.chars)));
    const reviewedChars = uniqueChars.filter((char) => state.charStats[char]?.attempts > 0);
    const masteredChars = uniqueChars.filter((char) => isMasteredChar(state.charStats[char]));
    const reviewedWords = eligibleWords.filter((word) => state.wordStats[word.id]?.attempts > 0);
    const masteredWords = eligibleWords.filter((word) => isMasteredWord(word, state));
    const wrongWords = eligibleWords.filter((word) => {
      const stat = state.wordStats[word.id];
      return stat && stat.mistakes > 0 && !isMasteredWord(word, state);
    });
    const totalAttempts = eligibleWords.reduce((sum, word) => sum + (state.wordStats[word.id]?.attempts ?? 0), 0);
    const totalMistakes = eligibleWords.reduce((sum, word) => sum + (state.wordStats[word.id]?.mistakes ?? 0), 0);
    const todayLogs = state.logs.filter((log) => sameLocalDay(log.date));

    return {
      uniqueChars,
      totalChars: uniqueChars.length,
      reviewedChars: reviewedChars.length,
      masteredChars: masteredChars.length,
      pendingChars: uniqueChars.length - reviewedChars.length,
      totalWords: eligibleWords.length,
      reviewedWords: reviewedWords.length,
      masteredWords: masteredWords.length,
      wrongWords: wrongWords.length,
      totalAttempts,
      totalMistakes,
      accuracy: totalAttempts > 0 ? Math.round(((totalAttempts - totalMistakes) / totalAttempts) * 100) : 0,
      todayPracticeCount: todayLogs.reduce((sum, log) => sum + log.wordIds.length, 0),
      todayWrongCount: todayLogs.reduce((sum, log) => sum + logWrongCharCount(log), 0),
    };
  }, [eligibleWords, state.charStats, state.logs, state.wordStats]);

  const wordsByGrade = useMemo(() => {
    return eligibleWords.reduce<Record<Grade, number>>(
      (acc, word) => {
        acc[word.grade] += 1;
        return acc;
      },
      { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    );
  }, [eligibleWords]);

  const categoryStats = useMemo(
    () =>
      categoryOptions.map((category) => {
        const words = eligibleWords.filter((word) => word.category === category);
        const reviewed = words.filter((word) => state.wordStats[word.id]?.attempts > 0).length;
        const wrong = words.filter((word) => {
          const stat = state.wordStats[word.id];
          return stat && stat.mistakes > 0 && !isMasteredWord(word, state);
        }).length;
        return { category, total: words.length, reviewed, wrong };
      }),
    [eligibleWords, state],
  );

  const troubleWords = useMemo(
    () =>
      eligibleWords
        .map((word) => ({ word, stat: state.wordStats[word.id] }))
        .filter((item) => item.stat && item.stat.mistakes > 0 && !isMasteredWord(item.word, state))
        .sort((a, b) => (b.stat?.mistakes ?? 0) - (a.stat?.mistakes ?? 0) || (b.stat?.attempts ?? 0) - (a.stat?.attempts ?? 0))
        .slice(0, 8),
    [eligibleWords, state],
  );

  const troubleChars = useMemo(
    () =>
      stats.uniqueChars
        .map((char) => ({ char, stat: state.charStats[char] }))
        .filter((item) => item.stat && item.stat.mistakes > 0 && !isMasteredChar(item.stat))
        .sort((a, b) => (b.stat?.mistakes ?? 0) - (a.stat?.mistakes ?? 0) || (b.stat?.attempts ?? 0) - (a.stat?.attempts ?? 0))
        .slice(0, 18),
    [state.charStats, stats.uniqueChars],
  );

  const setProgressGrade = (grade: Grade) => {
    const firstLesson = allLessons.find((lesson) => lesson.grade === grade) ?? allLessons[0];
    setState((current) => ({
      ...current,
      progress: { grade, lessonId: firstLesson.id },
    }));
    setShowAnswers(false);
    setWrongCharKeys(new Set());
  };

  const setProgressTerm = (term: Term) => {
    const firstLesson = allLessons.find((lesson) => lesson.grade === state.progress.grade && lesson.unit === term);
    if (!firstLesson) {
      return;
    }
    setState((current) => ({
      ...current,
      progress: { grade: firstLesson.grade, lessonId: firstLesson.id },
    }));
    setShowAnswers(false);
    setWrongCharKeys(new Set());
  };

  const setProgressLesson = (lessonId: string) => {
    const lesson = allLessons.find((candidate) => candidate.id === lessonId);
    if (!lesson) {
      return;
    }
    setState((current) => ({
      ...current,
      progress: { grade: lesson.grade, lessonId },
    }));
    setShowAnswers(false);
    setWrongCharKeys(new Set());
  };

  const regenerate = () => {
    setState((current) => ({ ...current }));
    setShowAnswers(false);
    setWrongCharKeys(new Set());
  };

  const toggleWrongChar = (wordId: string, char: string) => {
    const key = charReviewKey(wordId, char);
    setWrongCharKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const saveReview = () => {
    setState((current) => applyReviewResult(current, practiceItems, wrongCharKeys));
    setSavedMessage(`已记录 ${practiceItems.length} 个词，其中 ${wrongCharKeys.size} 个字需要回炉。`);
    setTimeout(() => setSavedMessage(""), 2400);
    setShowAnswers(false);
    setWrongCharKeys(new Set());
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const imported = JSON.parse(await file.text()) as AppState;
      setState(normalizeState(imported, state.progress));
      setSavedMessage("已导入备份。");
    } catch {
      setSavedMessage("导入失败，请检查 JSON 文件。");
    } finally {
      event.target.value = "";
    }
  };

  const resetPracticeHistory = () => {
    setState((current) => ({
      ...current,
      wordStats: {},
      charStats: {},
      logs: [],
    }));
    setWrongCharKeys(new Set());
    setShowAnswers(false);
    setSavedMessage("练习记录已清空，词库保留。");
  };

  const sheet = selectedLesson ? (
    <PracticeSheet
      items={practiceItems}
      selectedLesson={selectedLesson}
      showAnswers={showAnswers}
      state={state}
      toggleWrongChar={toggleWrongChar}
      wrongCharKeys={wrongCharKeys}
    />
  ) : null;

  if (loadError) {
    return (
      <main className="app-shell">
        <section className="empty-state">
          <h2>数据库加载失败</h2>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!isReady || !selectedLesson || !sheet) {
    return (
      <main className="app-shell">
        <section className="empty-state">
          <h2>正在加载词库</h2>
          <p>从 SQLite 读取教材数据和学习记录。</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header no-print">
        <div className="brand-block">
          <div className="seal" aria-hidden="true">
            字
          </div>
          <div>
            <h1>字趣</h1>
            <p>上海小学五年制默写助手</p>
          </div>
        </div>
        <nav className="mode-tabs" aria-label="页面切换">
          <button className={viewMode === "student" ? "mode-tab active" : "mode-tab"} type="button" onClick={() => setViewMode("student")}>
            <Home size={17} aria-hidden="true" />
            学生首页
          </button>
          <button className={viewMode === "parent" ? "mode-tab active" : "mode-tab"} type="button" onClick={() => setViewMode("parent")}>
            <BarChart3 size={17} aria-hidden="true" />
            家长后台
          </button>
        </nav>
      </header>

      {viewMode === "student" ? (
        <StudentView
          accuracy={stats.accuracy}
          masteredChars={stats.masteredChars}
          masteredWords={stats.masteredWords}
          practiceItems={practiceItems}
          reviewedChars={stats.reviewedChars}
          reviewedWords={stats.reviewedWords}
          saveReview={saveReview}
          selectedLesson={selectedLesson}
          sheet={sheet}
          showAnswers={showAnswers}
          setShowAnswers={setShowAnswers}
          stats={stats}
          regenerate={regenerate}
          wrongCharKeys={wrongCharKeys}
        />
      ) : (
        <ParentDashboard
          allLessons={allLessons}
          builtInLessonCount={catalogInfo.builtInLessonCount}
          builtInWordCount={catalogInfo.builtInWordCount}
          categoryStats={categoryStats}
          eligibleLessons={eligibleLessons}
          eligibleWords={eligibleWords}
          importBackup={importBackup}
          resetPracticeHistory={resetPracticeHistory}
          selectedLesson={selectedLesson}
          setProgressGrade={setProgressGrade}
          setProgressLesson={setProgressLesson}
          setProgressTerm={setProgressTerm}
          state={state}
          stats={stats}
          selectedTerm={selectedTerm}
          troubleChars={troubleChars}
          troubleWords={troubleWords}
          wordById={wordById}
          wordsByGrade={wordsByGrade}
        />
      )}

      {savedMessage ? <div className="toast no-print">{savedMessage}</div> : null}
    </main>
  );
}

function StudentView({
  accuracy,
  masteredChars,
  masteredWords,
  practiceItems,
  reviewedChars,
  reviewedWords,
  saveReview,
  selectedLesson,
  sheet,
  showAnswers,
  setShowAnswers,
  stats,
  regenerate,
  wrongCharKeys,
}: {
  accuracy: number;
  masteredChars: number;
  masteredWords: number;
  practiceItems: PracticeItem[];
  reviewedChars: number;
  reviewedWords: number;
  saveReview: () => void;
  selectedLesson: Lesson;
  sheet: ReactElement;
  showAnswers: boolean;
  setShowAnswers: (value: boolean | ((current: boolean) => boolean)) => void;
  stats: DashboardStats;
  regenerate: () => void;
  wrongCharKeys: Set<string>;
}) {
  const hasPractice = practiceItems.length > 0;

  return (
    <section className="student-layout">
      <div className="top-strip no-print">
        <div>
          <p className="eyebrow">学生首页</p>
          <h2>{lessonLabel(selectedLesson)}</h2>
        </div>
        {hasPractice ? (
          <div className="toolbar">
            <button type="button" onClick={regenerate} title="重新生成">
              <RefreshCw size={17} aria-hidden="true" />
              换一组
            </button>
            <button type="button" onClick={() => window.print()} title="打印">
              <Printer size={17} aria-hidden="true" />
              打印
            </button>
            <button className="primary" type="button" onClick={() => setShowAnswers((value) => !value)}>
              <FileText size={17} aria-hidden="true" />
              {showAnswers ? "隐藏答案" : "显示答案"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="stat-band no-print">
        <Metric label="已学汉字" value={stats.totalChars} />
        <Metric label="已复习汉字" value={`${reviewedChars}/${stats.totalChars}`} />
        <Metric label="掌握汉字" value={masteredChars} />
        <Metric label="正确率" value={stats.totalAttempts > 0 ? `${accuracy}%` : "未开始"} />
      </div>

      <section className="student-status no-print">
        <div className="progress-summary">
          <div>
            <p className="eyebrow">我的掌握情况</p>
            <h3>{stats.reviewedChars === 0 ? "从今天开始积累" : `已经复习 ${stats.reviewedChars} 个生字`}</h3>
          </div>
          <div className="progress-stack">
            <ProgressBar label="生字复习" value={reviewedChars} total={stats.totalChars} />
            <ProgressBar label="词语复习" value={reviewedWords} total={stats.totalWords} />
            <ProgressBar label="连续掌握" value={masteredWords} total={stats.totalWords} />
          </div>
        </div>
        <div className="today-card">
          <span>今日</span>
          <strong>{stats.todayPracticeCount || practiceItems.length}</strong>
          <small>个词语</small>
          <b>{stats.todayWrongCount} 个错字记录</b>
        </div>
      </section>

      {hasPractice ? (
        sheet
      ) : (
        <section className="done-card no-print">
          <p className="eyebrow">今日状态</p>
          <h3>这部分暂时不用默写</h3>
          <p>当前范围内没有需要回炉或巩固的字词。</p>
        </section>
      )}

      {hasPractice && showAnswers ? (
        <div className="review-bar no-print">
          <div>
            <strong>{wrongCharKeys.size}</strong>
            <span>个字已标记错误</span>
          </div>
          <button className="primary" type="button" onClick={saveReview}>
            <Check size={17} aria-hidden="true" />
            保存本次核对
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ParentDashboard({
  allLessons,
  builtInLessonCount,
  builtInWordCount,
  categoryStats,
  eligibleLessons,
  eligibleWords,
  importBackup,
  resetPracticeHistory,
  selectedLesson,
  selectedTerm,
  setProgressGrade,
  setProgressLesson,
  setProgressTerm,
  state,
  stats,
  troubleChars,
  troubleWords,
  wordById,
  wordsByGrade,
}: {
  allLessons: Lesson[];
  builtInLessonCount: number;
  builtInWordCount: number;
  categoryStats: Array<{ category: CharacterCategory; total: number; reviewed: number; wrong: number }>;
  eligibleLessons: Lesson[];
  eligibleWords: DictationWord[];
  importBackup: (event: ChangeEvent<HTMLInputElement>) => void;
  resetPracticeHistory: () => void;
  selectedLesson: Lesson;
  selectedTerm: Term;
  setProgressGrade: (grade: Grade) => void;
  setProgressLesson: (lessonId: string) => void;
  setProgressTerm: (term: Term) => void;
  state: AppState;
  stats: DashboardStats;
  troubleChars: Array<{ char: string; stat: { attempts: number; mistakes: number; streak?: number; lastReviewedAt?: string } | undefined }>;
  troubleWords: Array<{ word: DictationWord; stat: { attempts: number; mistakes: number; streak: number; lastReviewedAt?: string } | undefined }>;
  wordById: Map<string, DictationWord>;
  wordsByGrade: Record<Grade, number>;
}) {
  return (
    <section className="parent-layout">
      <div className="top-strip no-print">
        <div>
          <p className="eyebrow">家长后台</p>
          <h2>学习数据总览</h2>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => exportState(state)} title="导出备份">
            <Download size={17} aria-hidden="true" />
            导出
          </button>
          <label className="file-button" title="导入备份">
            <Upload size={17} aria-hidden="true" />
            导入
            <input accept="application/json" type="file" onChange={importBackup} />
          </label>
        </div>
      </div>

      <div className="stat-band parent-metrics no-print">
        <Metric label="当前已学汉字" value={stats.totalChars} />
        <Metric label="已复习汉字" value={`${stats.reviewedChars}/${stats.totalChars}`} />
        <Metric label="待覆盖汉字" value={stats.pendingChars} />
        <Metric label="已学词语" value={stats.totalWords} />
        <Metric label="已复习词语" value={`${stats.reviewedWords}/${stats.totalWords}`} />
        <Metric label="掌握词语" value={stats.masteredWords} />
        <Metric label="需关注词语" value={stats.wrongWords} />
        <Metric label="累计正确率" value={stats.totalAttempts > 0 ? `${stats.accuracy}%` : "未开始"} />
      </div>

      <section className="parent-grid no-print">
        <div className="panel wide-panel">
          <div className="panel-title">
            <BookOpen size={18} aria-hidden="true" />
            <span>学习进度</span>
          </div>
          <div className="grade-grid" role="group" aria-label="选择年级">
            {([1, 2, 3, 4, 5] as Grade[]).map((grade) => (
              <button
                className={state.progress.grade === grade ? "segmented active" : "segmented"}
                key={grade}
                type="button"
                onClick={() => setProgressGrade(grade)}
              >
                {grade}年级
              </button>
            ))}
          </div>
          <div className="term-grid" role="group" aria-label="选择册别">
            {termOptions.map((term) => (
              <button
                className={selectedTerm === term.value ? "segmented active" : "segmented"}
                key={term.value}
                type="button"
                onClick={() => setProgressTerm(term.value)}
              >
                {term.label}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="lesson-select">
            学到哪一课
          </label>
          <select id="lesson-select" value={state.progress.lessonId} onChange={(event) => setProgressLesson(event.target.value)}>
            {allLessons
              .filter((lesson) => lesson.grade === state.progress.grade && lesson.unit === selectedTerm)
              .map((lesson) => (
                <option key={lesson.id} value={lesson.id}>
                  {lessonNumberLabel(lesson)}
                </option>
              ))}
          </select>
          <div className="scope-line">
            <span>已纳入 {eligibleLessons.length} 课</span>
            <span>{lessonLabel(selectedLesson)}</span>
          </div>
        </div>

        <div className="panel data-status">
          <div className="panel-title">
            <FileText size={18} aria-hidden="true" />
            <span>教材数据状态</span>
          </div>
          <div className="status-callout">
            <strong>已内置统编版 1-5 年级上下册词库</strong>
            <span>
              内置：{builtInLessonCount} 课 / {builtInWordCount} 个词条。
            </span>
          </div>
          <p className="hint">这批数据来自统编版 PDF 附录中的识字表、写字表、词语表，并会逐步补充语文园地中的词语。</p>
        </div>

        <div className="panel">
          <div className="panel-title">
            <BarChart3 size={18} aria-hidden="true" />
            <span>覆盖情况</span>
          </div>
          <ProgressBar label="生字已复习" value={stats.reviewedChars} total={stats.totalChars} />
          <ProgressBar label="词语已复习" value={stats.reviewedWords} total={stats.totalWords} />
          <ProgressBar label="汉字已掌握" value={stats.masteredChars} total={stats.totalChars} />
        </div>

        <div className="panel">
          <div className="panel-title">
            <X size={18} aria-hidden="true" />
            <span>高频错误</span>
          </div>
          <div className="trouble-list">
            {troubleWords.length === 0 ? (
              <p className="hint">还没有错词记录。</p>
            ) : (
              troubleWords.map(({ word, stat }) => (
                <div className="trouble-item" key={word.id}>
                  <div>
                    <strong>{word.text}</strong>
                    <span>{word.pinyin}</span>
                  </div>
                  <b>{stat?.mistakes ?? 0} 次</b>
                </div>
              ))
            )}
          </div>
          {troubleChars.length > 0 ? (
            <div className="char-chips">
              {troubleChars.map(({ char, stat }) => (
                <span key={char}>
                  {char}
                  <b>{stat?.mistakes}</b>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="panel-title">
            <BookOpen size={18} aria-hidden="true" />
            <span>按年级词库</span>
          </div>
          <div className="grade-bars">
            {([1, 2, 3, 4, 5] as Grade[]).map((grade) => (
              <ProgressBar key={grade} label={gradeNames[grade]} value={wordsByGrade[grade]} total={Math.max(1, eligibleWords.length)} countOnly />
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <FileText size={18} aria-hidden="true" />
            <span>字类覆盖</span>
          </div>
          <div className="grade-bars">
            {categoryStats.map((item) => (
              <ProgressBar key={item.category} label={`${item.category}字`} value={item.reviewed} total={item.total} trailing={`${item.wrong} 错`} />
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <History size={18} aria-hidden="true" />
            <span>最近记录</span>
          </div>
          <div className="log-list">
            {state.logs.length === 0 ? (
              <p className="hint">保存一次核对后，这里会显示最近练习。</p>
            ) : (
              state.logs.slice(0, 7).map((log) => (
                <div className="log-item" key={log.id}>
                  <span>{formatDate(log.date)}</span>
                  <strong>{logWrongCharCount(log)} 个错字</strong>
                  <small>{logWrongText(log, wordById) || "全对"}</small>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <Settings2 size={18} aria-hidden="true" />
            <span>数据维护</span>
          </div>
          <div className="action-row wrap">
            <button type="button" onClick={() => exportState(state)} title="导出备份">
              <Download size={16} aria-hidden="true" />
              导出
            </button>
            <label className="file-button" title="导入备份">
              <Upload size={16} aria-hidden="true" />
              导入
              <input accept="application/json" type="file" onChange={importBackup} />
            </label>
            <button type="button" onClick={resetPracticeHistory} title="清空练习记录">
              <RotateCcw size={16} aria-hidden="true" />
              清空记录
            </button>
          </div>
        </div>
      </section>
    </section>
  );
}

function PracticeSheet({
  items,
  selectedLesson,
  showAnswers,
  state,
  toggleWrongChar,
  wrongCharKeys,
}: {
  items: PracticeItem[];
  selectedLesson: Lesson;
  showAnswers: boolean;
  state: AppState;
  toggleWrongChar: (wordId: string, char: string) => void;
  wrongCharKeys: Set<string>;
}) {
  return (
    <div className="sheet">
      <header className="sheet-head">
        <div>
          <p>字趣 · 语文字词默写</p>
          <h2>{gradeNames[state.progress.grade]}每日练习</h2>
        </div>
        <dl>
          <div>
            <dt>日期</dt>
            <dd>{todayText()}</dd>
          </div>
          <div>
            <dt>范围</dt>
            <dd>一年级至{lessonLabel(selectedLesson)}</dd>
          </div>
        </dl>
      </header>

      <div className="dictation-grid">
        {items.map((item, index) => (
          <DictationCard
            item={item}
            index={index}
            key={item.word.id}
            showAnswers={showAnswers}
            toggleWrongChar={toggleWrongChar}
            wrongCharKeys={wrongCharKeys}
          />
        ))}
      </div>

      <footer className="sheet-foot">
        <span>默写用时：______ 分钟</span>
        <span>错字：______ 个</span>
        <span>家长签名：__________</span>
      </footer>
    </div>
  );
}

function DictationCard({
  item,
  index,
  showAnswers,
  toggleWrongChar,
  wrongCharKeys,
}: {
  item: PracticeItem;
  index: number;
  showAnswers: boolean;
  toggleWrongChar: (wordId: string, char: string) => void;
  wrongCharKeys: Set<string>;
}) {
  const chars = Array.from(item.word.text).filter((char) => /\p{Script=Han}/u.test(char));
  const syllables = item.word.pinyin.split(/\s+/).filter(Boolean);
  const cellCount = Math.max(chars.length, syllables.length, 2);
  const wrongChars = chars.filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
  const isWrong = showAnswers && wrongChars.length > 0;

  return (
    <article className={isWrong ? "word-card wrong" : "word-card"}>
      <div className="card-top">
        <div className="number">{index + 1}</div>
        <div className="prompt">
          <span className="origin">
            {gradeNames[item.word.grade]} · {item.word.lessonTitle} · {item.word.category}字
          </span>
          <span className="reason no-print">{item.reasons.join(" / ")}</span>
        </div>
        {showAnswers ? <span className={isWrong ? "card-status active no-print" : "card-status no-print"}>{isWrong ? `${wrongChars.length}错` : "全对"}</span> : null}
      </div>
      <div className="mizige-group" aria-label="默写位置">
        {Array.from({ length: cellCount }).map((_, cellIndex) => {
          const char = chars[cellIndex];
          const key = char ? charReviewKey(item.word.id, char) : "";
          const isCharWrong = Boolean(char && wrongCharKeys.has(key));
          return (
            <div className={isCharWrong ? "mizige-wrap char-wrong" : "mizige-wrap"} key={`${item.word.id}-${cellIndex}`}>
              <span className="cell-pinyin">{syllables[cellIndex] ?? (cellIndex === 0 ? item.word.pinyin : "")}</span>
              <div className="mizige-cell">
                <i className="mizige-line mizige-v" aria-hidden="true" />
                <i className="mizige-line mizige-h" aria-hidden="true" />
                <i className="mizige-line mizige-d1" aria-hidden="true" />
                <i className="mizige-line mizige-d2" aria-hidden="true" />
                {showAnswers ? <b className="answer-char">{char ?? ""}</b> : null}
              </div>
              {showAnswers && char ? (
                <button
                  className={isCharWrong ? "char-mark-button active no-print" : "char-mark-button no-print"}
                  type="button"
                  onClick={() => toggleWrongChar(item.word.id, char)}
                  title={`标记“${char}”${isCharWrong ? "已写对" : "写错"}`}
                >
                  {isCharWrong ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                  {char}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ProgressBar({
  countOnly = false,
  label,
  total,
  trailing,
  value,
}: {
  countOnly?: boolean;
  label: string;
  total: number;
  trailing?: string;
  value: number;
}) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar-track" aria-hidden="true">
        <i style={{ width: `${countOnly ? Math.min(100, percent * 3) : percent}%` }} />
      </div>
      <b>{trailing ?? (countOnly ? value : `${value}/${total}`)}</b>
    </div>
  );
}

export default App;
