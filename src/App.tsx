import {
  BarChart3,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Eye,
  History,
  Home,
  Printer,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { gradeNames } from "./data/metadata";
import { fetchAppData, saveRemoteState } from "./lib/api";
import {
  addMissedWrongChars,
  applyReviewResult,
  charReviewKey,
  fullDictationCharsForWord,
  generateCurrentLessonPractice,
  generateScreeningPractice,
  getEligibleWords,
  isHistoryCharCoolingDown,
  isMasteredChar,
  isPendingScreeningMistakeChar,
  lessonOrder,
  reviewCharsForWord,
} from "./lib/scheduler";
import type { MissedWrongCharCorrection } from "./lib/scheduler";
import { createDefaultState } from "./lib/storage";
import type { AppState, ClassicalText, CompanionDictionary, DictationWord, Grade, Lesson, PracticeItem, ReviewLog } from "./types";

const historyBatchSize = 20;
const secondPlaybackDelaySeconds = 10;

type ViewMode = "student" | "parent";
type PracticeMode = "lesson" | "history";
type PracticePhase = "dictating" | "reviewing" | "correcting" | "done";
type CorrectionMistake = { char: string; mistakeCount: number; repetitions: number };
type CorrectionItem = { wordId: string; text: string; wrongChars: CorrectionMistake[] };
type PlaybackStage = "idle" | "first" | "waiting" | "second";
type SpeechPlayback = { index: number | null; stage: PlaybackStage; countdown: number };

const idleSpeechPlayback: SpeechPlayback = { index: null, stage: "idle", countdown: 0 };

const termLabel = (term: number) => (term === 2 ? "下册" : "上册");

const lessonNumberLabel = (lesson: Lesson, title = lesson.title) => {
  if (lesson.title.startsWith("语文园地")) return title;
  return Number.isInteger(lesson.number) ? `第${lesson.number}课·${title}` : title;
};

const lessonLabel = (lesson: Lesson, title = lesson.title) => `${gradeNames[lesson.grade]}${termLabel(lesson.unit)} · ${lessonNumberLabel(lesson, title)}`;

type TitleMaskWord = Pick<DictationWord, "text" | "pinyin">;

const hanCharacterCount = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char)).length;

const pinyinSyllables = (pinyin: string) => pinyin
  .split(/\s+/u)
  .map((syllable) => syllable.replace(/[^\p{Letter}]/gu, ""))
  .filter(Boolean);

const pinyinForSubstring = (word: TitleMaskWord, substring: string) => {
  const startIndex = word.text.indexOf(substring);
  if (startIndex < 0) return "";
  const syllables = pinyinSyllables(word.pinyin);
  const startSyllable = hanCharacterCount(word.text.slice(0, startIndex));
  return syllables.slice(startSyllable, startSyllable + hanCharacterCount(substring)).join(" ");
};

