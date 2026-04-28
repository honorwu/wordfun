import { categoryWeights } from "../data/metadata";
import type { AppState, CharacterStat, CompanionDictionary, DictationCompanion, DictationWord, Lesson, PracticeItem, Progress, WordStat } from "../types";

const dayMs = 24 * 60 * 60 * 1000;
const masteryNetCorrect = 2;

const hanChars = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char));

const uniqueChars = (chars: string[]) => Array.from(new Set(chars));

export const charReviewKey = (wordId: string, char: string) => `${wordId}\u0000${char}`;

export const reviewCharsForWord = (word: DictationWord) => uniqueChars(hanChars(word.text));

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

export const getEligibleWords = (lessons: Lesson[], customWords: DictationWord[], progress: Progress, companionWords: CompanionDictionary = {}) => {
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

  return withDictationCompanions(words, companionWords);
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

const chooseGeneratedCompanion = (targetChar: string, eligibleChars: Set<string>, companionWords: CompanionDictionary) => {
  const candidates = companionWords[targetChar] ?? [];
  return candidates.find((candidate) => candidate.chars.every((char) => eligibleChars.has(char))) ?? candidates[0];
};

const withDictationCompanions = (words: DictationWord[], companionWords: CompanionDictionary) => {
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

    const generatedCompanion = chooseGeneratedCompanion(targetChar, eligibleChars, companionWords);
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

const uniqueTexts = (texts?: string[]) => Array.from(new Set(texts ?? []));

const charCorrectWordCount = (stat?: CharacterStat) => uniqueTexts(stat?.correctWordTexts).length;

const charWrongWordCount = (stat?: CharacterStat) => uniqueTexts(stat?.wrongWordTexts).length;

const charNetCorrectCount = (stat?: CharacterStat) => charCorrectWordCount(stat) - charWrongWordCount(stat);

const hasWordTextEvidence = (stat: CharacterStat | undefined, wordText: string) =>
  Boolean(stat && (stat.correctWordTexts?.includes(wordText) || stat.wrongWordTexts?.includes(wordText)));

export const isMasteredChar = (stat?: CharacterStat) => charNetCorrectCount(stat) >= masteryNetCorrect;

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
  const eligibleWords = getEligibleWords(lessons, state.customWords, state.progress, companionWords);
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

export const applyReviewResult = (state: AppState, items: PracticeItem[], wrongCharKeys: Set<string>): AppState => {
  const now = new Date().toISOString();
  const addWordText = (texts: string[] | undefined, wordText: string) => uniqueTexts([...(texts ?? []), wordText]);
  const wrongWordIds = items
    .filter((item) => reviewCharsForWord(item.word).some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))))
    .map((item) => item.word.id);
  const wrongChars = items.flatMap((item) =>
    reviewCharsForWord(item.word)
      .filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)))
      .map((char) => ({ wordId: item.word.id, char })),
  );
  const next: AppState = {
    ...state,
    wordStats: { ...state.wordStats },
    charStats: { ...state.charStats },
    logs: [
      {
        id: crypto.randomUUID(),
        date: now,
        wordIds: items.map((item) => item.word.id),
        wrongWordIds,
        wrongChars,
      },
      ...state.logs,
    ].slice(0, 120),
  };

  for (const item of items) {
    const reviewChars = reviewCharsForWord(item.word);
    const isWrong = reviewChars.some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
    const previous = next.wordStats[item.word.id] ?? { attempts: 0, mistakes: 0, streak: 0 };
    next.wordStats[item.word.id] = {
      attempts: previous.attempts + 1,
      mistakes: previous.mistakes + (isWrong ? 1 : 0),
      streak: isWrong ? 0 : previous.streak + 1,
      lastReviewedAt: now,
      lastMistakeAt: isWrong ? now : previous.lastMistakeAt,
    };

    for (const char of reviewChars) {
      const isCharWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
      const charPrevious = next.charStats[char] ?? { attempts: 0, mistakes: 0, streak: 0 };
      next.charStats[char] = {
        attempts: charPrevious.attempts + 1,
        mistakes: charPrevious.mistakes + (isCharWrong ? 1 : 0),
        streak: isCharWrong ? 0 : charPrevious.streak + 1,
        correctWordTexts: isCharWrong ? uniqueTexts(charPrevious.correctWordTexts) : addWordText(charPrevious.correctWordTexts, item.word.text),
        wrongWordTexts: isCharWrong ? addWordText(charPrevious.wrongWordTexts, item.word.text) : uniqueTexts(charPrevious.wrongWordTexts),
        lastReviewedAt: now,
        lastMistakeAt: isCharWrong ? now : charPrevious.lastMistakeAt,
      };
    }
  }

  return next;
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
