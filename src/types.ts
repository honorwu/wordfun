export type CharacterCategory = "一类" | "二类";

export type Grade = 1 | 2 | 3 | 4 | 5;

export interface DictationWord {
  id: string;
  text: string;
  pinyin: string;
  chars: string[];
  grade: Grade;
  lessonId: string;
  lessonTitle: string;
  category: CharacterCategory;
}

export interface Lesson {
  id: string;
  grade: Grade;
  unit: number;
  number: number;
  title: string;
  words: DictationWord[];
}

export interface Progress {
  grade: Grade;
  lessonId: string;
}

export interface WordStat {
  attempts: number;
  mistakes: number;
  streak: number;
  lastReviewedAt?: string;
  lastMistakeAt?: string;
}

export interface CharacterStat {
  attempts: number;
  mistakes: number;
  streak: number;
  correctWordTexts?: string[];
  wrongWordTexts?: string[];
  lastReviewedAt?: string;
  lastMistakeAt?: string;
}

export interface ReviewLog {
  id: string;
  date: string;
  wordIds: string[];
  wrongWordIds: string[];
  wrongChars?: Array<{ wordId: string; char: string }>;
}

export interface AppState {
  progress: Progress;
  wordStats: Record<string, WordStat>;
  charStats: Record<string, CharacterStat>;
  customLessons: Lesson[];
  customWords: DictationWord[];
  logs: ReviewLog[];
}

export interface PracticeItem {
  word: DictationWord;
  score: number;
  reasons: string[];
}

export interface DictationCompanion {
  text: string;
  pinyin: string;
  chars: string[];
}

export type CompanionDictionary = Record<string, DictationCompanion[]>;
