import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");
export const dataDir = process.env.ZIQU_DATA_DIR ? path.resolve(process.env.ZIQU_DATA_DIR) : path.join(projectRoot, "data");
export const defaultCatalogDatabasePath = process.env.ZIQU_CATALOG_DB_PATH
  ? path.resolve(process.env.ZIQU_CATALOG_DB_PATH)
  : path.join(dataDir, "ziqu-catalog.sqlite");
export const defaultLearningDatabasePath = process.env.ZIQU_LEARNING_DB_PATH
  ? path.resolve(process.env.ZIQU_LEARNING_DB_PATH)
  : path.join(dataDir, "ziqu-learning.sqlite");
export const defaultStudentId = process.env.ZIQU_STUDENT_ID || "default-student";

export const catalogSchemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  grade INTEGER NOT NULL,
  unit REAL NOT NULL,
  number REAL NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (grade, unit, number, source)
);

CREATE TABLE IF NOT EXISTS words (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  grade INTEGER NOT NULL,
  lesson_title TEXT NOT NULL,
  word_order INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS word_chars (
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  char_order INTEGER NOT NULL,
  PRIMARY KEY (word_id, char)
);

CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(grade, unit, number);
CREATE INDEX IF NOT EXISTS idx_words_lesson ON words(lesson_id, word_order);
CREATE INDEX IF NOT EXISTS idx_words_text ON words(text);
CREATE INDEX IF NOT EXISTS idx_word_chars_char ON word_chars(char);

CREATE TABLE IF NOT EXISTS companion_words (
  target_char TEXT NOT NULL,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  companion_order INTEGER NOT NULL,
  PRIMARY KEY (target_char, text, pinyin)
);

CREATE TABLE IF NOT EXISTS companion_word_chars (
  target_char TEXT NOT NULL,
  companion_text TEXT NOT NULL,
  companion_pinyin TEXT NOT NULL,
  char TEXT NOT NULL,
  char_order INTEGER NOT NULL,
  PRIMARY KEY (target_char, companion_text, companion_pinyin, char),
  FOREIGN KEY (target_char, companion_text, companion_pinyin)
    REFERENCES companion_words(target_char, text, pinyin)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_companion_chars_char ON companion_word_chars(char);
`;

export const learningSchemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS progress (
  student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  grade INTEGER NOT NULL,
  lesson_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS word_stats (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  streak INTEGER NOT NULL,
  last_reviewed_at TEXT,
  last_mistake_at TEXT,
  PRIMARY KEY (student_id, word_id)
);

CREATE TABLE IF NOT EXISTS char_stats (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  last_reviewed_at TEXT,
  PRIMARY KEY (student_id, char)
);

CREATE TABLE IF NOT EXISTS review_logs (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_log_words (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  is_wrong INTEGER NOT NULL,
  item_order INTEGER NOT NULL,
  PRIMARY KEY (log_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_review_logs_student_date ON review_logs(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_review_log_words_log ON review_log_words(log_id, item_order);

CREATE TABLE IF NOT EXISTS custom_lessons (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  grade INTEGER NOT NULL,
  unit REAL NOT NULL,
  number REAL NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (student_id, id)
);

CREATE TABLE IF NOT EXISTS custom_words (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  grade INTEGER NOT NULL,
  lesson_title TEXT NOT NULL,
  word_order INTEGER NOT NULL,
  PRIMARY KEY (student_id, id)
);

CREATE TABLE IF NOT EXISTS custom_word_chars (
  student_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  char TEXT NOT NULL,
  char_order INTEGER NOT NULL,
  PRIMARY KEY (student_id, word_id, char),
  FOREIGN KEY (student_id, word_id) REFERENCES custom_words(student_id, id) ON DELETE CASCADE
);
`;

export const ensureDataDir = () => {
  mkdirSync(dataDir, { recursive: true });
};

const openDatabaseWithSchema = (databasePath, schemaSql) => {
  ensureDataDir();
  const db = new DatabaseSync(databasePath);
  db.exec(schemaSql);
  return db;
};

export const openCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => openDatabaseWithSchema(databasePath, catalogSchemaSql);

export const openLearningDatabase = (databasePath = defaultLearningDatabasePath) => openDatabaseWithSchema(databasePath, learningSchemaSql);

export const requireCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => {
  if (!existsSync(databasePath)) {
    throw new Error(`Catalog SQLite database not found at ${databasePath}. Provide the catalog database before starting the server.`);
  }
  return openCatalogDatabase(databasePath);
};

export const readJson = (relativePath) => JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));

