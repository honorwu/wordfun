import { categoryWeights } from "../data/curriculum";
import dictationCompanionData from "../data/dictationCompanions.json";
import type { AppState, CharacterStat, DictationWord, Lesson, PracticeItem, Progress, WordStat } from "../types";

const dayMs = 24 * 60 * 60 * 1000;

type DictationCompanion = {
  text: string;
  pinyin: string;
  chars: string[];
};

const dictationCompanions = dictationCompanionData as Record<string, DictationCompanion[]>;

const hanChars = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char));

const uniqueChars = (chars: string[]) => Array.from(new Set(chars));

const hanLength = (value: string) => hanChars(value).length;

export const lessonOrder = (lesson: Pick<Lesson, "grade" | "unit" | "number">) => lesson.grade * 1000 + lesson.unit * 100 + lesson.number;

export const progressOrder = (progress: Progress, lessons: Lesson[]) => {
  const selected = lessons.find((lesson) => lesson.id === progress.lessonId);
  return selected ? lessonOrder(selected) : progress.grade * 1000;
};

export const getEligibleLessons = (lessons: Lesson[], progress: Progress) => {
  const selectedOrder = progressOrder(progress, lessons);
  return lessons.filter((lesson) => lessonOrder(lesson) <= selectedOrder);
};

export const getEligibleWords = (lessons: Lesson[], customWords: DictationWord[], progress: Progress) => {
  const lessonIds = new Set(getEligibleLessons(lessons, progress).map((lesson) => lesson.id));
  const selectedOrder = progressOrder(progress, lessons);
  const words = [
    ...lessons.flatMap((lesson) => lesson.words).filter((word) => lessonIds.has(word.lessonId)),
    ...customWords.filter((word) => {
      const lesson = lessons.find((candidate) => candidate.id === word.lessonId);
      if (lesson) {
        return lessonOrder(lesson) <= selectedOrder;
      }
      return word.grade < progress.grade;
    }),
  ];

  return withDictationCompanions(words);
};

const buildCompanionCandidates = (words: DictationWord[]) => {
  const byChar = new Map<string, DictationWord[]>();
  for (const word of words) {
    const chars = uniqueChars(hanChars(word.text));
    if (chars.length < 2 || chars.length > 6 || !word.pinyin) {
      continue;
    }
    for (const char of chars) {
      byChar.set(char, [...(byChar.get(char) ?? []), word]);
    }
  }
  return byChar;
};

const companionScore = (source: DictationWord, candidate: DictationWord, targetChar: string, eligibleChars: Set<string>) => {
  if (candidate.id === source.id || !hanChars(candidate.text).includes(targetChar)) {
    return Number.NEGATIVE_INFINITY;
  }

  const length = hanLength(candidate.text);
  let score = 0;
  if (candidate.lessonId === source.lessonId) {
    score += 80;
  }
  if (candidate.grade === source.grade) {
    score += 24;
  }
  if (candidate.category === source.category) {
    score += 8;
  }
  score += length === 2 ? 44 : length === 3 ? 24 : length === 4 ? 12 : 0;
  score += candidate.chars.filter((char) => eligibleChars.has(char)).length * 3;
  return score;
};

const companionWord = (
  source: DictationWord,
  companion: Pick<DictationWord, "text" | "pinyin" | "chars">,
  eligibleChars: Set<string>,
): DictationWord => {
  const companionChars = uniqueChars(companion.chars.length > 0 ? companion.chars : hanChars(companion.text));
  const reviewChars = companionChars.filter((char) => eligibleChars.has(char) || source.chars.includes(char));

  return {
    ...source,
    text: companion.text,
    pinyin: companion.pinyin,
    chars: uniqueChars([...source.chars, ...(reviewChars.length > 0 ? reviewChars : companionChars)]),
  };
};

const chooseGeneratedCompanion = (targetChar: string, eligibleChars: Set<string>) => {
  const candidates = dictationCompanions[targetChar] ?? [];
  return candidates.find((candidate) => candidate.chars.every((char) => eligibleChars.has(char))) ?? candidates[0];
};

const withDictationCompanions = (words: DictationWord[]) => {
  const eligibleChars = new Set(words.flatMap((word) => word.chars));
  const candidatesByChar = buildCompanionCandidates(words);

  return words.map((word) => {
    const chars = hanChars(word.text);
    if (chars.length !== 1) {
      return word;
    }

    const targetChar = chars[0];
    const existingCompanion = (candidatesByChar.get(targetChar) ?? [])
      .map((candidate) => ({ candidate, score: companionScore(word, candidate, targetChar, eligibleChars) }))
      .sort((a, b) => b.score - a.score || hanLength(a.candidate.text) - hanLength(b.candidate.text))[0]?.candidate;

    if (existingCompanion) {
      return companionWord(word, existingCompanion, eligibleChars);
    }

    const generatedCompanion = chooseGeneratedCompanion(targetChar, eligibleChars);
    return generatedCompanion ? companionWord(word, generatedCompanion, eligibleChars) : word;
  });
};

