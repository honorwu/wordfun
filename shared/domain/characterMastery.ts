import type { BookCharacterIndex, CharacterStat, Lesson, LessonSummary } from "../types.ts";
import { isVocabularyLesson, lessonOrder } from "./catalog.ts";
import { hanChars } from "./characters.ts";
import { isMasteredChar } from "./reviewPolicy.ts";

export const characterMastery = (stat?: CharacterStat) => {
  if (!stat || stat.attempts === 0) return "unreviewed";
  if (!isMasteredChar(stat)) return "pending";
  return stat.mistakes > 0 ? "corrected" : "mastered";
};

export const buildBookCharacterIndex = (lessons: readonly Lesson[]): BookCharacterIndex[] => {
  const books = new Map<string, BookCharacterIndex>();
  for (const lesson of lessons) {
    if (!isVocabularyLesson(lesson)) continue;
    const key = `${lesson.grade}-${lesson.unit}`;
    const book = books.get(key) ?? { grade: lesson.grade, term: lesson.unit, characters: {}, firstLessonOrders: {} };
    books.set(key, book);
    const order = lessonOrder(lesson);
    const addChar = (char: string, label?: string) => {
      book.firstLessonOrders[char] = Math.min(book.firstLessonOrders[char] ?? Infinity, order);
      const labels = book.characters[char] ??= [];
      if (label && !labels.includes(label)) labels.push(label);
    };
    for (const { chars } of lesson.words) for (const char of chars) addChar(char);
    for (const word of lesson.textbookWords ?? []) {
      for (const char of new Set(hanChars(word.text))) addChar(char, word.text);
    }
  }
  return [...books.values()];
};

export const learnedTextbookChars = (books: readonly BookCharacterIndex[], progress: LessonSummary) => {
  const cutoff = lessonOrder(progress);
  return new Set(books.flatMap((book) => Object.entries(book.firstLessonOrders)
    .filter(([, order]) => order <= cutoff)
    .map(([char]) => char)));
};

export const groupCharacterMastery = (
  books: readonly BookCharacterIndex[],
  progress: LessonSummary,
  charStats: Readonly<Record<string, CharacterStat>>,
  selectedBook?: BookCharacterIndex,
) => {
  const learned = learnedTextbookChars(books, progress);
  const examples = new Map<string, Set<string>>();
  for (const book of selectedBook ? [selectedBook] : books) {
    for (const [char, words] of Object.entries(book.characters)) {
      const labels = examples.get(char) ?? new Set<string>();
      for (const word of words) labels.add(word);
      examples.set(char, labels);
    }
  }
  const groups = { mastered: [] as string[], corrected: [] as string[], pending: [] as string[], unreviewed: [] as string[], future: [] as string[] };
  for (const char of examples.keys()) {
    groups[learned.has(char) ? characterMastery(charStats[char]) : "future"].push(char);
  }
  return { groups, examples };
};