export const maskLessonTitle = (title: string, words: readonly TitleMaskWord[]) => {
  const replacements = new Map<string, string>();
  for (const word of words) {
    const text = word.text.trim();
    const pinyin = word.pinyin.trim();
    if (!text || !pinyin) continue;
    if (title.includes(text)) {
      replacements.set(text, pinyin);
      continue;
    }
    if (text.includes(title)) {
      const titlePinyin = pinyinForSubstring(word, title);
      if (titlePinyin) replacements.set(title, titlePinyin);
    }
  }

  let maskedTitle = title;
  for (const [text, pinyin] of [...replacements].sort((left, right) => right[0].length - left[0].length)) {
    maskedTitle = maskedTitle.split(text).join(` ${pinyin} `);
  }

  const pinyinByCharacter = new Map<string, string>();
  for (const word of words) {
    const chars = Array.from(word.text).filter((char) => /\p{Script=Han}/u.test(char));
    const syllables = pinyinSyllables(word.pinyin);
    chars.forEach((char, index) => {
      const syllable = syllables[index];
      if (syllable && !pinyinByCharacter.has(char)) pinyinByCharacter.set(char, syllable);
    });
  }
  maskedTitle = Array.from(maskedTitle)
    .map((char) => pinyinByCharacter.has(char) ? ` ${pinyinByCharacter.get(char)} ` : char)
    .join("");

  return maskedTitle.replace(/\s+/gu, " ").trim();
};

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
  const [correctionItems, setCorrectionItems] = useState<CorrectionItem[]>([]);
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
    () => {
      const catalogWords = allLessons.flatMap((lesson) => [...lesson.words, ...(lesson.textbookWords ?? [])]);
      const resolvedDictationWords = getEligibleWords(allLessons, state.progress, companionWords);
      return new Map([...catalogWords, ...resolvedDictationWords].map((word) => [word.id, word]));
    },
    [allLessons, companionWords, state.progress],
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
    setCorrectionItems([]);
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
      practiceItems.map((item) => {
        const baseReviewChars = hintedWordIds.has(item.word.id)
          ? reviewCharsForWord(item.word)
          : fullDictationCharsForWord(item.word);
        const explicitlyWrongChars = fullDictationCharsForWord(item.word).filter((char) =>
          wrongCharKeys.has(charReviewKey(item.word.id, char)),
        );
        return [item.word.id, Array.from(new Set([...baseReviewChars, ...explicitlyWrongChars]))] as const;
      }),
    );
    const wrongCount = new Set(
      practiceItems.flatMap((item) =>
        (reviewedCharsByWord.get(item.word.id) ?? []).filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))),
      ),
    ).size;
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
    const nextCorrectionItems = practiceItems.flatMap((item) => {
      const wrongChars = fullDictationCharsForWord(item.word).flatMap((char) => {
        if (!wrongCharKeys.has(charReviewKey(item.word.id, char))) return [];
        const mistakeCount = nextState.charStats[char]?.mistakes ?? 1;
        return [{ char, mistakeCount, repetitions: Math.max(2, mistakeCount + 1) }];
      });
      return wrongChars.length > 0 ? [{ wordId: item.word.id, text: item.word.text, wrongChars }] : [];
    });
    setState(nextState);
    setCorrectionItems(nextCorrectionItems);
    setLastResult({ total: practiceItems.length, wrong: wrongCount });
    setWrongCharKeys(new Set());
    setHintedWordIds(new Set());
    setPhase(nextCorrectionItems.length > 0 ? "correcting" : "done");
    setSavedMessage(nextCorrectionItems.length > 0 ? "批改结果已记录，请完成订正" : "批改结果已记录");
    window.setTimeout(() => setSavedMessage(""), 1800);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const supplementHistoryMistakes = (logId: string, corrections: MissedWrongCharCorrection[]) => {
    const previousLog = state.logs.find((log) => log.id === logId);
    const nextState = addMissedWrongChars(state, logId, corrections, allKnownWords);
    const nextLog = nextState.logs.find((log) => log.id === logId);
    const previousKeys = new Set((previousLog?.wrongChars ?? []).map((item) => charReviewKey(item.wordId, item.char)));
    const requestedKeys = new Set(corrections.map((item) => charReviewKey(item.wordId, item.char)));
    const appliedKeys = new Set(
      (nextLog?.wrongChars ?? [])
        .map((item) => charReviewKey(item.wordId, item.char))
        .filter((key) => requestedKeys.has(key) && !previousKeys.has(key)),
    );
    if (appliedKeys.size === 0) {
      setSavedMessage("这次更正没有写入，请刷新后重试");
      window.setTimeout(() => setSavedMessage(""), 2200);
      return 0;
    }
    setState(nextState);
    setSavedMessage(appliedKeys.size === requestedKeys.size
      ? `已在原历史记录中补记 ${appliedKeys.size} 处错字`
      : `已补记 ${appliedKeys.size} 处，另有 ${requestedKeys.size - appliedKeys.size} 处未写入，请刷新核对`);
    window.setTimeout(() => setSavedMessage(""), 2200);
    return appliedKeys.size;
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
          correctionItems={correctionItems}
          hintedWordIds={hintedWordIds}
          lastResult={lastResult}
          lesson={selectedLesson}
          lessons={allLessons}
          mode={practiceMode}
          onFinish={finishDictation}
          onFinishCorrection={() => {
            setPhase("done");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
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
          lessons={allLessons}
          onSupplementHistoryMistakes={supplementHistoryMistakes}
          selectedLesson={selectedLesson}
          state={state}
          wordById={allKnownWords}
        />
      )}

      {savedMessage ? <div className="toast" role="status" aria-live="polite">{savedMessage}</div> : null}
    </main>
  );
}