const daysSince = (date?: string) => {
  if (!date) {
    return 999;
  }
  const elapsed = Date.now() - new Date(date).getTime();
  return Math.max(0, Math.floor(elapsed / dayMs));
};

const wordCoverageNeed = (word: DictationWord, charStats: Record<string, CharacterStat>) => {
  return word.chars.reduce((score, char) => {
    const stat = charStats[char];
    if (!stat) {
      return score + 18;
    }
    if (stat.mistakes > 0) {
      return score + Math.min(12, stat.mistakes * 3);
    }
    return score + Math.min(8, daysSince(stat.lastReviewedAt));
  }, 0);
};

const wordScore = (word: DictationWord, state: AppState): PracticeItem => {
  const stat: WordStat | undefined = state.wordStats[word.id];
  const reasons: string[] = [];
  let score = 20 + (categoryWeights[word.category] ?? 0);

  if (word.grade === state.progress.grade) {
    score += 26;
    reasons.push("当前年级");
  } else {
    score += Math.max(0, 14 - (state.progress.grade - word.grade) * 4);
    reasons.push("穿插复习");
  }

  const coverage = wordCoverageNeed(word, state.charStats);
  score += coverage;
  if (coverage >= 18) {
    reasons.push("覆盖未复习生字");
  }

  if (!stat) {
    score += 28;
    reasons.push("新词");
  } else {
    const wrongRate = stat.mistakes / Math.max(1, stat.attempts);
    const due = Math.min(24, daysSince(stat.lastReviewedAt) * 2);
    score += wrongRate * 60 + stat.mistakes * 9 + due - Math.min(18, stat.streak * 4);
    if (stat.mistakes > 0) {
      reasons.push("错题回炉");
    }
    if (due >= 10) {
      reasons.push("到期复习");
    }
  }

  return { word, score, reasons: Array.from(new Set(reasons)).slice(0, 3) };
};

const reviewIntervalDays = (stat?: WordStat) => {
  if (!stat) {
    return 0;
  }
  if (stat.mistakes > 0 && stat.streak < 2) {
    return 1;
  }
  if (stat.streak <= 0) {
    return 1;
  }
  if (stat.streak === 1) {
    return 2;
  }
  if (stat.streak === 2) {
    return 4;
  }
  if (stat.streak === 3) {
    return 7;
  }
  return Math.min(21, stat.streak * 5);
};

const hasUnreviewedChar = (word: DictationWord, state: AppState) => word.chars.some((char) => !state.charStats[char]);

const hasWeakSignal = (word: DictationWord, state: AppState) =>
  (state.wordStats[word.id]?.mistakes ?? 0) > 0 || word.chars.some((char) => (state.charStats[char]?.mistakes ?? 0) > 0);

const isDueWord = (word: DictationWord, state: AppState) => {
  const stat = state.wordStats[word.id];
  return Boolean(stat && daysSince(stat.lastReviewedAt) >= reviewIntervalDays(stat));
};

const isMasteredWord = (word: DictationWord, state: AppState) => {
  const stat = state.wordStats[word.id];
  if (!stat || stat.streak < 3 || stat.mistakes > 0) {
    return false;
  }
  return word.chars.every((char) => {
    const charStat = state.charStats[char];
    return charStat && charStat.attempts >= 3 && charStat.mistakes === 0;
  });
};

const withReason = (item: PracticeItem, reason: string): PracticeItem => ({
  ...item,
  reasons: [reason, ...item.reasons.filter((current) => current !== reason)].slice(0, 3),
});

const sortPracticeItems = (items: PracticeItem[]) => [...items].sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id));