export const normalizeCategory = (category) => (category === "一类" ? "一类" : "二类");

export const runTransaction = (db, fn) => {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const allRows = (db, sql, ...params) => db.prepare(sql).all(...params);
const oneRow = (db, sql, ...params) => db.prepare(sql).get(...params);

const defaultProgress = (catalogDb) =>
  oneRow(catalogDb, "SELECT id AS lesson_id, grade FROM lessons WHERE grade = 3 ORDER BY unit, number LIMIT 1") ||
  oneRow(catalogDb, "SELECT id AS lesson_id, grade FROM lessons ORDER BY grade, unit, number LIMIT 1") || {
    grade: 3,
    lesson_id: "",
  };

const ensureStudent = (learningDb, studentId = defaultStudentId) => {
  learningDb.prepare("INSERT OR IGNORE INTO students (id, name) VALUES (?, ?)").run(studentId, "默认孩子");
};

export const ensureDefaultStudent = (learningDb, catalogDb, studentId = defaultStudentId) => {
  ensureStudent(learningDb, studentId);
  const progress = oneRow(learningDb, "SELECT student_id FROM progress WHERE student_id = ?", studentId);
  if (!progress) {
    const lesson = defaultProgress(catalogDb);
    learningDb.prepare("INSERT INTO progress (student_id, grade, lesson_id) VALUES (?, ?, ?)").run(studentId, lesson.grade, lesson.lesson_id);
  }
};

export const getLessons = (catalogDb) => {
  const lessons = allRows(catalogDb, "SELECT id, grade, unit, number, title FROM lessons ORDER BY grade, unit, number");
  const words = allRows(catalogDb, "SELECT id, lesson_id, text, pinyin, category, grade, lesson_title FROM words ORDER BY lesson_id, word_order");
  const chars = allRows(catalogDb, "SELECT word_id, char FROM word_chars ORDER BY word_id, char_order");
  const charsByWord = new Map();
  for (const row of chars) {
    charsByWord.set(row.word_id, [...(charsByWord.get(row.word_id) || []), row.char]);
  }
  const wordsByLesson = new Map();
  for (const row of words) {
    const word = {
      id: row.id,
      text: row.text,
      pinyin: row.pinyin,
      chars: charsByWord.get(row.id) || [],
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      category: normalizeCategory(row.category),
    };
    wordsByLesson.set(row.lesson_id, [...(wordsByLesson.get(row.lesson_id) || []), word]);
  }
  return lessons.map((lesson) => ({
    id: lesson.id,
    grade: lesson.grade,
    unit: lesson.unit,
    number: lesson.number,
    title: lesson.title,
    words: wordsByLesson.get(lesson.id) || [],
  }));
};

export const getCompanionWords = (catalogDb) => {
  const rows = allRows(catalogDb, "SELECT target_char, text, pinyin FROM companion_words ORDER BY target_char, companion_order");
  const chars = allRows(
    catalogDb,
    "SELECT target_char, companion_text, companion_pinyin, char FROM companion_word_chars ORDER BY target_char, companion_text, companion_pinyin, char_order",
  );
  const charsByCompanion = new Map();
  for (const row of chars) {
    const key = `${row.target_char}\u0000${row.companion_text}\u0000${row.companion_pinyin}`;
    charsByCompanion.set(key, [...(charsByCompanion.get(key) || []), row.char]);
  }
  const companions = {};
  for (const row of rows) {
    const key = `${row.target_char}\u0000${row.text}\u0000${row.pinyin}`;
    companions[row.target_char] = [
      ...(companions[row.target_char] || []),
      { text: row.text, pinyin: row.pinyin, chars: charsByCompanion.get(key) || [] },
    ];
  }
  return companions;
};

export const getState = (learningDb, catalogDb, studentId = defaultStudentId) => {
  ensureDefaultStudent(learningDb, catalogDb, studentId);
  const progress = oneRow(learningDb, "SELECT grade, lesson_id FROM progress WHERE student_id = ?", studentId) || defaultProgress(catalogDb);
  const wordStats = {};
  for (const row of allRows(learningDb, "SELECT * FROM word_stats WHERE student_id = ?", studentId)) {
    wordStats[row.word_id] = {
      attempts: row.attempts,
      mistakes: row.mistakes,
      streak: row.streak,
      lastReviewedAt: row.last_reviewed_at || undefined,
      lastMistakeAt: row.last_mistake_at || undefined,
    };
  }
  const charStats = {};
  for (const row of allRows(learningDb, "SELECT * FROM char_stats WHERE student_id = ?", studentId)) {
    charStats[row.char] = {
      attempts: row.attempts,
      mistakes: row.mistakes,
      lastReviewedAt: row.last_reviewed_at || undefined,
    };
  }
  const logs = allRows(learningDb, "SELECT id, date FROM review_logs WHERE student_id = ? ORDER BY date DESC LIMIT 120", studentId).map((log) => {
    const items = allRows(learningDb, "SELECT word_id, is_wrong FROM review_log_words WHERE log_id = ? ORDER BY item_order", log.id);
    return {
      id: log.id,
      date: log.date,
      wordIds: items.map((item) => item.word_id),
      wrongWordIds: items.filter((item) => item.is_wrong).map((item) => item.word_id),
    };
  });
  const customLessons = allRows(
    learningDb,
    "SELECT id, grade, unit, number, title FROM custom_lessons WHERE student_id = ? ORDER BY grade, unit, number",
    studentId,
  );
  const customWords = getCustomWords(learningDb, studentId);
  const customWordsByLesson = new Map();
  for (const word of customWords) {
    customWordsByLesson.set(word.lessonId, [...(customWordsByLesson.get(word.lessonId) || []), word]);
  }

  return {
    progress: { grade: progress?.grade || 3, lessonId: progress?.lesson_id || "" },
    wordStats,
    charStats,
    customLessons: customLessons.map((lesson) => ({ ...lesson, words: customWordsByLesson.get(lesson.id) || [] })),
    customWords,
    logs,
  };
};

const getCustomWords = (learningDb, studentId) => {
  const words = allRows(
    learningDb,
    "SELECT id, lesson_id, text, pinyin, category, grade, lesson_title FROM custom_words WHERE student_id = ? ORDER BY word_order",
    studentId,
  );
  const chars = allRows(learningDb, "SELECT word_id, char FROM custom_word_chars WHERE student_id = ? ORDER BY word_id, char_order", studentId);
  const charsByWord = new Map();
  for (const row of chars) {
    charsByWord.set(row.word_id, [...(charsByWord.get(row.word_id) || []), row.char]);
  }
  return words.map((word) => ({
    id: word.id,
    text: word.text,
    pinyin: word.pinyin,
    chars: charsByWord.get(word.id) || [],
    grade: word.grade,
    lessonId: word.lesson_id,
    lessonTitle: word.lesson_title,
    category: normalizeCategory(word.category),
  }));
};

export const saveState = (learningDb, state, studentId = defaultStudentId) => {
  runTransaction(learningDb, () => {
    ensureStudent(learningDb, studentId);
    learningDb
      .prepare(
        `INSERT INTO progress (student_id, grade, lesson_id)
         VALUES (?, ?, ?)
         ON CONFLICT(student_id) DO UPDATE SET grade = excluded.grade, lesson_id = excluded.lesson_id`,
      )
      .run(studentId, state.progress.grade, state.progress.lessonId);

    learningDb.prepare("DELETE FROM word_stats WHERE student_id = ?").run(studentId);
    const insertWordStat = learningDb.prepare(
      `INSERT INTO word_stats (student_id, word_id, attempts, mistakes, streak, last_reviewed_at, last_mistake_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [wordId, stat] of Object.entries(state.wordStats || {})) {
      insertWordStat.run(studentId, wordId, stat.attempts || 0, stat.mistakes || 0, stat.streak || 0, stat.lastReviewedAt || null, stat.lastMistakeAt || null);
    }

    learningDb.prepare("DELETE FROM char_stats WHERE student_id = ?").run(studentId);
    const insertCharStat = learningDb.prepare(
      `INSERT INTO char_stats (student_id, char, attempts, mistakes, last_reviewed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [char, stat] of Object.entries(state.charStats || {})) {
      insertCharStat.run(studentId, char, stat.attempts || 0, stat.mistakes || 0, stat.lastReviewedAt || null);
    }

    learningDb.prepare("DELETE FROM review_logs WHERE student_id = ?").run(studentId);
    const insertLog = learningDb.prepare("INSERT INTO review_logs (id, student_id, date) VALUES (?, ?, ?)");
    const insertLogWord = learningDb.prepare("INSERT INTO review_log_words (log_id, word_id, is_wrong, item_order) VALUES (?, ?, ?, ?)");
    for (const log of (state.logs || []).slice(0, 120)) {
      const wrongIds = new Set(log.wrongWordIds || []);
      insertLog.run(log.id, studentId, log.date);
      for (const [index, wordId] of (log.wordIds || []).entries()) {
        insertLogWord.run(log.id, wordId, wrongIds.has(wordId) ? 1 : 0, index);
      }
    }

    saveCustomData(learningDb, state, studentId);
  });
};

const saveCustomData = (learningDb, state, studentId) => {
  learningDb.prepare("DELETE FROM custom_lessons WHERE student_id = ?").run(studentId);
  learningDb.prepare("DELETE FROM custom_words WHERE student_id = ?").run(studentId);
  const insertLesson = learningDb.prepare("INSERT INTO custom_lessons (student_id, id, grade, unit, number, title) VALUES (?, ?, ?, ?, ?, ?)");
  const insertWord = learningDb.prepare(
    `INSERT INTO custom_words (student_id, id, lesson_id, text, pinyin, category, grade, lesson_title, word_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChar = learningDb.prepare("INSERT INTO custom_word_chars (student_id, word_id, char, char_order) VALUES (?, ?, ?, ?)");
  const wordIds = new Set();
  for (const lesson of state.customLessons || []) {
    insertLesson.run(studentId, lesson.id, lesson.grade, lesson.unit, lesson.number, lesson.title);
    for (const [index, word] of (lesson.words || []).entries()) {
      wordIds.add(word.id);
      insertWord.run(studentId, word.id, word.lessonId, word.text, word.pinyin, normalizeCategory(word.category), word.grade, word.lessonTitle, index);
      for (const [charIndex, char] of (word.chars || []).entries()) {
        insertChar.run(studentId, word.id, char, charIndex);
      }
    }
  }
  for (const [index, word] of (state.customWords || []).entries()) {
    if (wordIds.has(word.id)) {
      continue;
    }
    insertWord.run(studentId, word.id, word.lessonId, word.text, word.pinyin, normalizeCategory(word.category), word.grade, word.lessonTitle, index);
    for (const [charIndex, char] of (word.chars || []).entries()) {
      insertChar.run(studentId, word.id, char, charIndex);
    }
  }
};