function StudentView({
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
  phase,
  stats,
  wrongCharKeys,
}: {
  correctionItems: CorrectionItem[];
  hintedWordIds: ReadonlySet<string>;
  items: PracticeItem[];
  lastResult: { total: number; wrong: number };
  lesson: Lesson;
  lessons: Lesson[];
  mode: PracticeMode;
  onFinish: () => void;
  onFinishCorrection: () => void;
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
  const [activeItemIndex, setActiveItemIndex] = useState(0);
  const [speechPlayback, setSpeechPlayback] = useState<SpeechPlayback>(idleSpeechPlayback);
  const speechRequestRef = useRef(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const repeatTimeoutRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const speechSafetyTimeoutRef = useRef<number | null>(null);
  const reviewPercent = stats.historyTotal > 0 ? Math.round((stats.historyReviewed / stats.historyTotal) * 100) : 0;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(itemPage, totalPages - 1);
  const safeActiveItemIndex = Math.max(0, Math.min(activeItemIndex, Math.max(0, items.length - 1)));
  const visibleItems = items.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const isLastPage = safePage === totalPages - 1;
  const isPoetryMode = mode === "lesson" && lesson.lessonKind === "classical_poetry";
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

  const pickFirstLesson = (grade: Grade, term?: number) => {
    const first = lessons.find((item) => item.grade === grade && (term ? item.unit === term : true));
    if (first) onSelectLesson(first);
  };

  const clearSpeechTimers = useCallback(() => {
    if (repeatTimeoutRef.current !== null) window.clearTimeout(repeatTimeoutRef.current);
    if (countdownIntervalRef.current !== null) window.clearInterval(countdownIntervalRef.current);
    if (speechSafetyTimeoutRef.current !== null) window.clearTimeout(speechSafetyTimeoutRef.current);
    repeatTimeoutRef.current = null;
    countdownIntervalRef.current = null;
    speechSafetyTimeoutRef.current = null;
  }, []);

  const stopPlayback = useCallback(() => {
    speechRequestRef.current += 1;
    clearSpeechTimers();
    utteranceRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeechPlayback(idleSpeechPlayback);
  }, [clearSpeechTimers]);

  const startDoublePlayback = useCallback(async (itemIndex: number) => {
    const item = items[itemIndex];
    if (!item || isPoetryMode || phase !== "dictating") return;
    if (speechPlayback.index === itemIndex && speechPlayback.stage !== "idle") {
      stopPlayback();
      return;
    }

    stopPlayback();
    const requestId = speechRequestRef.current + 1;
    speechRequestRef.current = requestId;
    setActiveItemIndex(itemIndex);
    setSpeechPlayback({ index: itemIndex, stage: "first", countdown: 0 });

    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setSpeechPlayback(idleSpeechPlayback);
      return;
    }

    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          window.clearTimeout(timeout);
          window.speechSynthesis.removeEventListener("voiceschanged", finish);
          resolve();
        };
        const timeout = window.setTimeout(finish, 450);
        window.speechSynthesis.addEventListener("voiceschanged", finish);
      });
      voices = window.speechSynthesis.getVoices();
    }
    if (speechRequestRef.current !== requestId) return;

    const mainlandVoices = voices.filter((voice) => voice.lang.replace("_", "-").toLowerCase() === "zh-cn");
    const preferredVoice = mainlandVoices.find((voice) => /natural|premium|enhanced|tingting|ting-ting|xiaoxiao|yunxi|普通话/iu.test(voice.name)) ?? mainlandVoices[0];
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    if (speechRequestRef.current !== requestId) return;

    const speakPass = (pass: 1 | 2) => {
      if (speechRequestRef.current !== requestId) return;
      let settled = false;
      const utterance = new SpeechSynthesisUtterance(item.word.text);
      utterance.lang = "zh-CN";
      if (preferredVoice) utterance.voice = preferredVoice;
      utterance.rate = 0.82;
      utterance.pitch = 1;

      const settlePass = (completed: boolean) => {
        if (settled) return;
        settled = true;
        if (speechSafetyTimeoutRef.current !== null) window.clearTimeout(speechSafetyTimeoutRef.current);
        speechSafetyTimeoutRef.current = null;
        if (speechRequestRef.current !== requestId || utteranceRef.current !== utterance) return;
        utteranceRef.current = null;

        if (!completed || pass === 2) {
          setSpeechPlayback(idleSpeechPlayback);
          return;
        }

        let remaining = secondPlaybackDelaySeconds;
        setSpeechPlayback({ index: itemIndex, stage: "waiting", countdown: remaining });
        countdownIntervalRef.current = window.setInterval(() => {
          if (speechRequestRef.current !== requestId) return;
          remaining -= 1;
          if (remaining > 0) setSpeechPlayback({ index: itemIndex, stage: "waiting", countdown: remaining });
        }, 1000);
        repeatTimeoutRef.current = window.setTimeout(() => {
          if (countdownIntervalRef.current !== null) window.clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
          repeatTimeoutRef.current = null;
          speakPass(2);
        }, secondPlaybackDelaySeconds * 1000);
      };

      utterance.onend = () => settlePass(true);
      utterance.onerror = () => settlePass(false);
      utteranceRef.current = utterance;
      setSpeechPlayback({ index: itemIndex, stage: pass === 1 ? "first" : "second", countdown: 0 });
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        settlePass(false);
        return;
      }
      speechSafetyTimeoutRef.current = window.setTimeout(() => {
        if (speechRequestRef.current !== requestId || settled) return;
        settlePass(false);
        window.speechSynthesis.cancel();
      }, 20_000);
    };

    speakPass(1);
  }, [isPoetryMode, items, phase, speechPlayback.index, speechPlayback.stage, stopPlayback]);

  useEffect(() => {
    stopPlayback();
    setItemPage(0);
    setActiveItemIndex(0);
    setFinishArmed(false);
  }, [items.length, lesson.id, mode, stopPlayback]);

  useEffect(() => {
    if (phase !== "dictating") {
      stopPlayback();
      return;
    }
    setItemPage(0);
    setActiveItemIndex(0);
  }, [phase, stopPlayback]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) stopPlayback();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [stopPlayback]);

  useEffect(() => () => {
    speechRequestRef.current += 1;
    clearSpeechTimers();
    utteranceRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [clearSpeechTimers]);

  useEffect(() => {
    if (!finishArmed) return;
    const timeout = window.setTimeout(() => setFinishArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [finishArmed]);

  const goToPage = (nextPage: number) => {
    const clampedPage = Math.max(0, Math.min(totalPages - 1, nextPage));
    if (clampedPage === safePage) return;
    stopPlayback();
    setItemPage(clampedPage);
    setActiveItemIndex(Math.min(clampedPage * pageSize, Math.max(0, items.length - 1)));
    setFinishArmed(false);
    window.requestAnimationFrame(() => document.querySelector(".practice-heading")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const activateItem = (nextIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
    if (clampedIndex !== safeActiveItemIndex) stopPlayback();
    setActiveItemIndex(clampedIndex);
    const nextPage = Math.floor(clampedIndex / pageSize);
    if (nextPage !== safePage) setItemPage(nextPage);
  };

  const moveActiveItem = (direction: -1 | 1) => {
    const nextIndex = Math.max(0, Math.min(items.length - 1, safeActiveItemIndex + direction));
    if (nextIndex === safeActiveItemIndex) return;
    stopPlayback();
    setActiveItemIndex(nextIndex);
    const nextPage = Math.floor(nextIndex / pageSize);
    if (nextPage !== safePage) setItemPage(nextPage);
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
    setItemPage(0);
    setActiveItemIndex(0);
    onFinish();
  };

  useEffect(() => {
    if (phase !== "dictating" || isPoetryMode || items.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea, [contenteditable='true']")) return;

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
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        goToPage(safePage + (event.key === "ArrowUp" ? -1 : 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPoetryMode, items.length, phase, safeActiveItemIndex, safePage, startDoublePlayback]);

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

      {mode === "history" ? (
        <div className="history-progress">
          <div><span>历史复习进度</span><strong>{stats.historyReviewed} / {stats.historyTotal} 字已掌握</strong></div>
          <div className="progress-track"><i style={{ width: `${reviewPercent}%` }} /></div>
          <p>{stats.pendingMistakes > 0 ? `${stats.pendingMistakes} 个待巩固 · 每次练习间隔 7 天` : `已掌握 ${reviewPercent}%`}</p>
        </div>
      ) : null}

      {items.length === 0 ? (
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
              <h2>{phase === "dictating" ? isPoetryMode ? `古诗背诵默写 · 共 ${items.length} 篇` : mode === "history" ? `本组 ${visibleItems.length} 题 · 只默写需要巩固的字` : `本组 ${visibleItems.length} 题 · 每个字和拼音都要写` : "请点选写错的字"}</h2>
            </div>
            <div className="practice-status">
              <span className="page-counter">第 {safePage + 1} / {totalPages} 组</span>
              <div className={`phase-badge ${phase}`}>
                {phase === "dictating" ? <><span>1</span> 正在默写</> : <><span>2</span> 自己批改</>}
              </div>
            </div>
          </div>

          {phase === "dictating" && !isPoetryMode ? (
            <div className="keyboard-guide" aria-label="键盘快捷操作">
              <strong>当前第 {safeActiveItemIndex + 1} / {items.length} 题</strong>
              <span><kbd>←</kbd><kbd>→</kbd> 上一题 / 下一题</span>
              <span><kbd>↑</kbd><kbd>↓</kbd> 上一组 / 下一组</span>
              <span><kbd>空格</kbd> 播放 / 停止 · 自动播 2 遍，间隔 10 秒</span>
            </div>
          ) : null}

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
              {safePage > 0 ? <button className="secondary-button" type="button" onClick={() => goToPage(safePage - 1)}><ChevronUp size={18} />上一组</button> : null}
              {!isLastPage ? (
                <button className="primary-button" type="button" onClick={() => goToPage(safePage + 1)}>下一组<ChevronDown size={19} /></button>
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

function CorrectionView({ items, onFinish }: { items: CorrectionItem[]; onFinish: () => void }) {
  const wrongCharTotal = new Set(items.flatMap((item) => item.wrongChars.map((mistake) => mistake.char))).size;

  return (
    <section className="student-main correction-view">
      <div className="correction-heading">
        <div>
          <p className="eyebrow">第 3 步 · 订正错字</p>
          <h1>把写错的词认真订正好</h1>
          <p>先看完整词语，红色字是本次错字。第一次写错订正 2 遍，以后每错一次增加 1 遍。</p>
        </div>
        <div className="correction-total"><strong>{items.length}</strong><span>个错词</span><small>共 {wrongCharTotal} 个错字</small></div>
      </div>

      <div className="correction-grid">
        {items.map((item, index) => (
          <article className="correction-card" key={`${item.wordId}-${index}`}>
            <div className="correction-card-heading">
              <span className="correction-number">{String(index + 1).padStart(2, "0")}</span>
              <span>{item.wrongChars.length > 1 ? `${item.wrongChars.length} 个错字` : "1 个错字"}</span>
            </div>
            <div className="correction-word" aria-label={`错词：${item.text}`}>
              {Array.from(item.text).map((char, charIndex) => {
                const isWrong = item.wrongChars.some((mistake) => mistake.char === char);
                return <span className={isWrong ? "wrong" : ""} key={`${char}-${charIndex}`}>{char}</span>;
              })}
            </div>
            <div className="correction-error-list">
              {item.wrongChars.map((mistake) => (
                <div className="correction-error-detail" key={mistake.char}>
                  <strong className="correction-character">{mistake.char}</strong>
                  <div className="correction-requirement">
                    <b>订正 {mistake.repetitions} 遍</b>
                    <span>这是第 {mistake.mistakeCount} 次写错</span>
                  </div>
                  <div className="correction-writing-count" aria-label={`${mistake.char}需要订正${mistake.repetitions}遍`}>
                    {Array.from({ length: mistake.repetitions }, (_, repeatIndex) => <i key={repeatIndex}>{repeatIndex + 1}</i>)}
                  </div>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="correction-actions">
        <div><strong>订正完成后再继续</strong><span>请对照完整词语，确认每个红色错字都写够要求的遍数</span></div>
        <button className="primary-button" type="button" onClick={onFinish}><Check size={19} />我已完成订正</button>
      </div>
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
  active,
  dictationLessonTitle,
  hintRevealed,
  index,
  item,
  onActivate,
  onRevealHint,
  onTogglePlayback,
  onToggleWrong,
  playback,
  reviewing,
  wrongCharKeys,
}: {
  active: boolean;
  dictationLessonTitle: string;
  hintRevealed: boolean;
  index: number;
  item: PracticeItem;
  onActivate: () => void;
  onRevealHint: () => void;
  onTogglePlayback: () => void;
  onToggleWrong: (wordId: string, char: string) => void;
  playback: SpeechPlayback;
  reviewing: boolean;
  wrongCharKeys: Set<string>;
}) {
  const chars = Array.from(item.word.text).filter((char) => /\p{Script=Han}/u.test(char));
  const syllables = item.word.pinyin
    .split(/\s+/u)
    .map((syllable) => syllable.replace(/[，。！？；：、,.!?;:]/gu, ""))
    .filter(Boolean);
  const targets = new Set(reviewCharsForWord(item.word));
  const helpersVisible = reviewing || hintRevealed;
  const restrictReviewToTargets = hintRevealed;
  const fullReviewTargets = new Set(fullDictationCharsForWord(item.word));
  const reviewTargets = reviewing ? fullReviewTargets : restrictReviewToTargets ? targets : fullReviewTargets;
  const targetIndexes = new Set<number>();
  chars.forEach((char, index) => {
    if (targets.has(char)) targetIndexes.add(index);
  });
  const hasWrong = [...reviewTargets].some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
  const isPlaybackActive = playback.stage !== "idle";
  const playbackLabel = playback.stage === "first"
    ? "正在播放第 1 遍 · 点击停止"
    : playback.stage === "waiting"
      ? `${playback.countdown} 秒后播放第 2 遍 · 点击停止`
      : playback.stage === "second"
        ? "正在播放第 2 遍 · 点击停止"
        : "播放两遍";

  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`dictation-card ${active ? "is-current" : ""} ${chars.length >= 5 ? "long-word" : ""} ${reviewing ? "revealed" : ""} ${hasWrong ? "has-wrong" : ""}`}
      data-item-index={index}
      onClick={onActivate}
    >
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span>{reviewing ? item.word.lessonTitle : dictationLessonTitle}</span>
        {reviewing ? <b>{hasWrong ? "有错字" : "待批改"}</b> : active ? <b className="current-item-badge">当前题</b> : null}
      </div>
      {!reviewing ? <div className="card-listen-actions">
        <button
          aria-pressed={isPlaybackActive}
          className={`listen-button ${playback.stage === "waiting" ? "waiting" : isPlaybackActive ? "speaking" : ""}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
            onTogglePlayback();
          }}
        >
          <Volume2 size={19} />{playbackLabel}
        </button>
        <button
          className={hintRevealed ? "hint-button revealed" : "hint-button"}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
            onRevealHint();
          }}
          disabled={hintRevealed}
        >
            <Eye size={17} />{hintRevealed ? "提示已显示" : "没听清？查看提示"}
        </button>
      </div> : null}
      <div className="word-cells" aria-label={`第 ${index + 1} 题`}>
        {chars.map((char, charIndex) => {
          const isCoreTarget = targetIndexes.has(charIndex);
          const isReviewTarget = reviewing || !restrictReviewToTargets || isCoreTarget;
          const isHelperChar = hintRevealed && !isCoreTarget;
          const displayAsTarget = !hintRevealed || isCoreTarget;
          const isWrong = isReviewTarget && wrongCharKeys.has(charReviewKey(item.word.id, char));
          const showPinyin = reviewing || (hintRevealed && isCoreTarget);
          const cellHint = reviewing
            ? isWrong ? "写错了" : isHelperChar ? "提示字，也可标错" : "点击标错"
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
  lessons,
  onSupplementHistoryMistakes,
  selectedLesson,
  state,
  wordById,
}: {
  lessons: Lesson[];
  onSupplementHistoryMistakes: (logId: string, corrections: MissedWrongCharCorrection[]) => number;
  selectedLesson: Lesson;
  state: AppState;
  wordById: Map<string, DictationWord>;
}) {
  const [showAllLogs, setShowAllLogs] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  useEffect(() => {
    const clearPrintReport = () => {
      delete document.documentElement.dataset.printReport;
    };
    window.addEventListener("afterprint", clearPrintReport);
    return () => {
      window.removeEventListener("afterprint", clearPrintReport);
      clearPrintReport();
    };
  }, []);

  const printReport = (report: "pending" | "history") => {
    document.documentElement.dataset.printReport = report;
    window.print();
  };

  const pendingWrongChars = Object.entries(state.charStats)
    .filter(([, stat]) => stat.mistakes > 0 && !isMasteredChar(stat))
    .sort((left, right) => right[1].mistakes - left[1].mistakes);
  const wrongWordsByText = new Map<string, { chars: Set<string>; lastMistakeAt: string }>();
  const charsWithWordEvidence = new Set<string>();
  for (const [char, stat] of pendingWrongChars) {
    for (const wordText of stat.wrongWordTexts ?? []) {
      if (!wordText.trim()) continue;
      const existing = wrongWordsByText.get(wordText) ?? { chars: new Set<string>(), lastMistakeAt: "" };
      existing.chars.add(char);
      charsWithWordEvidence.add(char);
      if ((stat.lastMistakeAt ?? "") > existing.lastMistakeAt) existing.lastMistakeAt = stat.lastMistakeAt ?? "";
      wrongWordsByText.set(wordText, existing);
    }
  }
  const wrongWords = [
    ...[...wrongWordsByText.entries()].map(([wordText, detail]) => ({
      key: `word-${wordText}`,
      wordText,
      ...detail,
      missingWordEvidence: false,
    })),
    ...pendingWrongChars
      .filter(([char]) => !charsWithWordEvidence.has(char))
      .map(([char, stat]) => ({
        key: `legacy-char-${char}`,
        wordText: char,
        chars: new Set([char]),
        lastMistakeAt: stat.lastMistakeAt ?? "",
        missingWordEvidence: true,
      })),
  ].sort((left, right) => right.lastMistakeAt.localeCompare(left.lastMistakeAt) || right.chars.size - left.chars.size);
  const missingWordEvidenceCount = wrongWords.filter((item) => item.missingWordEvidence).length;
  const historicalWrongWordsByText = new Map<string, { chars: Set<string>; pendingChars: Set<string> }>();
  const historicalWrongCharsWithoutWordEvidence: string[] = [];
  for (const [char, stat] of Object.entries(state.charStats)) {
    if (stat.mistakes <= 0) continue;
    const wordTexts = Array.from(new Set((stat.wrongWordTexts ?? []).map((wordText) => wordText.trim()).filter(Boolean)));
    if (wordTexts.length === 0) historicalWrongCharsWithoutWordEvidence.push(char);
    for (const wordText of wordTexts) {
      const existing = historicalWrongWordsByText.get(wordText) ?? { chars: new Set<string>(), pendingChars: new Set<string>() };
      existing.chars.add(char);
      if (isPendingScreeningMistakeChar(stat)) existing.pendingChars.add(char);
      historicalWrongWordsByText.set(wordText, existing);
    }
  }
  const historicalWrongWords = [...historicalWrongWordsByText.entries()]
    .map(([wordText, detail]) => ({ wordText, ...detail }))
    .sort((left, right) => Number(right.pendingChars.size > 0) - Number(left.pendingChars.size > 0)
      || left.wordText.localeCompare(right.wordText, "zh-CN"));
  const historicalPendingWordCount = historicalWrongWords.filter((item) => item.pendingChars.size > 0).length;
  const historicalMasteredWordCount = historicalWrongWords.length - historicalPendingWordCount;
  const printDate = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date());
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
          <p>默写记录、打卡习惯、待巩固错字和历史错词会自动汇总在这里。课次由孩子在默写首页选择。</p>
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
            <div className="overview-stat history-total"><strong>{historicalWrongWords.length}</strong><span>历史错词</span></div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading"><History size={20} /><h2>最近默写</h2></div>
          <div className="recent-list">
            {state.logs.length === 0 ? <p className="muted">还没有默写记录。</p> : (showAllLogs ? state.logs : state.logs.slice(0, 6)).map((log) => (
              <RecentReviewItem
                key={log.id}
                lessons={lessons}
                log={log}
                onSupplementHistoryMistakes={onSupplementHistoryMistakes}
                state={state}
                wordById={wordById}
              />
            ))}
            {state.logs.length > 6 ? (
              <button className="show-more-logs" type="button" onClick={() => setShowAllLogs((current) => !current)}>
                {showAllLogs ? "收起较早记录" : `查看全部 ${state.logs.length} 条记录`}
              </button>
            ) : null}
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

        <section className="panel wide pending-words-panel printable-report" data-print-section="pending">
          <div className="panel-title-row">
            <div className="panel-heading"><ClipboardCheck size={20} /><h2>待巩固错字</h2></div>
            <button className="print-report-button" type="button" onClick={() => printReport("pending")} disabled={wrongWords.length === 0}>
              <Printer size={16} />打印待巩固
            </button>
          </div>
          <p className="print-metadata">待巩固错字清单 · 打印日期：{printDate}</p>
          {wrongWords.length === 0 ? <p className="muted">目前没有待巩固的错字。新的批改结果会自动记在这里。</p> : (
            <>
              <p className="panel-note">
                共 {pendingWrongChars.length} 个待巩固错字，完整列出 {wrongWordsByText.size} 个相关词语；同一个字可能出现在多个词中。
                {missingWordEvidenceCount > 0 ? `另有 ${missingWordEvidenceCount} 个旧记录未保留原词，已单独列出。` : ""}
              </p>
              <div className="wrong-word-list">{wrongWords.map(({ chars, key, missingWordEvidence, wordText }) => {
                const isLongText = Array.from(wordText).filter((char) => /\p{Script=Han}/u.test(char)).length > 10;
                const displayText = isLongText ? `《${wordText.split("\n")[0]}》全文` : wordText;
                return (
                  <div className={`wrong-word-item ${missingWordEvidence ? "missing-evidence" : ""}`} key={key}>
                    <strong className="wrong-word-text">
                      {Array.from(displayText).map((char, index) => (
                        <span className={chars.has(char) ? "wrong-character" : ""} key={`${char}-${index}`}>{char}</span>
                      ))}
                    </strong>
                    <small>{missingWordEvidence ? "旧记录未保留原词 · " : "错字："}{[...chars].map((char) => <b key={char}>{char}</b>)}</small>
                  </div>
                );
              })}</div>
            </>
          )}
        </section>

        <section className="panel wide history-words-panel printable-report" data-print-section="history">
          <div className="panel-title-row">
            <div className="panel-heading"><History size={20} /><h2>历史错词</h2></div>
            <button className="print-report-button" type="button" onClick={() => printReport("history")} disabled={historicalWrongWords.length === 0}>
              <Printer size={16} />打印历史错词
            </button>
          </div>
          <p className="print-metadata">历史错词清单 · 打印日期：{printDate}</p>
          {historicalWrongWords.length === 0 ? <p className="muted">还没有历史错词记录。</p> : (
            <>
              <p className="panel-note">
                历史上共错过 {historicalWrongWords.length} 个词语，其中 {historicalPendingWordCount} 个仍待巩固，{historicalMasteredWordCount} 个已经掌握。历史错词掌握后仍会保留在这里。
                {historicalWrongCharsWithoutWordEvidence.length > 0 ? `另有 ${historicalWrongCharsWithoutWordEvidence.length} 个旧错字未保留原词，未计入词语总数。` : ""}
              </p>
              <div className="history-word-table-wrap">
                <table className="history-word-table">
                  <thead>
                    <tr><th scope="col">序号</th><th scope="col">历史错词</th><th scope="col">曾错字</th><th scope="col">当前状态</th></tr>
                  </thead>
                  <tbody>
                    {historicalWrongWords.map(({ chars, pendingChars, wordText }, index) => {
                      const isLongText = Array.from(wordText).filter((char) => /\p{Script=Han}/u.test(char)).length > 10;
                      const displayText = isLongText ? `《${wordText.split("\n")[0]}》全文` : wordText;
                      return (
                        <tr key={wordText}>
                          <td className="history-word-index">{index + 1}</td>
                          <td>
                            <strong className="history-word-text">
                              {Array.from(displayText).map((char, charIndex) => (
                                <span className={chars.has(char) ? "wrong-character" : ""} key={`${char}-${charIndex}`}>{char}</span>
                              ))}
                            </strong>
                          </td>
                          <td><span className="historical-wrong-chars">{[...chars].map((char) => <b key={char}>{char}</b>)}</span></td>
                          <td>
                            <span className={`mastery-status ${pendingChars.size > 0 ? "pending" : "mastered"}`}>
                              {pendingChars.size > 0 ? `待巩固 ${pendingChars.size} 字` : "已掌握"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

      </div>
    </section>
  );
}

function RecentReviewItem({
  lessons,
  log,
  onSupplementHistoryMistakes,
  state,
  wordById,
}: {
  lessons: Lesson[];
  log: ReviewLog;
  onSupplementHistoryMistakes: (logId: string, corrections: MissedWrongCharCorrection[]) => number;
  state: AppState;
  wordById: Map<string, DictationWord>;
}) {
  const panelId = useId();
  const [isEditing, setIsEditing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const isLegacyRecord = !log.reviewedItems || log.reviewedItems.length === 0;
  const snapshotByWordId = new Map((log.reviewedItems ?? []).map((item) => [item.wordId, item]));
  const existingWrongKeys = new Set((log.wrongChars ?? []).map((item) => charReviewKey(item.wordId, item.char)));
  const wrongWordsWithCharDetails = new Set((log.wrongChars ?? []).map((item) => item.wordId));
  const correctionItems = log.wordIds.map((wordId) => {
    const snapshot = snapshotByWordId.get(wordId);
    const word = wordById.get(wordId);
    const wordText = snapshot?.wordText || word?.text || "";
    const isUndetailedLegacyWrongWord = isLegacyRecord
      && log.wrongWordIds.includes(wordId)
      && !wrongWordsWithCharDetails.has(wordId);
    const possibleChars = snapshot
      ? snapshot.reviewedChars
      : word ? fullDictationCharsForWord(word) : [];
    const chars = Array.from(new Set(possibleChars)).map((char) => ({
      char,
      canCorrect: !isUndetailedLegacyWrongWord
        && Boolean(snapshot || word?.chars.includes(char) || state.charStats[char]?.lastReviewedAt === log.date),
      isTarget: Boolean(word?.chars.includes(char)),
      isUndetailedLegacyWrongWord,
    }));
    const sourceLesson = word ? lessons.find((lesson) => lesson.id === word.lessonId) : undefined;
    return {
      wordId,
      wordText,
      chars,
      lessonText: sourceLesson ? lessonLabel(sourceLesson) : word?.lessonTitle || "课次信息缺失",
    };
  });
  const reviewedLessons = (log.lessons ?? []).map((reference) => ({
    reference,
    lesson: lessons.find((lesson) => lesson.id === reference.id),
  }));
  const lessonText = reviewedLessons.length === 0
    ? "课文信息未记录"
    : reviewedLessons
        .slice(0, 2)
        .map(({ reference, lesson }) => lesson ? lessonLabel(lesson) : reference.title)
        .join("、") + (reviewedLessons.length > 2 ? ` 等 ${reviewedLessons.length} 课` : "");
  const wrongChars = Array.from(new Set((log.wrongChars ?? []).map((item) => item.char)));
  const undetailedWrongWordIds = log.wrongWordIds.filter((wordId) => !wrongWordsWithCharDetails.has(wordId));
  const undetailedWrongWordText = undetailedWrongWordIds.map((id) => wordById.get(id)?.text).filter(Boolean).join("、");
  const wrongSummary = wrongChars.length === 0 && undetailedWrongWordIds.length === 0
    ? "全部正确"
    : [
        wrongChars.length > 0 ? `错 ${wrongChars.length} 字：${wrongChars.join("、")}` : "",
        undetailedWrongWordIds.length > 0
          ? `另有 ${undetailedWrongWordIds.length} 题旧版整词错误${undetailedWrongWordText ? `：${undetailedWrongWordText}` : ""}`
          : "",
      ].filter(Boolean).join("；");
  const modeText = log.practiceMode === "lesson" ? "当课复习" : log.practiceMode === "history" ? "历史复习" : "旧记录";
  const selectedCount = selectedKeys.size;

  const closeEditor = () => {
    setIsEditing(false);
    setSelectedKeys(new Set());
  };

  const submitCorrections = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const corrections = correctionItems.flatMap((item) => item.chars.flatMap(({ char }) =>
      selectedKeys.has(charReviewKey(item.wordId, char))
        ? [{ wordId: item.wordId, char }]
        : [],
    ));
    if (corrections.length === 0) return;
    if (onSupplementHistoryMistakes(log.id, corrections) > 0) closeEditor();
  };

  return (
    <div className={`recent-item ${isEditing ? "editing" : ""}`}>
      <div className="recent-item-heading"><span>{formatDate(log.date)}</span><b className={`review-mode ${log.practiceMode ?? "legacy"}`}>{modeText}</b></div>
      <strong className="recent-lesson">{lessonText}</strong>
      <small>{log.wordIds.length} 项 · {wrongSummary}</small>
      {log.practiceMode === "history" ? (
        <div className="recent-item-actions">
          <button
            aria-controls={panelId}
            aria-expanded={isEditing}
            className="supplement-mistakes-button"
            type="button"
            onClick={() => isEditing ? closeEditor() : setIsEditing(true)}
          >
            <ClipboardCheck size={15} />{isEditing ? "取消更正" : "补记错字"}
          </button>
        </div>
      ) : null}
      {isEditing ? (
        <form className="history-correction-panel" id={panelId} onSubmit={submitCorrections}>
          <fieldset>
            <legend>选择这次漏标的错字</legend>
            <p>只把原来误记为正确的字改成错误；本次作答次数和其他字不会变化。</p>
            {isLegacyRecord ? <p className="legacy-correction-note">这是一条旧记录，题词按当前词库还原：原来判为全对的目标字可直接补记；旧版已整词计错的题不会重复累计。请先核对当时题词。</p> : null}
            <div className="history-correction-items">
              {correctionItems.map((item, itemIndex) => (
                <div className="history-correction-item" key={`${item.wordId}-${itemIndex}`}>
                  <div>
                    <strong>{item.wordText || "题目信息缺失"}</strong>
                    <small>{item.lessonText}</small>
                  </div>
                  <div className="history-correction-chars">
                    {item.chars.length === 0 ? <span className="unavailable-correction">无法从旧记录确认计分字</span> : item.chars.map(({ canCorrect, char, isTarget, isUndetailedLegacyWrongWord }, charIndex) => {
                      const key = charReviewKey(item.wordId, char);
                      const alreadyWrong = existingWrongKeys.has(key);
                      const checked = alreadyWrong || selectedKeys.has(key);
                      return (
                        <label className={`${alreadyWrong ? "already-recorded" : ""} ${!canCorrect ? "unavailable" : ""}`} key={`${char}-${charIndex}`}>
                          <input
                            checked={checked}
                            disabled={alreadyWrong || !canCorrect}
                            type="checkbox"
                            onChange={(event) => setSelectedKeys((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(key);
                              else next.delete(key);
                              return next;
                            })}
                          />
                          <b>{char}</b>
                          <span>{alreadyWrong ? "已记录" : isUndetailedLegacyWrongWord ? "旧版已整词计错" : !canCorrect ? "无法确认" : isTarget ? "目标字" : "计分字"}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="history-correction-actions">
            <button className="secondary-button" type="button" onClick={closeEditor}><X size={17} />取消</button>
            <button className="primary-button" disabled={selectedCount === 0} type="submit"><Check size={17} />确认补记 {selectedCount} 处错字</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function StatusScreen({ title, detail }: { title: string; detail: string }) {
  return <main className="status-screen"><span className="brand-mark">字</span><h1>{title}</h1><p>{detail}</p></main>;
}

export default App;
