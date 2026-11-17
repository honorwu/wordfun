import type { AppState, CharacterStat, CompanionDictionary, DictationWord, Lesson, PracticeItem, Progress, WordStat } from "../types.ts";
import { hanChars, uniqueChars, reviewCharsForWord } from "./characters.ts";
import { lessonOrder, progressOrder, getEligibleWords, isDirectDictationLesson } from "./catalog.ts";
import { categoryWeights, masteryNetCorrect, charNetCorrectCount, hasWordTextEvidence, charWrongWordCount, daysSince, isMasteredChar, isHistoryCharDue, isPendingScreeningMistakeChar } from "./reviewPolicy.ts";

const wordCoverageNeed = (word: DictationWord, charStats: Record<string, CharacterStat>) => {
  return word.chars.reduce((score, char) => {
    const stat = charStats[char];
    if (!stat) {
      return score + 24;
    }
    if (isMasteredChar(stat)) {
      return score;
    }
    const netNeed = Math.max(0, masteryNetCorrect - charNetCorrectCount(stat));
    const newWordBonus = hasWordTextEvidence(stat, word.text) ? 0 : 12;
    if (stat.mistakes > 0) {
      return score + Math.min(28, stat.mistakes * 4 + charWrongWordCount(stat) * 5 + netNeed * 6 + newWordBonus);
    }
    return score + 8 + netNeed * 6 + newWordBonus + Math.min(6, daysSince(stat.lastReviewedAt));
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
    const unresolvedMistake = stat.mistakes > 0 && !isMasteredWord(word, state);
    const wrongRate = unresolvedMistake ? stat.mistakes / Math.max(1, stat.attempts) : 0;
    const due = Math.min(24, daysSince(stat.lastReviewedAt) * 2);
    score += wrongRate * 60 + (unresolvedMistake ? stat.mistakes * 9 : 0) + due - Math.min(18, stat.streak * 5);
    if (unresolvedMistake) {
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

const hasUnmasteredChar = (word: DictationWord, state: AppState) => word.chars.some((char) => !isMasteredChar(state.charStats[char]));

const hasWeakSignal = (word: DictationWord, state: AppState) =>
  Boolean(state.wordStats[word.id] && (state.wordStats[word.id].mistakes ?? 0) > 0 && !isMasteredWord(word, state)) ||
  word.chars.some((char) => {
    const stat = state.charStats[char];
    return Boolean(stat && stat.mistakes > 0 && !isMasteredChar(stat));
  });

const isDueWord = (word: DictationWord, state: AppState) => {
  const stat = state.wordStats[word.id];
  return Boolean(stat && !isMasteredWord(word, state) && daysSince(stat.lastReviewedAt) >= reviewIntervalDays(stat));
};

export const isMasteredWord = (word: DictationWord, state: AppState) => {
  if (word.chars.length === 0) {
    return false;
  }
  return word.chars.every((char) => isMasteredChar(state.charStats[char]));
};

const withReason = (item: PracticeItem, reason: string): PracticeItem => ({
  ...item,
  reasons: [reason, ...item.reasons.filter((current) => current !== reason)].slice(0, 3),
});

const sortPracticeItems = (items: PracticeItem[]) => [...items].sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id));

export const termMistakeReason = "本学期错词";

const isGardenLesson = (lesson: Lesson) => lesson.title.startsWith("语文园地");

const currentTeachingUnitFloor = (lessons: Lesson[], selectedLesson?: Lesson) => {
  if (!selectedLesson) {
    return Number.NEGATIVE_INFINITY;
  }
  const previousGarden = lessons
    .filter(
      (lesson) =>
        lesson.grade === selectedLesson.grade &&
        lesson.unit === selectedLesson.unit &&
        lesson.number < selectedLesson.number &&
        isGardenLesson(lesson),
    )
    .sort((a, b) => b.number - a.number)[0];
  return previousGarden?.number ?? Number.NEGATIVE_INFINITY;
};

export const generatePractice = (lessons: Lesson[], state: AppState, targetCount = 20, companionWords: CompanionDictionary = {}): PracticeItem[] => {
  const eligibleWords = getEligibleWords(lessons, state.progress, companionWords);
  const wordPosition = new Map(eligibleWords.map((word, index) => [word.id, index]));
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const selectedLesson = lessonById.get(state.progress.lessonId);
  const selectedOrder = progressOrder(state.progress, lessons);
  const currentUnitFloor = currentTeachingUnitFloor(lessons, selectedLesson);
  const orderForWord = (word: DictationWord) => {
    const lesson = lessonById.get(word.lessonId);
    return lesson ? lessonOrder(lesson) : word.grade * 1000;
  };
  const lessonForWord = (word: DictationWord) => lessonById.get(word.lessonId);
  const isInCurrentTeachingUnit = (word: DictationWord) => {
    const lesson = lessonForWord(word);
    return Boolean(
      selectedLesson &&
        lesson &&
        lesson.grade === selectedLesson.grade &&
        lesson.unit === selectedLesson.unit &&
        lesson.number > currentUnitFloor &&
        lesson.number <= selectedLesson.number,
    );
  };
  const isInCurrentTerm = (word: DictationWord) => {
    const lesson = lessonForWord(word);
    return Boolean(selectedLesson && lesson && lesson.grade === selectedLesson.grade && lesson.unit === selectedLesson.unit && orderForWord(word) <= selectedOrder);
  };
  const isInCurrentGrade = (word: DictationWord) => word.grade === state.progress.grade && orderForWord(word) <= selectedOrder;
  const isPastWord = (word: DictationWord) => orderForWord(word) < selectedOrder;

  const actionableWords = [...new Map(eligibleWords.map((word) => [word.id, word])).values()].filter((word) => !isMasteredWord(word, state));
  if (actionableWords.length === 0) {
    return [];
  }

  const scored = actionableWords
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

  const currentLessonQuota = Math.ceil(targetCount * 0.4);
  const currentUnitQuota = Math.ceil(targetCount * 0.25);
  const currentTermQuota = Math.ceil(targetCount * 0.15);
  const pastQuota = Math.max(1, Math.floor(targetCount * 0.1));
  const currentGradeQuota = Math.max(0, targetCount - currentLessonQuota - currentUnitQuota - currentTermQuota - pastQuota);

  const currentLessonItems = scored.filter(
    (item) => selectedLesson && item.word.lessonId === selectedLesson.id && !isMasteredWord(item.word, state),
  );
  const currentUnitItems = scored.filter((item) => isInCurrentTeachingUnit(item.word));
  const currentTermItems = scored.filter((item) => isInCurrentTerm(item.word));
  const mistakeItems = scored.filter((item) => hasWeakSignal(item.word, state));
  const dueItems = scored.filter((item) => isDueWord(item.word, state));
  const currentGradeItems = scored.filter((item) => isInCurrentGrade(item.word));
  const pastItems = scored.filter((item) => isPastWord(item.word));
  const coverageItems = scored.filter((item) => hasUnreviewedChar(item.word, state) || hasUnmasteredChar(item.word, state));

  addFrom(currentLessonItems, currentLessonQuota, "当前课");
  addFrom(currentUnitItems, currentUnitQuota, "当前单元");
  addFrom(currentTermItems, currentTermQuota, "当前学期");
  addFrom(currentGradeItems, currentGradeQuota, "当前学年");
  addFrom(pastItems, pastQuota, "旧词穿插");
  addFrom(mistakeItems, targetCount, "错题回炉");
  addFrom(dueItems, targetCount, "到期复习");
  addFrom(coverageItems, targetCount, "不同词语覆盖");
  for (const item of scored) {
    if (selected.size >= targetCount) {
      break;
    }
    addSelected(item, "综合复习");
  }
  return [...selected.values()].sort((a, b) => {
    return orderForWord(b.word) - orderForWord(a.word) || (wordPosition.get(b.word.id) ?? 0) - (wordPosition.get(a.word.id) ?? 0);
  });
};

export const generateCurrentLessonPractice = (lessons: Lesson[], state: AppState, companionWords: CompanionDictionary = {}): PracticeItem[] => {
  const selectedLesson = lessons.find((lesson) => lesson.id === state.progress.lessonId);
  if (!selectedLesson) {
    return [];
  }
  const textbookWordIds = new Set((selectedLesson.textbookWords ?? []).map((word) => word.id));

  return getEligibleWords(lessons, state.progress, companionWords)
    .filter((word) => word.lessonId === selectedLesson.id)
    .map((word, index) => ({
      word,
      score: 1000 - index,
      reasons: [textbookWordIds.has(word.id) ? "词语表" : isDirectDictationLesson(selectedLesson) ? "课文直接默写" : "补充生字"],
    }))
    .sort((left, right) => {
      const leftTextbook = textbookWordIds.has(left.word.id);
      const rightTextbook = textbookWordIds.has(right.word.id);
      if (leftTextbook || rightTextbook) {
        return Number(rightTextbook) - Number(leftTextbook) || right.score - left.score;
      }
      const leftCovered = reviewCharsForWord(left.word).every((char) => isMasteredChar(state.charStats[char]));
      const rightCovered = reviewCharsForWord(right.word).every((char) => isMasteredChar(state.charStats[char]));
      return Number(leftCovered) - Number(rightCovered) || right.score - left.score;
    });
};

export const generatePoetryPractice = (lesson: Lesson): PracticeItem[] =>
  (lesson.classicalTexts ?? []).map((poem, index) => {
    const text = [poem.title, poem.dynasty, poem.author, poem.lines.map((line) => line.text).join("\n")].filter(Boolean).join("\n");
    const pinyin = [poem.titlePinyin, poem.lines.map((line) => line.pinyin).join("\n")].filter(Boolean).join("\n");
    return {
      word: {
        id: `poem-${poem.id}`,
        text,
        pinyin,
        chars: uniqueChars(hanChars(text)),
        grade: lesson.grade,
        lessonId: lesson.id,
        lessonTitle: poem.title,
        category: "一类",
      },
      score: 1000 - index,
      reasons: ["古诗全文默写"],
    };
  });

export const hasMistakeSignalForWord = (word: DictationWord, state: AppState) => {
  const stat = state.wordStats[word.id];
  if (stat && stat.mistakes > 0) {
    return true;
  }

  return reviewCharsForWord(word).some((char) => state.charStats[char]?.wrongWordTexts?.includes(word.text));
};

export const getCurrentTermTextbookWords = (lessons: Lesson[], progress: Progress) => {
  const selectedLesson = lessons.find((lesson) => lesson.id === progress.lessonId);
  if (!selectedLesson) {
    return [];
  }

  return lessons
    .filter((lesson) => lesson.grade === selectedLesson.grade && lesson.unit === selectedLesson.unit)
    .sort((a, b) => lessonOrder(a) - lessonOrder(b))
    .flatMap((lesson) => lesson.textbookWords ?? []);
};

export const generateTermReviewPractice = (lessons: Lesson[], state: AppState): PracticeItem[] =>
  getCurrentTermTextbookWords(lessons, state.progress).map((word, index) => {
    const isMistake = hasMistakeSignalForWord(word, state);
    return {
      word,
      score: isMistake ? 2000 - index : 1000 - index,
      reasons: isMistake ? [termMistakeReason, "词语表"] : ["词语表"],
    };
  });

export const getScreeningTargetChars = (lessons: Lesson[], progress: Progress, companionWords: CompanionDictionary = {}) => {
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const selectedLesson = lessonById.get(progress.lessonId);
  const selectedOrder = progressOrder(progress, lessons);
  const pastLessonIds = new Set(
    lessons.filter((lesson) => lessonOrder(lesson) < selectedOrder && lesson.id !== selectedLesson?.id && lesson.lessonKind !== "classical_poetry").map((lesson) => lesson.id),
  );

  return uniqueChars(
    getEligibleWords(lessons, progress, companionWords)
      .filter((word) => pastLessonIds.has(word.lessonId))
      .flatMap((word) => reviewCharsForWord(word)),
  );
};

export const generateScreeningPractice = (
  lessons: Lesson[],
  state: AppState,
  targetCount = 20,
  companionWords: CompanionDictionary = {},
  rotationSeed = 0,
): PracticeItem[] => {
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const selectedOrder = progressOrder(state.progress, lessons);
  const orderForWord = (word: DictationWord) => {
    const lesson = lessonById.get(word.lessonId);
    return lesson ? lessonOrder(lesson) : word.grade * 1000;
  };
  const candidates = getEligibleWords(lessons, state.progress, companionWords)
    .map((word, sourceIndex) => ({ word, sourceIndex, order: orderForWord(word) }))
    .filter(({ word, order }) => order < selectedOrder && lessonById.get(word.lessonId)?.lessonKind !== "classical_poetry")
    .sort((left, right) => right.order - left.order || left.sourceIndex - right.sourceIndex);

  // 历史复习按字收敛：写对的字不再重复出现，错字优先；同一优先级内仍按课次倒序。
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [`${candidate.word.lessonId}\u0000${candidate.word.chars.join("")}`, candidate])).values()];
  const seenTargetChars = new Set<string>();
  const pending = uniqueCandidates.flatMap((candidate) => {
    const pendingChars = reviewCharsForWord(candidate.word).filter(
      (char) => isHistoryCharDue(state.charStats[char]) && !seenTargetChars.has(char),
    );
    if (pendingChars.length === 0) {
      return [];
    }
    pendingChars.forEach((char) => seenTargetChars.add(char));
    const hasKnownMistake = pendingChars.some((char) => isPendingScreeningMistakeChar(state.charStats[char]));
    return [{
      ...candidate,
      word: { ...candidate.word, chars: pendingChars },
      hasKnownMistake,
    }];
  }).sort((left, right) => Number(right.hasKnownMistake) - Number(left.hasKnownMistake));
  const offset = rotationSeed * targetCount;
  const page = pending.slice(offset, offset + targetCount);

  return page.map(({ word, hasKnownMistake }, index) => ({
    word,
    score: targetCount - index,
    reasons: [hasKnownMistake ? "错字再练" : "历史新字"],
  }));
};

export const summarizeCoverage = (words: DictationWord[], state: AppState) => {
  const chars = new Set(words.flatMap((word) => word.chars));
  const reviewedChars = [...chars].filter((char) => state.charStats[char]?.attempts > 0);
  const wrongWords = words.filter((word) => {
    const stat = state.wordStats[word.id];
    return stat && stat.mistakes > 0 && !isMasteredWord(word, state);
  }).length;
  const masteredWords = words.filter((word) => isMasteredWord(word, state)).length;

  return {
    totalWords: words.length,
    totalChars: chars.size,
    reviewedChars: reviewedChars.length,
    wrongWords,
    masteredWords,
  };
};
