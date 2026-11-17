export type CharacterCategory = "一类" | "二类";

export type Grade = 1 | 2 | 3 | 4 | 5;

export interface ClassicalText {
  id: string;
  title: string;
  titlePinyin: string;
  author?: string;
  dynasty?: string;
  lines: Array<{ text: string; pinyin: string }>;
}

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
  sortOrder?: number;
  title: string;
  lessonKind?: "regular" | "garden" | "pinyin" | "classical_poetry" | "classical_prose" | "traditional_rhyme";
  directDictation?: boolean;
  words: DictationWord[];
  textbookWords?: DictationWord[];
  textCompanions?: CompanionDictionary;
  classicalTexts?: ClassicalText[];
}

export interface Progress {
  grade: Grade;
  lessonId: string;
}

export type LessonSummary = Omit<Lesson, "words" | "textbookWords" | "textCompanions" | "classicalTexts">;
export type PracticeLesson = LessonSummary & Pick<Lesson, "classicalTexts">;

export interface PracticeStats {
  historyTotal: number;
  historyReviewed: number;
  pendingMistakes: number;
  waitingReview: number;
}

export type PracticeMode = "lesson" | "history";

export interface PracticeData {
  lesson: PracticeLesson;
  mode: PracticeMode;
  items: PracticeItem[];
  stats: PracticeStats;
}

export interface ReviewActivity {
  id: string;
  date: string;
  count: number;
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
  practiceMode?: PracticeMode;
  lessons?: Array<{ id: string; title: string }>;
  wordIds: string[];
  wrongWordIds: string[];
  wrongChars?: Array<{ wordId: string; char: string }>;
  reviewedItems?: Array<{
    wordId: string;
    wordText: string;
    reviewedChars: string[];
  }>;
}

export type WordIssueKind = "wording" | "pronunciation";

export interface WordIssue {
  id: string;
  word: DictationWord;
  lessonLabel: string;
  kinds: WordIssueKind[];
  createdAt: string;
  resolvedAt?: string;
}

export interface AppState {
  progress: Progress;
  wordStats: Record<string, WordStat>;
  charStats: Record<string, CharacterStat>;
  logs: ReviewLog[];
  wordIssues: WordIssue[];
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
