import type { CompanionDictionary, DictationWord, Lesson, Progress } from "../types.ts";
import { hanChars, uniqueChars, hanLength } from "./characters.ts";

export const lessonOrder = (lesson: Pick<Lesson, "grade" | "unit" | "number" | "sortOrder">) =>
  lesson.grade * 10000 + lesson.unit * 1000 + (lesson.sortOrder ?? lesson.number);

export const isVocabularyLesson = (lesson: Pick<Lesson, "lessonKind">) =>
  lesson.lessonKind !== "classical_poetry";

export const progressOrder = (progress: Progress, lessons: Lesson[]) => {
  const selected = lessons.find((lesson) => lesson.id === progress.lessonId);
  return selected ? lessonOrder(selected) : progress.grade * 1000;
};

export const getEligibleLessons = (lessons: Lesson[], progress: Progress) => {
  const selectedOrder = progressOrder(progress, lessons);
  return lessons.filter((lesson) => lessonOrder(lesson) <= selectedOrder);
};

// 旧默写记录使用单字题目的 ID；保留原组词映射以还原这些记录。
export const getEligibleCharacterWords = (lessons: Lesson[], progress: Progress, companionWords: CompanionDictionary = {}) => {
  const words = getEligibleLessons(lessons, progress).flatMap((lesson) => lesson.words);

  return withDictationCompanions(words, lessons, companionWords);
};

export const getDictationWords = (lessons: Lesson[]) => lessons.flatMap((lesson) => lesson.dictationWords ?? []);

export const getEligibleWords = (lessons: Lesson[], progress: Progress) =>
  getDictationWords(getEligibleLessons(lessons, progress).filter(isVocabularyLesson));

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

export const isDirectDictationLesson = (lesson?: Pick<Lesson, "title" | "directDictation">) =>
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
  companion: Pick<DictationWord, "text" | "pinyin" | "textbookHint">,
): DictationWord => {
  return {
    ...source,
    text: companion.text,
    pinyin: companion.pinyin,
    ...(companion.textbookHint ? { textbookHint: companion.textbookHint } : {}),
    // `chars` 表示查看提示后仍需独立默写的核心字；未查看提示时，整词所有字都会计入本次默写。
    chars: uniqueChars(source.chars),
  };
};

const mergeSameCompanionWords = (words: DictationWord[]) => {
  const mergedByPrompt = new Map<string, DictationWord>();
  for (const word of words) {
    const key = `${word.lessonId}\u0000${word.text}\u0000${word.pinyin}`;
    const existing = mergedByPrompt.get(key);
    if (!existing) {
      mergedByPrompt.set(key, word);
      continue;
    }
    mergedByPrompt.set(key, {
      ...existing,
      chars: uniqueChars([...existing.chars, ...word.chars]),
      ...(word.textbookHint && !existing.textbookHint ? { textbookHint: word.textbookHint } : {}),
      category: existing.category === "一类" || word.category === "一类" ? "一类" : "二类",
    });
  }
  return [...mergedByPrompt.values()];
};

const withDictationCompanions = (
  words: DictationWord[],
  lessons: Lesson[],
  companionWords: CompanionDictionary,
) => {
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const textbookWordIds = new Set(lessons.flatMap((lesson) => (lesson.textbookWords ?? []).map((word) => word.id)));
  const eligibleChars = new Set(words.flatMap((word) => word.chars));
  const candidatesByChar = buildCompanionCandidates(words, lessonById);

  const companionPrompts = words.map((word) => {
    const chars = hanChars(word.text);
    if (chars.length !== 1 || textbookWordIds.has(word.id)) {
      return word;
    }

    const targetChar = chars[0];
    const lesson = lessonById.get(word.lessonId);
    const fixedCompanion = lesson?.textCompanions?.[targetChar]?.[0] ?? companionWords[targetChar]?.[0];
    if (fixedCompanion) {
      return companionWord(word, fixedCompanion);
    }

    const existingCompanion = (candidatesByChar.get(targetChar) ?? [])
      .map((candidate) => ({ candidate, score: companionScore(word, candidate, targetChar, eligibleChars) }))
      .sort((a, b) => b.score - a.score || hanLength(a.candidate.text) - hanLength(b.candidate.text))[0]?.candidate;

    if (existingCompanion) {
      return companionWord(word, existingCompanion);
    }

    return word;
  });
  return mergeSameCompanionWords(companionPrompts);
};
