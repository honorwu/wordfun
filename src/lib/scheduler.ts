import { categoryWeights } from "../data/metadata";
import type { AppState, CharacterStat, CompanionDictionary, DictationWord, Lesson, PracticeItem, Progress, UnsuitableWordFlag, WordStat } from "../types";

const dayMs = 24 * 60 * 60 * 1000;
const masteryNetCorrect = 2;
const screeningWordCooldownDays = 4;
const screeningMistakeCooldownDays = 14;
const screeningMistakeQuotaRatio = 0.25;

const hanChars = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char));

const uniqueChars = (chars: string[]) => Array.from(new Set(chars));

export const charReviewKey = (wordId: string, char: string) => `${wordId}\u0000${char}`;

export const reviewCharsForWord = (word: DictationWord) => uniqueChars(hanChars(word.text));

const hanLength = (value: string) => hanChars(value).length;

export const lessonOrder = (lesson: Pick<Lesson, "grade" | "unit" | "number" | "sortOrder">) =>
  lesson.grade * 10000 + lesson.unit * 1000 + (lesson.sortOrder ?? lesson.number);

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

  return withDictationCompanions(words, lessons, companionWords);
};

const directDictationLessonTitles = new Set([
  "对韵歌",
  "江南",
  "画",
  "静夜思",
  "古对今",
  "人之初",
  "司马光",
  "守株待兔",
  "精卫填海",
  "王戎不取道旁李",
  "古人谈读书",
  "少年中国说（节选）",
  "自相矛盾",
  "杨氏之子",
]);

const isDirectDictationLesson = (lesson?: Pick<Lesson, "title" | "directDictation">) =>
  Boolean(lesson?.directDictation || (lesson && (lesson.title.includes("古诗") || lesson.title.includes("文言文") || directDictationLessonTitles.has(lesson.title))));

