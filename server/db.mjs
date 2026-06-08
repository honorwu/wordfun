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

CREATE TABLE IF NOT EXISTS catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('word_table', 'classical_text', 'summary')),
  grade INTEGER CHECK (grade BETWEEN 1 AND 6),
  term INTEGER CHECK (term IN (1, 2)),
  sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  term INTEGER NOT NULL CHECK (term IN (1, 2)),
  term_name TEXT NOT NULL CHECK (term_name IN ('上册', '下册')),
  unit_name TEXT NOT NULL,
  unit_index INTEGER,
  section TEXT NOT NULL,
  lesson_number REAL NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  lesson_type TEXT NOT NULL CHECK (lesson_type IN ('正常课文', '古诗词', '其他')),
  lesson_kind TEXT NOT NULL CHECK (lesson_kind IN ('regular', 'garden', 'pinyin', 'classical_poetry', 'classical_prose', 'traditional_rhyme')),
  is_classical INTEGER NOT NULL CHECK (is_classical IN (0, 1)),
  direct_dictation INTEGER NOT NULL CHECK (direct_dictation IN (0, 1)),
  source_file TEXT NOT NULL REFERENCES source_files(path) ON DELETE RESTRICT,
  source_row INTEGER NOT NULL,
  UNIQUE (grade, term, section, lesson_number, title)
);

CREATE TABLE IF NOT EXISTS characters (
  char TEXT PRIMARY KEY,
  first_pinyin TEXT,
  first_lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  first_grade INTEGER CHECK (first_grade BETWEEN 1 AND 6),
  first_term INTEGER CHECK (first_term IN (1, 2))
);

CREATE TABLE IF NOT EXISTS lesson_characters (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  pinyin TEXT,
  char_order INTEGER NOT NULL,
  source_column TEXT NOT NULL CHECK (source_column IN ('识字表', '写字表')),
  PRIMARY KEY (lesson_id, char, category)
);

CREATE TABLE IF NOT EXISTS words (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  word_kind TEXT NOT NULL CHECK (word_kind IN ('textbook', 'supplement', 'classical_title', 'classical_line')),
  source_file TEXT NOT NULL REFERENCES source_files(path) ON DELETE RESTRICT,
  source_row INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS word_characters (
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  char_order INTEGER NOT NULL,
  PRIMARY KEY (word_id, char, char_order)
);

CREATE TABLE IF NOT EXISTS lesson_words (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  word_order INTEGER NOT NULL,
  source_column TEXT NOT NULL CHECK (source_column IN ('词语表', '未覆盖生字组词', '古诗词标题', '古诗词正文')),
  target_char TEXT,
  UNIQUE (lesson_id, word_id, source_column, target_char)
);

CREATE TABLE IF NOT EXISTS lesson_uncovered_characters (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  source_file TEXT NOT NULL REFERENCES source_files(path) ON DELETE RESTRICT,
  source_row INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, char)
);

CREATE TABLE IF NOT EXISTS char_companion_words (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  companion_rank INTEGER NOT NULL CHECK (companion_rank >= 1),
  source TEXT NOT NULL CHECK (source IN ('textbook_word', 'supplement_word')),
  source_lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  PRIMARY KEY (lesson_id, char, companion_rank),
  UNIQUE (lesson_id, char, word)
);

CREATE TABLE IF NOT EXISTS classical_texts (
  id TEXT PRIMARY KEY,
  lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  term INTEGER NOT NULL CHECK (term IN (1, 2)),
  unit_index INTEGER,
  title TEXT NOT NULL,
  title_pinyin TEXT NOT NULL,
  author TEXT,
  dynasty TEXT,
  source_label TEXT,
  source_file TEXT NOT NULL REFERENCES source_files(path) ON DELETE RESTRICT,
  text_order INTEGER NOT NULL,
  UNIQUE (source_file, title, text_order)
);

