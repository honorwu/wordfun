import {
  BarChart3,
  BookOpen,
  Check,
  Download,
  FileText,
  Flag,
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
import { flushSync } from "react-dom";
import type { ChangeEvent, ReactElement } from "react";
import { gradeNames } from "./data/metadata";
import { fetchAppData, saveRemoteState } from "./lib/api";
import {
  applyReviewResult,
  charReviewKey,
  generateCurrentLessonPractice,
  generateScreeningPractice,
  generateTermReviewPractice,
  getEligibleLessons,
  getEligibleWords,
  getScreeningTargetChars,
  isMasteredChar,
  isMasteredWord,
  isPendingScreeningMistakeChar,
  isReviewedScreeningChar,
  reviewCharsForWord,
  termMistakeReason,
} from "./lib/scheduler";
import { sentencePromptForWord } from "./lib/sentenceHints";
import { createDefaultState, exportState, normalizeState } from "./lib/storage";
import type { AppState, CharacterCategory, CompanionDictionary, DictationWord, Grade, Lesson, PracticeItem, PrintLog, UnsuitableWordFlag } from "./types";

const targetCount = 20;

const categoryOptions: CharacterCategory[] = ["一类", "二类"];
const termOptions = [
  { label: "上册", value: 1 },
  { label: "下册", value: 2 },
] as const;

type Term = (typeof termOptions)[number]["value"];

type ViewMode = "student" | "parent";
type PracticeMode = PrintLog["practiceMode"];

type DashboardStats = {
  accuracy: number;
  historyPendingChars: number;
  historyReviewedChars: number;
  historyReviewPercent: number;
  historyTotalChars: number;
  masteredChars: number;
  masteredWords: number;
  pendingWrongChars: number;
  reviewedChars: number;
  reviewedWords: number;
  todayPracticeCount: number;
  todayWrongCount: number;
  totalAttempts: number;
  totalChars: number;
  totalMistakes: number;
  totalWords: number;
  unsuitableWords: number;
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

const todayText = (date = new Date()) =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).format(date);

const fileDateText = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const termLabel = (term: number) => (term === 2 ? "下册" : "上册");

const lessonNumberLabel = (lesson: Lesson) => (lesson.title.startsWith("语文园地") ? lesson.title : `第${lesson.number}课 ${lesson.title}`);

const lessonLabel = (lesson: Lesson) => `${gradeNames[lesson.grade]}${termLabel(lesson.unit)} ${lessonNumberLabel(lesson)}`;

const practiceModeLabel = (mode: PracticeMode) => (mode === "lesson" ? "本课词语默写" : mode === "term" ? "期末复习" : "历史生字筛查");

const practiceRangeLabel = (mode: PracticeMode, lesson: Lesson) => {
  if (mode === "lesson") {
    return lessonLabel(lesson);
  }
  if (mode === "term") {
    return `${gradeNames[lesson.grade]}${termLabel(lesson.unit)} 词语表`;
  }
  return `一年级至上一课，不含${lessonNumberLabel(lesson)}`;
};

const cleanFileNamePart = (text: string) => text.replace(/[\\/:*?"<>|]/gu, "").replace(/\s+/gu, "");

const printTitle = (mode: PracticeMode, lesson: Lesson) =>
  ["字趣", fileDateText(), practiceModeLabel(mode), lessonLabel(lesson)].map(cleanFileNamePart).filter(Boolean).join("-");

const printLogTitle = (log: PrintLog) => ["字趣", log.localDate, log.title, log.lessonLabel].map(cleanFileNamePart).filter(Boolean).join("-");

const sameLocalDay = (date: string) => new Date(date).toDateString() === new Date().toDateString();

const samePrintedSheet = (left: PrintLog, right: PrintLog) =>
  left.localDate === right.localDate &&
  left.practiceMode === right.practiceMode &&
  left.lessonId === right.lessonId &&
  left.items.length === right.items.length &&
  left.items.every((item, index) => {
    const other = right.items[index];
    return other && item.word.id === other.word.id && item.word.text === other.word.text;
  });

const addPrintLogToState = (current: AppState, nextLog: PrintLog): AppState => {
  const existing = current.printLogs.find((log) => samePrintedSheet(log, nextLog));
  if (existing) {
    return {
      ...current,
      printLogs: [{ ...existing, date: nextLog.date }, ...current.printLogs.filter((log) => log.id !== existing.id)].slice(0, 180),
    };
  }
  return {
    ...current,
    printLogs: [nextLog, ...current.printLogs].slice(0, 180),
  };
};

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
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("screening");
  const [screeningSeed, setScreeningSeed] = useState(0);
  const [showAnswers, setShowAnswers] = useState(false);
  const [wrongCharKeys, setWrongCharKeys] = useState<Set<string>>(() => new Set());
  const [unsuitableWordIds, setUnsuitableWordIds] = useState<Set<string>>(() => new Set());
  const [savedMessage, setSavedMessage] = useState("");
  const [selectedPrintLogId, setSelectedPrintLogId] = useState("");

  const resetReviewMarks = () => {
    setWrongCharKeys(new Set());
    setUnsuitableWordIds(new Set());
  };

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
  const practiceItems = useMemo(
    () =>
      practiceMode === "lesson"
        ? generateCurrentLessonPractice(allLessons, state, companionWords)
        : practiceMode === "term"
          ? generateTermReviewPractice(allLessons, state)
        : generateScreeningPractice(allLessons, state, targetCount, companionWords, screeningSeed),
    [allLessons, companionWords, practiceMode, screeningSeed, state],
  );
  const allKnownWords = useMemo(() => {
    const byId = new Map(
      [...allLessons.flatMap((lesson) => [...lesson.words, ...(lesson.textbookWords ?? [])]), ...state.customWords].map((word) => [word.id, word]),
    );
    for (const word of eligibleWords) {
      byId.set(word.id, word);
    }
    return [...byId.values()];
  }, [allLessons, eligibleWords, state.customWords]);
  const wordById = useMemo(() => new Map(allKnownWords.map((word) => [word.id, word])), [allKnownWords]);
  const selectedPrintLog = useMemo(
    () => state.printLogs.find((log) => log.id === selectedPrintLogId),
    [selectedPrintLogId, state.printLogs],
  );

  const stats = useMemo(() => {
    const uniqueChars = Array.from(new Set(eligibleWords.flatMap((word) => word.chars)));
    const historyChars = getScreeningTargetChars(allLessons, state.customWords, state.progress);
    const reviewedChars = uniqueChars.filter((char) => state.charStats[char]?.attempts > 0);
    const historyReviewedChars = historyChars.filter((char) => isReviewedScreeningChar(state.charStats[char]));
    const masteredChars = uniqueChars.filter((char) => isMasteredChar(state.charStats[char]));
    const reviewedWords = eligibleWords.filter((word) => state.wordStats[word.id]?.attempts > 0);
    const masteredWords = eligibleWords.filter((word) => isMasteredWord(word, state));
    const pendingWrongChars = historyChars.filter((char) => isPendingScreeningMistakeChar(state.charStats[char]));
    const wrongWords = eligibleWords.filter((word) => {
      const stat = state.wordStats[word.id];
      return stat && stat.mistakes > 0 && !isMasteredWord(word, state);
    });
    const totalAttempts = eligibleWords.reduce((sum, word) => sum + (state.wordStats[word.id]?.attempts ?? 0), 0);
    const totalMistakes = eligibleWords.reduce((sum, word) => sum + (state.wordStats[word.id]?.mistakes ?? 0), 0);
    const todayLogs = state.logs.filter((log) => sameLocalDay(log.date));

    return {
      uniqueChars,
      historyTotalChars: historyChars.length,
      historyReviewedChars: historyReviewedChars.length,
      historyPendingChars: historyChars.length - historyReviewedChars.length,
      historyReviewPercent: historyChars.length > 0 ? Math.round((historyReviewedChars.length / historyChars.length) * 100) : 0,
      totalChars: uniqueChars.length,
      reviewedChars: reviewedChars.length,
      masteredChars: masteredChars.length,
      totalWords: eligibleWords.length,
      reviewedWords: reviewedWords.length,
      masteredWords: masteredWords.length,
      wrongWords: wrongWords.length,
      totalAttempts,
      totalMistakes,
      pendingWrongChars: pendingWrongChars.length,
      accuracy: totalAttempts > 0 ? Math.round(((totalAttempts - totalMistakes) / totalAttempts) * 100) : 0,
      todayPracticeCount: todayLogs.reduce((sum, log) => sum + log.wordIds.length, 0),
      todayWrongCount: todayLogs.reduce((sum, log) => sum + logWrongCharCount(log), 0),
      unsuitableWords: Object.keys(state.unsuitableWords).length,
    };
  }, [allLessons, eligibleWords, state.charStats, state.customWords, state.logs, state.progress, state.unsuitableWords, state.wordStats]);

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

  const unsuitableWordList = useMemo(
    () => Object.values(state.unsuitableWords).sort((a, b) => b.lastFlaggedAt.localeCompare(a.lastFlaggedAt) || a.text.localeCompare(b.text)),
    [state.unsuitableWords],
  );

  const setProgressGrade = (grade: Grade) => {
    const firstLesson = allLessons.find((lesson) => lesson.grade === grade) ?? allLessons[0];
    setState((current) => ({
      ...current,
      progress: { grade, lessonId: firstLesson.id },
    }));
    setShowAnswers(false);
    setScreeningSeed(0);
    resetReviewMarks();
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
    setScreeningSeed(0);
    resetReviewMarks();
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
    setScreeningSeed(0);
    resetReviewMarks();
  };

  const regenerate = () => {
    setScreeningSeed((current) => current + 1);
    setShowAnswers(false);
    resetReviewMarks();
  };

  const recordPrintedSheet = () => {
    if (!selectedLesson || practiceItems.length === 0) {
      return;
    }

    const printedAt = new Date();
    const rangeLabel = practiceRangeLabel(practiceMode, selectedLesson);
    const nextLog: PrintLog = {
      id: crypto.randomUUID(),
      date: printedAt.toISOString(),
      localDate: fileDateText(printedAt),
      practiceMode,
      lessonId: selectedLesson.id,
      lessonLabel: lessonLabel(selectedLesson),
      title: practiceModeLabel(practiceMode),
      rangeLabel,
      items: practiceItems.map((item) => ({
        word: { ...item.word, chars: [...item.word.chars] },
        reasons: [...item.reasons],
      })),
    };

    let nextState: AppState | undefined;
    flushSync(() => {
      setState((current) => {
        nextState = addPrintLogToState(current, nextLog);
        return nextState;
      });
    });
    if (nextState) {
      void saveRemoteState(nextState).catch((error: unknown) => {
        setSavedMessage(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
      });
    }
    setSavedMessage("已加入打印历史。");
    setTimeout(() => setSavedMessage(""), 1800);
  };

  const changePracticeMode = (mode: PracticeMode) => {
    setPracticeMode(mode);
    setScreeningSeed(0);
    setShowAnswers(false);
    resetReviewMarks();
  };

  const toggleWrongChar = (wordId: string, char: string) => {
    const key = charReviewKey(wordId, char);
    setUnsuitableWordIds((current) => {
      if (!current.has(wordId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(wordId);
      return next;
    });
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

  const toggleUnsuitableWord = (word: DictationWord) => {
    const willMark = !unsuitableWordIds.has(word.id);
    setUnsuitableWordIds((current) => {
      const next = new Set(current);
      if (next.has(word.id)) {
        next.delete(word.id);
      } else {
        next.add(word.id);
      }
      return next;
    });
    if (willMark) {
      setWrongCharKeys((current) => {
        const next = new Set(current);
        for (const char of reviewCharsForWord(word)) {
          next.delete(charReviewKey(word.id, char));
        }
        return next;
      });
    }
  };

  const saveReview = () => {
    const reviewedItems = practiceItems.filter((item) => !unsuitableWordIds.has(item.word.id));
    const unsuitableCount = practiceItems.length - reviewedItems.length;
    const wrongCount = reviewedItems.reduce(
      (sum, item) => sum + reviewCharsForWord(item.word).filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))).length,
      0,
    );
    setState((current) => applyReviewResult(current, practiceItems, wrongCharKeys, unsuitableWordIds));
    setSavedMessage(`已记录 ${reviewedItems.length} 个词${unsuitableCount > 0 ? `，跳过 ${unsuitableCount} 个不合适词` : ""}，${wrongCount} 个字需要回炉。`);
    setTimeout(() => setSavedMessage(""), 2400);
    setShowAnswers(false);
    resetReviewMarks();
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
      printLogs: [],
    }));
    setSelectedPrintLogId("");
    setScreeningSeed(0);
    resetReviewMarks();
    setShowAnswers(false);
    setSavedMessage("练习和打印记录已清空，词库保留。");
  };

  const sheet = selectedLesson ? (
    <PracticeSheet
      items={practiceItems}
      practiceMode={practiceMode}
      selectedLesson={selectedLesson}
      showAnswers={showAnswers}
      toggleUnsuitableWord={toggleUnsuitableWord}
      toggleWrongChar={toggleWrongChar}
      unsuitableWordIds={unsuitableWordIds}
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

      {selectedPrintLog ? (
        <PrintHistoryViewer
          log={selectedPrintLog}
          onClose={() => setSelectedPrintLogId("")}
          onSaveReview={(items, historyWrongCharKeys, historyUnsuitableWordIds) => {
            const reviewedItems = items.filter((item) => !historyUnsuitableWordIds.has(item.word.id));
            const unsuitableCount = items.length - reviewedItems.length;
            const wrongCount = reviewedItems.reduce(
              (sum, item) => sum + reviewCharsForWord(item.word).filter((char) => historyWrongCharKeys.has(charReviewKey(item.word.id, char))).length,
              0,
            );
            setState((current) => applyReviewResult(current, items, historyWrongCharKeys, historyUnsuitableWordIds));
            setSavedMessage(`已记录历史题单 ${reviewedItems.length} 个词${unsuitableCount > 0 ? `，跳过 ${unsuitableCount} 个不合适词` : ""}，${wrongCount} 个字需要回炉。`);
            setTimeout(() => setSavedMessage(""), 2400);
          }}
        />
      ) : viewMode === "student" ? (
        <StudentView
          accuracy={stats.accuracy}
          masteredWords={stats.masteredWords}
          practiceItems={practiceItems}
          practiceMode={practiceMode}
          recordPrintedSheet={recordPrintedSheet}
          reviewedWords={stats.reviewedWords}
          saveReview={saveReview}
          selectedLesson={selectedLesson}
          sheet={sheet}
          showAnswers={showAnswers}
          setShowAnswers={setShowAnswers}
          setPracticeMode={changePracticeMode}
          stats={stats}
          regenerate={regenerate}
          unsuitableWordIds={unsuitableWordIds}
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
          openPrintLog={setSelectedPrintLogId}
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
          unsuitableWords={unsuitableWordList}
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
  masteredWords,
  practiceItems,
  practiceMode,
  recordPrintedSheet,
  reviewedWords,
  saveReview,
  selectedLesson,
  sheet,
  showAnswers,
  setShowAnswers,
  setPracticeMode,
  stats,
  regenerate,
  unsuitableWordIds,
  wrongCharKeys,
}: {
  accuracy: number;
  masteredWords: number;
  practiceItems: PracticeItem[];
  practiceMode: PracticeMode;
  recordPrintedSheet: () => void;
  reviewedWords: number;
  saveReview: () => void;
  selectedLesson: Lesson;
  sheet: ReactElement;
  showAnswers: boolean;
  setShowAnswers: (value: boolean | ((current: boolean) => boolean)) => void;
  setPracticeMode: (mode: PracticeMode) => void;
  stats: DashboardStats;
  regenerate: () => void;
  unsuitableWordIds: Set<string>;
  wrongCharKeys: Set<string>;
}) {
  const hasPractice = practiceItems.length > 0;
  const unsuitableCount = practiceItems.filter((item) => unsuitableWordIds.has(item.word.id)).length;
  const termMistakeItems = practiceMode === "term" ? practiceItems.filter((item) => item.reasons.includes(termMistakeReason)) : [];
  const historyReviewText = stats.historyTotalChars > 0 ? `${stats.historyReviewPercent}%` : "无旧课";
  const historyHeadline =
    stats.historyTotalChars === 0
      ? "上一课之前还没有旧字"
      : stats.historyReviewPercent >= 100
        ? `历史回顾已完成${stats.pendingWrongChars > 0 ? `，${stats.pendingWrongChars} 个错字待纠正` : ""}`
        : `历史回顾 ${stats.historyReviewPercent}%`;
  const currentModeName = practiceMode === "lesson" ? "本课复习" : practiceMode === "term" ? "期末复习" : "历史筛查";
  const currentTitle = practiceMode === "term" ? `${gradeNames[selectedLesson.grade]}${termLabel(selectedLesson.unit)} 期末复习` : lessonLabel(selectedLesson);
  const emptyTitle =
    practiceMode === "lesson" ? "本课暂无词语" : practiceMode === "term" ? "本学期词语表暂无词语" : "历史范围暂时不用筛查";
  const emptyDescription =
    practiceMode === "lesson"
      ? "当前课没有可打印的默写词语。"
      : practiceMode === "term"
        ? "当前册没有可用于期末复习的词语表记录。"
        : "当前课之前还没有可筛查的已学字词。";
  const printPracticeSheet = () => {
    recordPrintedSheet();
    const originalTitle = document.title;
    document.title = printTitle(practiceMode, selectedLesson);
    window.print();
    setTimeout(() => {
      document.title = originalTitle;
    }, 0);
  };

  return (
    <section className="student-layout">
      <div className="top-strip no-print">
        <div>
          <p className="eyebrow">{currentModeName}</p>
          <h2>{currentTitle}</h2>
        </div>
        {hasPractice ? (
          <div className="toolbar">
            {practiceMode === "screening" ? (
              <button type="button" onClick={regenerate} title="重新生成">
                <RefreshCw size={17} aria-hidden="true" />
                换一组
              </button>
            ) : null}
            <button type="button" onClick={printPracticeSheet} title="打印">
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

      <div className="practice-switch no-print" role="group" aria-label="选择练习方式">
        <button className={practiceMode === "lesson" ? "segmented active" : "segmented"} type="button" onClick={() => setPracticeMode("lesson")}>
          <BookOpen size={16} aria-hidden="true" />
          本课词语
        </button>
        <button className={practiceMode === "screening" ? "segmented active" : "segmented"} type="button" onClick={() => setPracticeMode("screening")}>
          <History size={16} aria-hidden="true" />
          历史筛查
        </button>
        <button className={practiceMode === "term" ? "segmented active" : "segmented"} type="button" onClick={() => setPracticeMode("term")}>
          <FileText size={16} aria-hidden="true" />
          期末复习
        </button>
      </div>

      <div className="stat-band no-print">
        <Metric label="已学汉字" value={stats.totalChars} />
        <Metric label="历史回顾率" value={historyReviewText} />
        <Metric label="待回顾汉字" value={stats.historyPendingChars} />
        <Metric label="待纠正错字" value={stats.pendingWrongChars} />
        <Metric label="正确率" value={stats.totalAttempts > 0 ? `${accuracy}%` : "未开始"} />
        {practiceMode === "term" ? <Metric label="本学期词语" value={practiceItems.length} /> : null}
        {practiceMode === "term" ? <Metric label="重点错词" value={termMistakeItems.length} /> : null}
      </div>

      <section className="student-status no-print">
        <div className="progress-summary">
          <div>
            <p className="eyebrow">我的掌握情况</p>
            <h3>{historyHeadline}</h3>
          </div>
          <div className="progress-stack">
            <ProgressBar label="历史回顾" value={stats.historyReviewedChars} total={stats.historyTotalChars} trailing={historyReviewText} />
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
        <>
          {practiceMode === "term" ? <TermMistakeFocus items={termMistakeItems} /> : null}
          {sheet}
        </>
      ) : (
        <section className="done-card no-print">
          <p className="eyebrow">今日状态</p>
          <h3>{emptyTitle}</h3>
          <p>{emptyDescription}</p>
        </section>
      )}

      {hasPractice && showAnswers ? (
        <div className="review-bar no-print">
          <div>
            <strong>{wrongCharKeys.size}</strong>
            <span>个字已标记错误</span>
          </div>
          {unsuitableCount > 0 ? (
            <div>
              <strong>{unsuitableCount}</strong>
              <span>个词将跳过记录</span>
            </div>
          ) : null}
          <button className="primary" type="button" onClick={saveReview}>
            <Check size={17} aria-hidden="true" />
            保存本次核对
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TermMistakeFocus({ items }: { items: PracticeItem[] }) {
  return (
    <section className="term-review-focus">
      <div>
        <p className="eyebrow">本学期错词重点</p>
        <h3>{items.length > 0 ? `${items.length} 个词需要重点回看` : "本学期还没有错词记录"}</h3>
      </div>
      {items.length > 0 ? (
        <div className="term-review-chip-list">
          {items.map((item) => (
            <span className="term-review-chip" key={item.word.id}>
              <strong>{item.word.text}</strong>
              <small>
                {item.word.pinyin} · {item.word.lessonTitle}
              </small>
            </span>
          ))}
        </div>
      ) : (
        <p className="hint">完整词语表仍会按课本顺序列在下面。</p>
      )}
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
  openPrintLog,
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
  unsuitableWords,
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
  openPrintLog: (logId: string) => void;
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
  unsuitableWords: UnsuitableWordFlag[];
  wordById: Map<string, DictationWord>;
  wordsByGrade: Record<Grade, number>;
}) {
  const historyReviewText = stats.historyTotalChars > 0 ? `${stats.historyReviewPercent}%` : "无旧课";

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
        <Metric label="历史回顾率" value={historyReviewText} />
        <Metric label="历史待回顾" value={stats.historyPendingChars} />
        <Metric label="待纠正错字" value={stats.pendingWrongChars} />
        <Metric label="已学词语" value={stats.totalWords} />
        <Metric label="已复习词语" value={`${stats.reviewedWords}/${stats.totalWords}`} />
        <Metric label="掌握词语" value={stats.masteredWords} />
        <Metric label="需关注词语" value={stats.wrongWords} />
        <Metric label="需修正词语" value={stats.unsuitableWords} />
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
              内置：{builtInLessonCount} 个课内条目 / {builtInWordCount} 个生字项。
            </span>
          </div>
          <p className="hint">这批数据来自 md 目录中的识字表、写字表、词语表、补组词和古诗词资料；配词只使用表内已有词语。</p>
        </div>

        <div className="panel">
          <div className="panel-title">
            <BarChart3 size={18} aria-hidden="true" />
            <span>覆盖情况</span>
          </div>
          <ProgressBar label="历史回顾" value={stats.historyReviewedChars} total={stats.historyTotalChars} trailing={historyReviewText} />
          <ProgressBar label="生字已复习" value={stats.reviewedChars} total={stats.totalChars} />
          <ProgressBar label="词语已复习" value={stats.reviewedWords} total={stats.totalWords} />
          <ProgressBar label="汉字已掌握" value={stats.masteredChars} total={stats.totalChars} />
        </div>

        <div className="panel">
          <div className="panel-title">
            <Flag size={18} aria-hidden="true" />
            <span>待修正词语</span>
          </div>
          <div className="unsuitable-list">
            {unsuitableWords.length === 0 ? (
              <p className="hint">还没有不合适词语标记。</p>
            ) : (
              unsuitableWords.map((word) => (
                <div className="unsuitable-item" key={word.wordId}>
                  <div>
                    <strong>{word.text}</strong>
                    <span>{word.pinyin || "无拼音"} · {word.lessonTitle || "未知课次"}</span>
                    <small>
                      {formatDate(word.lastFlaggedAt)} · 标记 {word.flaggedCount} 次
                    </small>
                  </div>
                </div>
              ))
            )}
          </div>
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

        <div className="panel wide-panel">
          <div className="panel-title">
            <Printer size={18} aria-hidden="true" />
            <span>打印历史</span>
          </div>
          <div className="print-log-list">
            {state.printLogs.length === 0 ? (
              <p className="hint">打印一次默写纸后，这里会保存当天题单。</p>
            ) : (
              state.printLogs.slice(0, 8).map((log) => (
                <div className="print-log-item" key={log.id}>
                  <div>
                    <strong>{formatDate(log.date)}</strong>
                    <span>
                      {log.title} · {log.items.length} 个词
                    </span>
                    <small>{log.rangeLabel || log.lessonLabel}</small>
                  </div>
                  <button type="button" onClick={() => openPrintLog(log.id)} title="回看打印题单">
                    <FileText size={16} aria-hidden="true" />
                    回看
                  </button>
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

        <div className="panel full-panel">
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
      </section>
    </section>
  );
}

function PrintHistoryViewer({
  log,
  onClose,
  onSaveReview,
}: {
  log: PrintLog;
  onClose: () => void;
  onSaveReview: (items: PracticeItem[], wrongCharKeys: Set<string>, unsuitableWordIds: Set<string>) => void;
}) {
  const [showAnswers, setShowAnswers] = useState(false);
  const [wrongCharKeys, setWrongCharKeys] = useState<Set<string>>(() => new Set());
  const [unsuitableWordIds, setUnsuitableWordIds] = useState<Set<string>>(() => new Set());
  const historyItems: PracticeItem[] = log.items.map((item, index) => ({
    word: item.word,
    score: log.items.length - index,
    reasons: item.reasons.length > 0 ? item.reasons : ["打印历史"],
  }));
  const historyLesson: Lesson = {
    id: log.lessonId,
    grade: historyItems[0]?.word.grade ?? 1,
    unit: 1,
    number: 0,
    title: log.lessonLabel || "打印历史",
    words: historyItems.map((item) => item.word),
  };
  const unsuitableCount = historyItems.filter((item) => unsuitableWordIds.has(item.word.id)).length;

  useEffect(() => {
    setShowAnswers(false);
    setWrongCharKeys(new Set());
    setUnsuitableWordIds(new Set());
  }, [log.id]);

  const printHistoricalSheet = () => {
    const originalTitle = document.title;
    document.title = printLogTitle(log);
    window.print();
    setTimeout(() => {
      document.title = originalTitle;
    }, 0);
  };
  const toggleHistoryWrongChar = (wordId: string, char: string) => {
    const key = charReviewKey(wordId, char);
    setUnsuitableWordIds((current) => {
      if (!current.has(wordId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(wordId);
      return next;
    });
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
  const toggleHistoryUnsuitableWord = (word: DictationWord) => {
    const willMark = !unsuitableWordIds.has(word.id);
    setUnsuitableWordIds((current) => {
      const next = new Set(current);
      if (next.has(word.id)) {
        next.delete(word.id);
      } else {
        next.add(word.id);
      }
      return next;
    });
    if (willMark) {
      setWrongCharKeys((current) => {
        const next = new Set(current);
        for (const char of reviewCharsForWord(word)) {
          next.delete(charReviewKey(word.id, char));
        }
        return next;
      });
    }
  };
  const saveHistoryReview = () => {
    onSaveReview(historyItems, wrongCharKeys, unsuitableWordIds);
    setShowAnswers(false);
    setWrongCharKeys(new Set());
    setUnsuitableWordIds(new Set());
  };

  return (
    <section className="history-viewer">
      <div className="history-viewer-bar no-print">
        <div>
          <p className="eyebrow">打印历史</p>
          <h2>{log.title}</h2>
          <span>
            {formatDate(log.date)} · {log.items.length} 个词 · {log.rangeLabel || log.lessonLabel}
          </span>
        </div>
        <div className="toolbar">
          <button type="button" onClick={onClose} title="关闭回看">
            <X size={17} aria-hidden="true" />
            关闭
          </button>
          <button type="button" onClick={() => setShowAnswers((value) => !value)} title={showAnswers ? "隐藏答案" : "显示答案"}>
            <FileText size={17} aria-hidden="true" />
            {showAnswers ? "隐藏答案" : "显示答案"}
          </button>
          <button className="primary" type="button" onClick={printHistoricalSheet} title="再次打印">
            <Printer size={17} aria-hidden="true" />
            再次打印
          </button>
        </div>
      </div>

      <PracticeSheet
        dateText={todayText(new Date(log.date))}
        items={historyItems}
        practiceMode={log.practiceMode}
        rangeText={log.rangeLabel}
        selectedLesson={historyLesson}
        showAnswers={showAnswers}
        titleText={log.title}
        toggleUnsuitableWord={toggleHistoryUnsuitableWord}
        toggleWrongChar={toggleHistoryWrongChar}
        unsuitableWordIds={unsuitableWordIds}
        wrongCharKeys={wrongCharKeys}
      />

      {showAnswers ? (
        <div className="review-bar no-print">
          <div>
            <strong>{wrongCharKeys.size}</strong>
            <span>个字已标记错误</span>
          </div>
          {unsuitableCount > 0 ? (
            <div>
              <strong>{unsuitableCount}</strong>
              <span>个词将跳过记录</span>
            </div>
          ) : null}
          <button className="primary" type="button" onClick={saveHistoryReview}>
            <Check size={17} aria-hidden="true" />
            保存本次核对
          </button>
        </div>
      ) : null}
    </section>
  );
}

function PracticeSheet({
  dateText,
  items,
  practiceMode,
  rangeText,
  readOnlyAnswers = false,
  selectedLesson,
  showAnswers,
  titleText,
  toggleUnsuitableWord,
  toggleWrongChar,
  unsuitableWordIds,
  wrongCharKeys,
}: {
  dateText?: string;
  items: PracticeItem[];
  practiceMode: PracticeMode;
  rangeText?: string;
  readOnlyAnswers?: boolean;
  selectedLesson: Lesson;
  showAnswers: boolean;
  titleText?: string;
  toggleUnsuitableWord: (word: DictationWord) => void;
  toggleWrongChar: (wordId: string, char: string) => void;
  unsuitableWordIds: Set<string>;
  wrongCharKeys: Set<string>;
}) {
  const sheetTitle = titleText ?? practiceModeLabel(practiceMode);
  const sheetDate = dateText ?? todayText();
  const sheetRange = rangeText ?? practiceRangeLabel(practiceMode, selectedLesson);

  return (
    <div className="sheet">
      <header className="sheet-head">
        <div>
          <p>字趣 · 语文字词默写</p>
          <h2>{sheetTitle}</h2>
        </div>
        <dl>
          <div className="print-only">
            <dt>姓名</dt>
            <dd>________</dd>
          </div>
          <div>
            <dt>日期</dt>
            <dd>{sheetDate}</dd>
          </div>
          <div className="sheet-range">
            <dt>范围</dt>
            <dd>{sheetRange}</dd>
          </div>
        </dl>
      </header>

      <div className="dictation-grid">
        {items.map((item, index) => (
          <DictationCard
            item={item}
            index={index}
            key={item.word.id}
            readOnlyAnswers={readOnlyAnswers}
            showAnswers={showAnswers}
            toggleUnsuitableWord={toggleUnsuitableWord}
            toggleWrongChar={toggleWrongChar}
            unsuitableWordIds={unsuitableWordIds}
            wrongCharKeys={wrongCharKeys}
          />
        ))}
      </div>
    </div>
  );
}

function DictationCard({
  item,
  index,
  readOnlyAnswers = false,
  showAnswers,
  toggleUnsuitableWord,
  toggleWrongChar,
  unsuitableWordIds,
  wrongCharKeys,
}: {
  item: PracticeItem;
  index: number;
  readOnlyAnswers?: boolean;
  showAnswers: boolean;
  toggleUnsuitableWord: (word: DictationWord) => void;
  toggleWrongChar: (wordId: string, char: string) => void;
  unsuitableWordIds: Set<string>;
  wrongCharKeys: Set<string>;
}) {
  const chars = Array.from(item.word.text).filter((char) => /\p{Script=Han}/u.test(char));
  const syllables = item.word.pinyin.split(/\s+/).filter(Boolean);
  const cellCount = Math.max(chars.length, syllables.length, 2);
  const isUnsuitable = showAnswers && unsuitableWordIds.has(item.word.id);
  const wrongChars = isUnsuitable ? [] : chars.filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
  const isWrong = showAnswers && wrongChars.length > 0;
  const isMistakeReview = item.reasons.some((reason) => reason === "错字回炉" || reason === "错题回炉" || reason === termMistakeReason);
  const statusText = isUnsuitable ? "不合适" : isWrong ? `${wrongChars.length}错` : "全对";
  const sentencePrompt = sentencePromptForWord(item.word);
  const cardClassName = [
    "word-card",
    sentencePrompt ? "has-sentence" : "no-sentence",
    cellCount >= 5 ? "long-word" : "",
    isMistakeReview ? "mistake-review" : "",
    isWrong ? "wrong" : "",
    isUnsuitable ? "unsuitable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cardClassName}>
      <div className="card-top">
        <div className="number-wrap">
          <div className="number">{index + 1}</div>
          {isMistakeReview ? (
            <span className="mistake-review-mark" aria-label="之前错过" title="之前错过">
              错
            </span>
          ) : null}
        </div>
        <div className="prompt">
          <span className="origin no-print">
            {gradeNames[item.word.grade]} · {item.word.lessonTitle} · {item.word.category}字
          </span>
          <span className="reason no-print">{item.reasons.join(" / ")}</span>
        </div>
        {showAnswers && !readOnlyAnswers ? (
          <div className="card-actions no-print">
            <span className={isWrong || isUnsuitable ? "card-status active" : "card-status"}>{statusText}</span>
            <button
              className={isUnsuitable ? "unsuitable-button active" : "unsuitable-button"}
              type="button"
              onClick={() => toggleUnsuitableWord(item.word)}
              title={isUnsuitable ? "取消不合适标记" : "标记词语不合适"}
            >
              <Flag size={13} aria-hidden="true" />
              不合适
            </button>
          </div>
        ) : null}
      </div>
      {sentencePrompt ? (
        <p className="sentence-prompt">
          <span className="sentence-label">句子：</span>
          {sentencePrompt}
        </p>
      ) : (
        <p className="sentence-prompt sentence-prompt-missing no-print">缺少已核验例句，暂不打印提示句。</p>
      )}
      <div className="mizige-group" aria-label="默写位置">
        {Array.from({ length: cellCount }).map((_, cellIndex) => {
          const char = chars[cellIndex];
          const key = char ? charReviewKey(item.word.id, char) : "";
          const isCharWrong = Boolean(char && !isUnsuitable && wrongCharKeys.has(key));
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
              {showAnswers && char && !readOnlyAnswers ? (
                <button
                  className={isCharWrong ? "char-mark-button active no-print" : "char-mark-button no-print"}
                  type="button"
                  disabled={isUnsuitable}
                  onClick={() => toggleWrongChar(item.word.id, char)}
                  title={isUnsuitable ? "本词已标记不合适，不记录对错" : `标记“${char}”${isCharWrong ? "已写对" : "写错"}`}
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