const buildCompanionCandidates = (words: DictationWord[], lessonById: Map<string, Lesson>) => {
  const byChar = new Map<string, DictationWord[]>();
  for (const word of words) {
    if (isDirectDictationLesson(lessonById.get(word.lessonId))) {
      continue;
    }
    const chars = uniqueChars(hanChars(word.text));
    if (chars.length < 2 || chars.length > 4 || !word.pinyin) {
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

const withDictationCompanions = (words: DictationWord[], lessons: Lesson[], companionWords: CompanionDictionary) => {
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const eligibleChars = new Set(words.flatMap((word) => word.chars));
  const candidatesByChar = buildCompanionCandidates(words, lessonById);

  return words.map((word) => {
    const chars = hanChars(word.text);
    if (chars.length !== 1 || isDirectDictationLesson(lessonById.get(word.lessonId))) {
      return word;
    }

    const targetChar = chars[0];
    const lesson = lessonById.get(word.lessonId);
    const fixedCompanion = lesson?.textCompanions?.[targetChar]?.[0] ?? (!lesson ? companionWords[targetChar]?.[0] : undefined);
    if (fixedCompanion) {
      return companionWord(word, fixedCompanion, eligibleChars);
    }

    const existingCompanion = (candidatesByChar.get(targetChar) ?? [])
      .map((candidate) => ({ candidate, score: companionScore(word, candidate, targetChar, eligibleChars) }))
      .sort((a, b) => b.score - a.score || hanLength(a.candidate.text) - hanLength(b.candidate.text))[0]?.candidate;

    if (existingCompanion) {
      return companionWord(word, existingCompanion, eligibleChars);
    }

    return word;
  });
};

const localDayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const localDateKey = (date = new Date()) => {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const hashText = (value: string) => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const daysSince = (date?: string) => {
  if (!date) {
    return 999;
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return 999;
  }
  const elapsed = localDayStart(new Date()) - localDayStart(parsed);
  return Math.max(0, Math.floor(elapsed / dayMs));
};

const uniqueTexts = (texts?: string[]) => Array.from(new Set(texts ?? []));

const isUnsuitableWord = (word: DictationWord, state: AppState) => Boolean(state.unsuitableWords[word.id]);

const charCorrectWordCount = (stat?: CharacterStat) => uniqueTexts(stat?.correctWordTexts).length;

const charWrongWordCount = (stat?: CharacterStat) => uniqueTexts(stat?.wrongWordTexts).length;

const charNetCorrectCount = (stat?: CharacterStat) => charCorrectWordCount(stat) - charWrongWordCount(stat);

const hasWordTextEvidence = (stat: CharacterStat | undefined, wordText: string) =>
  Boolean(stat && (stat.correctWordTexts?.includes(wordText) || stat.wrongWordTexts?.includes(wordText)));

export const isMasteredChar = (stat?: CharacterStat) => charNetCorrectCount(stat) >= masteryNetCorrect;

export const isReviewedScreeningChar = (stat?: CharacterStat) => Boolean(stat && stat.attempts > 0);

export const isCorrectedScreeningChar = (stat?: CharacterStat) => Boolean(stat && stat.attempts > 0 && stat.streak > 0);

export const isPendingScreeningMistakeChar = (stat?: CharacterStat) => Boolean(stat && stat.mistakes > 0 && stat.streak <= 0);

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

const uniqueByText = (words: DictationWord[]) => [...new Map(words.map((word) => [word.text, word])).values()];

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

  const actionableWords = [...new Map(eligibleWords.map((word) => [word.id, word])).values()].filter((word) => !isUnsuitableWord(word, state) && !isMasteredWord(word, state));
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

  return uniqueByText(
    getEligibleWords(lessons, state.customWords, state.progress, companionWords).filter(
      (word) => word.lessonId === selectedLesson.id && !isUnsuitableWord(word, state),
    ),
  ).map((word, index) => ({
    word,
    score: 1000 - index,
    reasons: [isDirectDictationLesson(selectedLesson) ? "课文直接默写" : "本课词语"],
  }));
};

const screeningNeedForChar = (char: string, state: AppState) => {
  const stat = state.charStats[char];
  if (!stat || stat.attempts === 0) {
    return 72;
  }
  if (isCorrectedScreeningChar(stat)) {
    return 0;
  }
  if (isPendingScreeningMistakeChar(stat)) {
    const mistakeDays = daysSince(stat.lastMistakeAt);
    if (mistakeDays < screeningMistakeCooldownDays) {
      return 0;
    }
    return 44 + Math.min(16, stat.mistakes * 4) + Math.min(18, mistakeDays);
  }
  return 0;
};

const isFreshScreeningChar = (char: string, state: AppState) => {
  const stat = state.charStats[char];
  return !stat || stat.attempts === 0;
};

const isWeakScreeningChar = (char: string, state: AppState) => {
  const stat = state.charStats[char];
  return isPendingScreeningMistakeChar(stat) && daysSince(stat?.lastMistakeAt) >= screeningMistakeCooldownDays;
};

const isDueScreeningChar = (char: string, state: AppState) => {
  const stat = state.charStats[char];
  if (!stat || stat.attempts === 0) {
    return true;
  }
  return isPendingScreeningMistakeChar(stat) && daysSince(stat.lastMistakeAt) >= screeningMistakeCooldownDays;
};

const screeningReason = (chars: string[], state: AppState) => {
  if (chars.some((char) => isFreshScreeningChar(char, state))) {
    return "未筛查生字";
  }
  if (chars.some((char) => isWeakScreeningChar(char, state))) {
    return "错字回炉";
  }
  return "历史筛查";
};

export const getScreeningTargetChars = (lessons: Lesson[], customWords: DictationWord[], progress: Progress) => {
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const selectedLesson = lessonById.get(progress.lessonId);
  const selectedOrder = progressOrder(progress, lessons);
  const orderForWord = (word: DictationWord) => {
    const lesson = lessonById.get(word.lessonId);
    return lesson ? lessonOrder(lesson) : word.grade * 1000;
  };
  const pastLessonIds = new Set(
    lessons.filter((lesson) => lessonOrder(lesson) < selectedOrder && lesson.id !== selectedLesson?.id).map((lesson) => lesson.id),
  );

  return uniqueChars(
    [
      ...lessons.flatMap((lesson) => (pastLessonIds.has(lesson.id) ? lesson.words.flatMap((word) => word.chars) : [])),
      ...customWords.filter((word) => orderForWord(word) < selectedOrder).flatMap((word) => word.chars),
    ].filter(Boolean),
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
  const rotationKey = `${localDateKey()}\u0000${rotationSeed}`;
  const orderForWord = (word: DictationWord) => {
    const lesson = lessonById.get(word.lessonId);
    return lesson ? lessonOrder(lesson) : word.grade * 1000;
  };

  const targetChars = new Set(getScreeningTargetChars(lessons, state.customWords, state.progress));

  if (targetChars.size === 0) {
    return [];
  }

  const candidates = uniqueByText(
    getEligibleWords(lessons, state.customWords, state.progress, companionWords).filter(
      (word) => orderForWord(word) < selectedOrder && !isUnsuitableWord(word, state),
    ),
  )
    .map((word) => ({
      word,
      coverage: uniqueChars(hanChars(word.text).filter((char) => targetChars.has(char) && screeningNeedForChar(char, state) > 0)),
      rotation: hashText(`${rotationKey}\u0000${word.id}\u0000${word.text}`) / 0xffffffff,
    }))
    .filter((candidate) => candidate.coverage.length > 0);

  const selected: PracticeItem[] = [];
  const usedTexts = new Set<string>();
  const coveredChars = new Set<string>();
  const mistakeQuota = Math.max(1, Math.floor(targetCount * screeningMistakeQuotaRatio));
  let selectedMistakeReviews = 0;
  const recentlyReviewedWordIds = new Set(
    state.logs.filter((log) => daysSince(log.date) < screeningWordCooldownDays).flatMap((log) => log.wordIds),
  );
  const recentlyReviewedTexts = new Set(candidates.filter((candidate) => recentlyReviewedWordIds.has(candidate.word.id)).map((candidate) => candidate.word.text));

  const isRecentlyReviewedWord = (word: DictationWord) => {
    const stat = state.wordStats[word.id];
    const reviewedRecently = daysSince(stat?.lastReviewedAt) < screeningWordCooldownDays;
    return Boolean(
      recentlyReviewedWordIds.has(word.id) ||
        recentlyReviewedTexts.has(word.text) ||
        reviewedRecently,
    );
  };

  const scoreCandidate = (candidate: (typeof candidates)[number], newChars: string[]) => {
    const length = hanLength(candidate.word.text);
    const lengthBonus = length === 2 ? 10 : length === 3 ? 8 : length === 4 ? 4 : 0;
    const freshBonus = newChars.filter((char) => isFreshScreeningChar(char, state)).length * 32;
    const recentWordPenalty = isRecentlyReviewedWord(candidate.word) ? 90 : 0;
    return (
      newChars.reduce((sum, char) => sum + screeningNeedForChar(char, state), 0) +
      newChars.length * 24 +
      freshBonus +
      lengthBonus +
      candidate.rotation * 6 -
      recentWordPenalty
    );
  };
  const hasMistakeReview = (candidate: (typeof candidates)[number]) => candidate.coverage.some((char) => isWeakScreeningChar(char, state));
  const hasMistakeRoom = (candidate: (typeof candidates)[number]) => !hasMistakeReview(candidate) || selectedMistakeReviews < mistakeQuota;

  const selectBest = (canUse: (candidate: (typeof candidates)[number], newChars: string[]) => boolean) => {
    let best:
      | {
          word: DictationWord;
          coverage: string[];
          newChars: string[];
          rotation: number;
          score: number;
          hasMistakeReview: boolean;
        }
      | undefined;

    for (const candidate of candidates) {
      if (usedTexts.has(candidate.word.text)) {
        continue;
      }
      const candidateHasMistakeReview = hasMistakeReview(candidate);
      if (candidateHasMistakeReview && selectedMistakeReviews >= mistakeQuota) {
        continue;
      }
      const newChars = candidate.coverage.filter((char) => !coveredChars.has(char));
      if (newChars.length === 0) {
        continue;
      }
      if (!canUse(candidate, newChars)) {
        continue;
      }
      const score = scoreCandidate(candidate, newChars);
      if (
        !best ||
        score > best.score ||
        (score === best.score && newChars.length > best.newChars.length) ||
        (score === best.score && newChars.length === best.newChars.length && candidate.rotation > best.rotation)
      ) {
        best = { ...candidate, newChars, score, hasMistakeReview: candidateHasMistakeReview };
      }
    }

    if (!best) {
      return false;
    }

    usedTexts.add(best.word.text);
    best.coverage.forEach((char) => coveredChars.add(char));
    if (best.hasMistakeReview) {
      selectedMistakeReviews += 1;
    }
    selected.push({
      word: best.word,
      score: best.score,
      reasons: [screeningReason(best.newChars, state), `覆盖${best.newChars.length}字`],
    });
    return true;
  };

  while (
    selected.length < targetCount &&
    selectBest(
      (candidate, newChars) =>
        hasMistakeRoom(candidate) && !isRecentlyReviewedWord(candidate.word) && newChars.some((char) => isFreshScreeningChar(char, state)),
    )
  ) {
    // Diagnostic pass: spend the sheet on unseen characters first.
  }

  while (
    selected.length < targetCount &&
    selectBest((candidate, newChars) => hasMistakeRoom(candidate) && newChars.some((char) => isFreshScreeningChar(char, state)))
  ) {
    // Small scopes may need recently used words to finish covering unseen characters.
  }

  while (
    selected.length < targetCount &&
    selectBest(
      (candidate, newChars) =>
        hasMistakeRoom(candidate) && !isRecentlyReviewedWord(candidate.word) && newChars.some((char) => isDueScreeningChar(char, state)),
    )
  ) {
    // Wrong characters return after a longer cooldown and stay capped per sheet.
  }

  while (
    selected.length < targetCount &&
    selectBest(
      (candidate, newChars) =>
        hasMistakeRoom(candidate) && !isRecentlyReviewedWord(candidate.word) && newChars.some((char) => screeningNeedForChar(char, state) > 0),
    )
  ) {
    // Fill with older non-recent material when fresh and due pools are thin.
  }

  while (selected.length < targetCount && selectBest((candidate) => hasMistakeRoom(candidate))) {
    // Very small scopes may need recent needed words, but already-correct characters are not used to fill space.
  }

  return selected;
};

const unsuitableFlagForWord = (word: DictationWord, previous: UnsuitableWordFlag | undefined, now: string): UnsuitableWordFlag => ({
  wordId: word.id,
  text: word.text,
  pinyin: word.pinyin,
  grade: word.grade,
  lessonId: word.lessonId,
  lessonTitle: word.lessonTitle,
  category: word.category,
  flaggedCount: (previous?.flaggedCount ?? 0) + 1,
  firstFlaggedAt: previous?.firstFlaggedAt ?? now,
  lastFlaggedAt: now,
});

export const applyReviewResult = (state: AppState, items: PracticeItem[], wrongCharKeys: Set<string>, unsuitableWordIds = new Set<string>()): AppState => {
  const now = new Date().toISOString();
  const addWordText = (texts: string[] | undefined, wordText: string) => uniqueTexts([...(texts ?? []), wordText]);
  const reviewedItems = items.filter((item) => !unsuitableWordIds.has(item.word.id));
  const unsuitableItems = items.filter((item) => unsuitableWordIds.has(item.word.id));
  const wrongWordIds = reviewedItems
    .filter((item) => reviewCharsForWord(item.word).some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))))
    .map((item) => item.word.id);
  const wrongChars = reviewedItems.flatMap((item) =>
    reviewCharsForWord(item.word)
      .filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)))
      .map((char) => ({ wordId: item.word.id, char })),
  );
  const reviewLogs =
    reviewedItems.length > 0
      ? [
          {
            id: crypto.randomUUID(),
            date: now,
            wordIds: reviewedItems.map((item) => item.word.id),
            wrongWordIds,
            wrongChars,
          },
        ]
      : [];
  const next: AppState = {
    ...state,
    wordStats: { ...state.wordStats },
    charStats: { ...state.charStats },
    unsuitableWords: { ...state.unsuitableWords },
    logs: [...reviewLogs, ...state.logs].slice(0, 120),
  };

  for (const item of unsuitableItems) {
    next.unsuitableWords[item.word.id] = unsuitableFlagForWord(item.word, next.unsuitableWords[item.word.id], now);
  }

  for (const item of reviewedItems) {
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