export const generatePractice = (lessons: Lesson[], state: AppState, targetCount = 20): PracticeItem[] => {
  const eligibleWords = getEligibleWords(lessons, state.customWords, state.progress);
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const selectedLesson = lessonById.get(state.progress.lessonId);
  const selectedOrder = progressOrder(state.progress, lessons);
  const orderForWord = (word: DictationWord) => {
    const lesson = lessonById.get(word.lessonId);
    return lesson ? lessonOrder(lesson) : word.grade * 1000;
  };

  const scored = [...new Map(eligibleWords.map((word) => [word.id, word])).values()]
    .map((word) => wordScore(word, state))
    .sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id));

  const selected = new Map<string, PracticeItem>();
  const selectedTexts = new Set<string>();
  const addSelected = (item: PracticeItem, reason: string, allowDuplicateText = false) => {
    if (selected.has(item.word.id)) {
      return false;
    }
    if (!allowDuplicateText && selectedTexts.has(item.word.text)) {
      return false;
    }
    selected.set(item.word.id, withReason(item, reason));
    selectedTexts.add(item.word.text);
    return true;
  };
  const addFrom = (items: PracticeItem[], count: number, reason: string) => {
    let added = 0;
    for (const item of sortPracticeItems(items)) {
      if (selected.size >= targetCount || added >= count) {
        break;
      }
      if (addSelected(item, reason)) {
        added += 1;
      }
    }
  };

  const newLessonQuota = Math.ceil(targetCount * 0.4);
  const mistakeQuota = Math.ceil(targetCount * 0.25);
  const dueQuota = Math.ceil(targetCount * 0.2);
  const spiralQuota = Math.max(0, targetCount - newLessonQuota - mistakeQuota - dueQuota);

  const currentLessonItems = scored.filter(
    (item) => selectedLesson && item.word.lessonId === selectedLesson.id && !isMasteredWord(item.word, state),
  );
  const mistakeItems = scored.filter((item) => hasWeakSignal(item.word, state));
  const dueItems = scored.filter((item) => isDueWord(item.word, state));
  const spiralItems = scored.filter((item) => orderForWord(item.word) < selectedOrder && item.word.grade < state.progress.grade);
  const currentGradeItems = scored.filter((item) => item.word.grade === state.progress.grade && !isMasteredWord(item.word, state));
  const coverageItems = scored.filter((item) => hasUnreviewedChar(item.word, state));

  addFrom(currentLessonItems, newLessonQuota, "新课优先");
  addFrom(mistakeItems, mistakeQuota, "错题回炉");
  addFrom(dueItems, dueQuota, "到期复习");
  addFrom(spiralItems, spiralQuota, "旧课穿插");
  addFrom(currentGradeItems, Math.ceil(targetCount * 0.25), "当前年级");
  addFrom(coverageItems, targetCount, "覆盖未复习生字");
  for (const item of scored) {
    if (selected.size >= targetCount) {
      break;
    }
    addSelected(item, "综合复习");
  }
  for (const item of scored) {
    if (selected.size >= targetCount) {
      break;
    }
    addSelected(item, "综合复习", true);
  }

  return [...selected.values()].sort((a, b) => {
    const aWrong = state.wordStats[a.word.id]?.mistakes ?? 0;
    const bWrong = state.wordStats[b.word.id]?.mistakes ?? 0;
    return bWrong - aWrong || b.word.grade - a.word.grade || b.score - a.score;
  });
};

export const applyReviewResult = (state: AppState, items: PracticeItem[], wrongIds: Set<string>): AppState => {
  const now = new Date().toISOString();
  const next: AppState = {
    ...state,
    wordStats: { ...state.wordStats },
    charStats: { ...state.charStats },
    logs: [
      {
        id: crypto.randomUUID(),
        date: now,
        wordIds: items.map((item) => item.word.id),
        wrongWordIds: [...wrongIds],
      },
      ...state.logs,
    ].slice(0, 120),
  };

  for (const item of items) {
    const isWrong = wrongIds.has(item.word.id);
    const previous = next.wordStats[item.word.id] ?? { attempts: 0, mistakes: 0, streak: 0 };
    next.wordStats[item.word.id] = {
      attempts: previous.attempts + 1,
      mistakes: previous.mistakes + (isWrong ? 1 : 0),
      streak: isWrong ? 0 : previous.streak + 1,
      lastReviewedAt: now,
      lastMistakeAt: isWrong ? now : previous.lastMistakeAt,
    };

    for (const char of item.word.chars) {
      const charPrevious = next.charStats[char] ?? { attempts: 0, mistakes: 0 };
      next.charStats[char] = {
        attempts: charPrevious.attempts + 1,
        mistakes: charPrevious.mistakes + (isWrong ? 1 : 0),
        lastReviewedAt: now,
      };
    }
  }

  return next;
};

export const summarizeCoverage = (words: DictationWord[], state: AppState) => {
  const chars = new Set(words.flatMap((word) => word.chars));
  const reviewedChars = [...chars].filter((char) => state.charStats[char]?.attempts > 0);
  const wrongWords = Object.values(state.wordStats).filter((stat) => stat.mistakes > 0).length;
  const masteredWords = words.filter((word) => {
    const stat = state.wordStats[word.id];
    return stat && stat.streak >= 3 && stat.mistakes === 0;
  }).length;

  return {
    totalWords: words.length,
    totalChars: chars.size,
    reviewedChars: reviewedChars.length,
    wrongWords,
    masteredWords,
  };
};