CREATE TABLE IF NOT EXISTS classical_lines (
  text_id TEXT NOT NULL REFERENCES classical_texts(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  PRIMARY KEY (text_id, line_order)
);

CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(grade, term, sort_order);
CREATE INDEX IF NOT EXISTS idx_lesson_characters_char ON lesson_characters(char, category);
CREATE INDEX IF NOT EXISTS idx_words_text ON words(text);
CREATE INDEX IF NOT EXISTS idx_word_characters_char ON word_characters(char);
CREATE INDEX IF NOT EXISTS idx_lesson_words_scope ON lesson_words(lesson_id, word_order);
CREATE INDEX IF NOT EXISTS idx_lesson_uncovered_characters_char ON lesson_uncovered_characters(char);
CREATE INDEX IF NOT EXISTS idx_companions_char ON char_companion_words(char, source);
CREATE INDEX IF NOT EXISTS idx_classical_texts_scope ON classical_texts(grade, term, unit_index, text_order);
CREATE INDEX IF NOT EXISTS idx_classical_lines_text ON classical_lines(text);

CREATE VIEW IF NOT EXISTS lesson_chars AS
SELECT lesson_id, char, category, pinyin, char_order, source_column AS source_table
FROM lesson_characters;

CREATE VIEW IF NOT EXISTS textbook_words AS
SELECT lw.id, lw.lesson_id, w.text, w.pinyin, lw.word_order, lw.source_column AS source_table
FROM lesson_words lw
JOIN words w ON w.id = lw.word_id
WHERE lw.source_column = '词语表';
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
  streak INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  last_mistake_at TEXT,
  PRIMARY KEY (student_id, char)
);

CREATE TABLE IF NOT EXISTS char_word_evidence (
  student_id TEXT NOT NULL,
  char TEXT NOT NULL,
  word_text TEXT NOT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0,
  mistake_count INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  last_mistake_at TEXT,
  PRIMARY KEY (student_id, char, word_text),
  FOREIGN KEY (student_id, char) REFERENCES char_stats(student_id, char) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_char_word_evidence_student_char ON char_word_evidence(student_id, char);

CREATE TABLE IF NOT EXISTS unsuitable_words (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  grade INTEGER NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  flagged_count INTEGER NOT NULL DEFAULT 1,
  first_flagged_at TEXT NOT NULL,
  last_flagged_at TEXT NOT NULL,
  PRIMARY KEY (student_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_unsuitable_words_student_date ON unsuitable_words(student_id, last_flagged_at DESC);

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

CREATE TABLE IF NOT EXISTS review_log_chars (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  char TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  char_order INTEGER NOT NULL,
  PRIMARY KEY (log_id, word_id, char)
);

CREATE INDEX IF NOT EXISTS idx_review_logs_student_date ON review_logs(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_review_log_words_log ON review_log_words(log_id, item_order);
CREATE INDEX IF NOT EXISTS idx_review_log_chars_log ON review_log_chars(log_id, item_order, char_order);

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

const printHistorySchemaSql = `
CREATE TABLE IF NOT EXISTS print_logs (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  local_date TEXT NOT NULL,
  practice_mode TEXT NOT NULL CHECK (practice_mode IN ('lesson', 'screening')),
  lesson_id TEXT NOT NULL,
  lesson_label TEXT NOT NULL,
  title TEXT NOT NULL,
  range_label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_log_items (
  log_id TEXT NOT NULL REFERENCES print_logs(id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL,
  word_id TEXT NOT NULL,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  chars_json TEXT NOT NULL,
  grade INTEGER NOT NULL,
  word_lesson_id TEXT NOT NULL,
  lesson_title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  reasons_json TEXT NOT NULL,
  PRIMARY KEY (log_id, item_order)
);
`;

const printHistoryIndexSql = `
CREATE INDEX IF NOT EXISTS idx_print_logs_student_date ON print_logs(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_print_log_items_log ON print_log_items(log_id, item_order);
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

export const openLearningDatabase = (databasePath = defaultLearningDatabasePath) => {
  const db = openDatabaseWithSchema(databasePath, learningSchemaSql);
  migrateLearningDatabase(db);
  return db;
};

const migrateLearningDatabase = (db) => {
  const charStatColumns = new Set(db.prepare("PRAGMA table_info(char_stats)").all().map((column) => column.name));
  if (!charStatColumns.has("streak")) {
    db.exec("ALTER TABLE char_stats ADD COLUMN streak INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE char_stats SET streak = attempts WHERE mistakes = 0");
  }
  if (!charStatColumns.has("last_mistake_at")) {
    db.exec("ALTER TABLE char_stats ADD COLUMN last_mistake_at TEXT");
  }
  ensurePrintHistoryTables(db);
};

const tableExists = (db, tableName) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));

const ensurePrintHistoryTables = (db) => {
  if (!tableExists(db, "print_logs") || !tableExists(db, "print_log_items")) {
    db.exec(printHistorySchemaSql);
  }
  db.exec(printHistoryIndexSql);
};

export const requireCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => {
  if (!existsSync(databasePath)) {
    throw new Error(`Catalog SQLite database not found at ${databasePath}. Provide the catalog database before starting the server.`);
  }
  return openCatalogDatabase(databasePath);
};

export const readJson = (relativePath) => JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));

export const normalizeCategory = (category) => (category === "一类" ? "一类" : "二类");

const normalizeGrade = (grade) => {
  const value = Number(grade);
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : 1;
};

const parseStringArray = (value) => {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
};

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
  oneRow(
    catalogDb,
    `SELECT id AS lesson_id, grade
     FROM lessons
     WHERE grade = 3
       AND EXISTS (SELECT 1 FROM lesson_characters lc WHERE lc.lesson_id = lessons.id)
     ORDER BY term, sort_order
     LIMIT 1`,
  ) ||
  oneRow(
    catalogDb,
    `SELECT id AS lesson_id, grade
     FROM lessons
     WHERE EXISTS (SELECT 1 FROM lesson_characters lc WHERE lc.lesson_id = lessons.id)
     ORDER BY grade, term, sort_order
     LIMIT 1`,
  ) || {
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
  const lessons = allRows(
    catalogDb,
    `SELECT id, grade, term AS unit, lesson_number AS number, sort_order, title, lesson_kind, direct_dictation
     FROM lessons
     WHERE EXISTS (
       SELECT 1
       FROM lesson_characters lc
       WHERE lc.lesson_id = lessons.id
     )
     ORDER BY grade, term, sort_order`,
  );
  const words = allRows(
    catalogDb,
    `SELECT
       lc.lesson_id,
       lc.char,
       COALESCE(MAX(CASE WHEN lc.category = '一类' THEN '一类' END), '二类') AS category,
       COALESCE(
         MAX(CASE WHEN lc.category = '一类' THEN lc.pinyin END),
         MAX(lc.pinyin),
         ''
       ) AS pinyin,
       MIN(lc.char_order) AS word_order,
       l.grade,
       l.title AS lesson_title
     FROM lesson_characters lc
     JOIN lessons l ON l.id = lc.lesson_id
     GROUP BY lc.lesson_id, lc.char
     ORDER BY lc.lesson_id, word_order`,
  );
  const companionRows = allRows(
    catalogDb,
    "SELECT lesson_id, char, word, pinyin FROM char_companion_words ORDER BY lesson_id, char, companion_rank",
  );
  const wordsByLesson = new Map();
  for (const row of words) {
    const word = {
      id: `${row.lesson_id}-char-${row.char}`,
      text: row.char,
      pinyin: row.pinyin,
      chars: [row.char],
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      category: normalizeCategory(row.category),
    };
    wordsByLesson.set(row.lesson_id, [...(wordsByLesson.get(row.lesson_id) || []), word]);
  }
  const companionsByLesson = new Map();
  for (const row of companionRows) {
    const lessonCompanions = companionsByLesson.get(row.lesson_id) || {};
    lessonCompanions[row.char] = [
      ...(lessonCompanions[row.char] || []),
      { text: row.word, pinyin: row.pinyin, chars: Array.from(row.word).filter((char) => /\p{Script=Han}/u.test(char)) },
    ];
    companionsByLesson.set(row.lesson_id, lessonCompanions);
  }
  return lessons.map((lesson) => ({
    id: lesson.id,
    grade: lesson.grade,
    unit: lesson.unit,
    number: lesson.number,
    sortOrder: lesson.sort_order,
    title: lesson.title,
    lessonKind: lesson.lesson_kind,
    directDictation: Boolean(lesson.direct_dictation),
    words: wordsByLesson.get(lesson.id) || [],
    textCompanions: companionsByLesson.get(lesson.id) || {},
  }));
};

export const getCompanionWords = (catalogDb) => {
  const rows = allRows(catalogDb, "SELECT char, word, pinyin FROM char_companion_words ORDER BY char, companion_rank");
  const companions = {};
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.char}\u0000${row.word}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    companions[row.char] = [...(companions[row.char] || []), { text: row.word, pinyin: row.pinyin, chars: Array.from(row.word) }];
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
      streak: row.streak ?? (row.mistakes === 0 ? row.attempts : 0),
      correctWordTexts: [],
      wrongWordTexts: [],
      lastReviewedAt: row.last_reviewed_at || undefined,
      lastMistakeAt: row.last_mistake_at || undefined,
    };
  }
  for (const row of allRows(learningDb, "SELECT char, word_text, correct_count, mistake_count FROM char_word_evidence WHERE student_id = ?", studentId)) {
    const stat =
      charStats[row.char] ||
      (charStats[row.char] = {
        attempts: 0,
        mistakes: 0,
        streak: 0,
        correctWordTexts: [],
        wrongWordTexts: [],
      });
    if (row.correct_count > 0) {
      stat.correctWordTexts.push(row.word_text);
    }
    if (row.mistake_count > 0) {
      stat.wrongWordTexts.push(row.word_text);
    }
  }
  const logs = allRows(learningDb, "SELECT id, date FROM review_logs WHERE student_id = ? ORDER BY date DESC LIMIT 120", studentId).map((log) => {
    const items = allRows(learningDb, "SELECT word_id, is_wrong FROM review_log_words WHERE log_id = ? ORDER BY item_order", log.id);
    const wrongChars = allRows(learningDb, "SELECT word_id, char FROM review_log_chars WHERE log_id = ? ORDER BY item_order, char_order", log.id);
    return {
      id: log.id,
      date: log.date,
      wordIds: items.map((item) => item.word_id),
      wrongWordIds: items.filter((item) => item.is_wrong).map((item) => item.word_id),
      wrongChars: wrongChars.map((item) => ({ wordId: item.word_id, char: item.char })),
    };
  });
  const printLogs = allRows(
    learningDb,
    `SELECT id, date, local_date, practice_mode, lesson_id, lesson_label, title, range_label
     FROM print_logs
     WHERE student_id = ?
     ORDER BY date DESC
     LIMIT 180`,
    studentId,
  ).map((log) => {
    const items = allRows(
      learningDb,
      `SELECT word_id, text, pinyin, chars_json, grade, word_lesson_id, lesson_title, category, reasons_json
       FROM print_log_items
       WHERE log_id = ?
       ORDER BY item_order`,
      log.id,
    );
    return {
      id: log.id,
      date: log.date,
      localDate: log.local_date,
      practiceMode: log.practice_mode === "lesson" ? "lesson" : "screening",
      lessonId: log.lesson_id,
      lessonLabel: log.lesson_label,
      title: log.title,
      rangeLabel: log.range_label,
      items: items.map((item) => ({
        word: {
          id: item.word_id,
          text: item.text,
          pinyin: item.pinyin,
          chars: parseStringArray(item.chars_json),
          grade: normalizeGrade(item.grade),
          lessonId: item.word_lesson_id,
          lessonTitle: item.lesson_title,
          category: normalizeCategory(item.category),
        },
        reasons: parseStringArray(item.reasons_json),
      })),
    };
  });
  const unsuitableWords = {};
  for (const row of allRows(learningDb, "SELECT * FROM unsuitable_words WHERE student_id = ? ORDER BY last_flagged_at DESC", studentId)) {
    unsuitableWords[row.word_id] = {
      wordId: row.word_id,
      text: row.text,
      pinyin: row.pinyin,
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      category: normalizeCategory(row.category),
      flaggedCount: row.flagged_count,
      firstFlaggedAt: row.first_flagged_at,
      lastFlaggedAt: row.last_flagged_at,
    };
  }
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
    unsuitableWords,
    customLessons: customLessons.map((lesson) => ({ ...lesson, words: customWordsByLesson.get(lesson.id) || [] })),
    customWords,
    logs,
    printLogs,
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

    learningDb.prepare("DELETE FROM char_word_evidence WHERE student_id = ?").run(studentId);
    learningDb.prepare("DELETE FROM char_stats WHERE student_id = ?").run(studentId);
    const insertCharStat = learningDb.prepare(
      `INSERT INTO char_stats (student_id, char, attempts, mistakes, streak, last_reviewed_at, last_mistake_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCharEvidence = learningDb.prepare(
      `INSERT INTO char_word_evidence (student_id, char, word_text, correct_count, mistake_count, last_reviewed_at, last_mistake_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [char, stat] of Object.entries(state.charStats || {})) {
      insertCharStat.run(studentId, char, stat.attempts || 0, stat.mistakes || 0, stat.streak || 0, stat.lastReviewedAt || null, stat.lastMistakeAt || null);
      const correctWordTexts = new Set((stat.correctWordTexts || []).filter(Boolean));
      const wrongWordTexts = new Set((stat.wrongWordTexts || []).filter(Boolean));
      const wordTexts = new Set([...correctWordTexts, ...wrongWordTexts]);
      for (const wordText of wordTexts) {
        insertCharEvidence.run(
          studentId,
          char,
          wordText,
          correctWordTexts.has(wordText) ? 1 : 0,
          wrongWordTexts.has(wordText) ? 1 : 0,
          stat.lastReviewedAt || null,
          wrongWordTexts.has(wordText) ? stat.lastMistakeAt || null : null,
        );
      }
    }

    const now = new Date().toISOString();
    learningDb.prepare("DELETE FROM unsuitable_words WHERE student_id = ?").run(studentId);
    const insertUnsuitableWord = learningDb.prepare(
      `INSERT INTO unsuitable_words (
         student_id, word_id, text, pinyin, grade, lesson_id, lesson_title, category, flagged_count, first_flagged_at, last_flagged_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [wordId, word] of Object.entries(state.unsuitableWords || {})) {
      const firstFlaggedAt = word.firstFlaggedAt || word.lastFlaggedAt || now;
      insertUnsuitableWord.run(
        studentId,
        word.wordId || wordId,
        word.text || "",
        word.pinyin || "",
        word.grade || 1,
        word.lessonId || "",
        word.lessonTitle || "",
        normalizeCategory(word.category),
        word.flaggedCount || 1,
        firstFlaggedAt,
        word.lastFlaggedAt || firstFlaggedAt,
      );
    }

    learningDb.prepare("DELETE FROM review_logs WHERE student_id = ?").run(studentId);
    const insertLog = learningDb.prepare("INSERT INTO review_logs (id, student_id, date) VALUES (?, ?, ?)");
    const insertLogWord = learningDb.prepare("INSERT INTO review_log_words (log_id, word_id, is_wrong, item_order) VALUES (?, ?, ?, ?)");
    const insertLogChar = learningDb.prepare("INSERT INTO review_log_chars (log_id, word_id, char, item_order, char_order) VALUES (?, ?, ?, ?, ?)");
    for (const log of (state.logs || []).slice(0, 120)) {
      const wrongIds = new Set(log.wrongWordIds || []);
      const wrongChars = log.wrongChars || [];
      const wrongCharWordIds = new Set(wrongChars.map((item) => item.wordId));
      insertLog.run(log.id, studentId, log.date);
      for (const [index, wordId] of (log.wordIds || []).entries()) {
        insertLogWord.run(log.id, wordId, wrongIds.has(wordId) || wrongCharWordIds.has(wordId) ? 1 : 0, index);
      }
      for (const [index, item] of wrongChars.entries()) {
        insertLogChar.run(log.id, item.wordId, item.char, Math.max(0, (log.wordIds || []).indexOf(item.wordId)), index);
      }
    }

    learningDb.prepare("DELETE FROM print_logs WHERE student_id = ?").run(studentId);
    const insertPrintLog = learningDb.prepare(
      `INSERT INTO print_logs (
         id, student_id, date, local_date, practice_mode, lesson_id, lesson_label, title, range_label
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPrintLogItem = learningDb.prepare(
      `INSERT INTO print_log_items (
         log_id, item_order, word_id, text, pinyin, chars_json, grade, word_lesson_id, lesson_title, category, reasons_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const log of (state.printLogs || []).slice(0, 180)) {
      const practiceMode = log.practiceMode === "lesson" ? "lesson" : "screening";
      const items = Array.isArray(log.items) ? log.items.filter((item) => item?.word?.id) : [];
      if (items.length === 0) {
        continue;
      }
      insertPrintLog.run(
        log.id,
        studentId,
        log.date || now,
        log.localDate || (log.date || now).slice(0, 10),
        practiceMode,
        log.lessonId || "",
        log.lessonLabel || "",
        log.title || (practiceMode === "lesson" ? "本课词语默写" : "历史生字筛查"),
        log.rangeLabel || "",
      );
      for (const [index, item] of items.entries()) {
        const word = item.word;
        insertPrintLogItem.run(
          log.id,
          index,
          word.id,
          word.text || "",
          word.pinyin || "",
          JSON.stringify(Array.isArray(word.chars) ? word.chars.filter(Boolean) : []),
          normalizeGrade(word.grade),
          word.lessonId || "",
          word.lessonTitle || "",
          normalizeCategory(word.category),
          JSON.stringify(Array.isArray(item.reasons) ? item.reasons.filter(Boolean) : []),
        );
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
