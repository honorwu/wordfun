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
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  lesson_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS word_stats (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  mistakes INTEGER NOT NULL CHECK (mistakes >= 0 AND mistakes <= attempts),
  streak INTEGER NOT NULL CHECK (streak >= 0),
  last_reviewed_at TEXT,
  last_mistake_at TEXT,
  PRIMARY KEY (student_id, word_id)
);

CREATE TABLE IF NOT EXISTS char_stats (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  mistakes INTEGER NOT NULL CHECK (mistakes >= 0 AND mistakes <= attempts),
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  last_reviewed_at TEXT,
  last_mistake_at TEXT,
  PRIMARY KEY (student_id, char)
);

CREATE TABLE IF NOT EXISTS char_word_evidence (
  student_id TEXT NOT NULL,
  char TEXT NOT NULL,
  word_text TEXT NOT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count IN (0, 1)),
  mistake_count INTEGER NOT NULL DEFAULT 0 CHECK (mistake_count IN (0, 1)),
  last_reviewed_at TEXT,
  last_mistake_at TEXT,
  PRIMARY KEY (student_id, char, word_text),
  FOREIGN KEY (student_id, char) REFERENCES char_stats(student_id, char) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_logs (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  practice_mode TEXT CHECK (practice_mode IN ('lesson', 'history'))
);

CREATE TABLE IF NOT EXISTS review_log_lessons (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL,
  lesson_title TEXT NOT NULL,
  lesson_order INTEGER NOT NULL CHECK (lesson_order >= 0),
  PRIMARY KEY (log_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS review_log_words (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  is_wrong INTEGER NOT NULL CHECK (is_wrong IN (0, 1)),
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  PRIMARY KEY (log_id, word_id)
);

CREATE TABLE IF NOT EXISTS review_log_chars (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  char TEXT NOT NULL,
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  char_order INTEGER NOT NULL CHECK (char_order >= 0),
  PRIMARY KEY (log_id, word_id, char)
);

CREATE INDEX IF NOT EXISTS idx_review_logs_student_date ON review_logs(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_review_log_lessons_log ON review_log_lessons(log_id, lesson_order);
CREATE INDEX IF NOT EXISTS idx_review_log_words_log ON review_log_words(log_id, item_order);
CREATE INDEX IF NOT EXISTS idx_review_log_chars_log ON review_log_chars(log_id, item_order, char_order);
`;

export const ensureDataDir = () => {
  mkdirSync(dataDir, { recursive: true });
};

const openDatabaseWithSchema = (databasePath, schemaSql) => {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(schemaSql);
  return db;
};

export const openCatalogDatabase = (databasePath = defaultCatalogDatabasePath) => openDatabaseWithSchema(databasePath, catalogSchemaSql);

export const openLearningDatabase = (databasePath = defaultLearningDatabasePath) => {
  const db = openDatabaseWithSchema(databasePath, learningSchemaSql);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
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
  const reviewLogColumns = new Set(db.prepare("PRAGMA table_info(review_logs)").all().map((column) => column.name));
  if (!reviewLogColumns.has("practice_mode")) {
    db.exec("ALTER TABLE review_logs ADD COLUMN practice_mode TEXT CHECK (practice_mode IN ('lesson', 'history'))");
  }
  db.exec(`
    DROP TABLE IF EXISTS print_log_items;
    DROP TABLE IF EXISTS print_logs;
    DROP TABLE IF EXISTS custom_word_chars;
    DROP TABLE IF EXISTS custom_words;
    DROP TABLE IF EXISTS custom_lessons;
    DROP TABLE IF EXISTS unsuitable_words;
    DROP INDEX IF EXISTS idx_char_word_evidence_student_char;
  `);
  db.exec("PRAGMA optimize");
};

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
  const progress = oneRow(learningDb, "SELECT grade, lesson_id FROM progress WHERE student_id = ?", studentId);
  const savedLesson = progress ? oneRow(catalogDb, "SELECT grade FROM lessons WHERE id = ?", progress.lesson_id) : null;
  if (savedLesson) {
    if (progress.grade !== savedLesson.grade) {
      learningDb.prepare("UPDATE progress SET grade = ? WHERE student_id = ?").run(savedLesson.grade, studentId);
    }
    return;
  }
  const lesson = defaultProgress(catalogDb);
  learningDb
    .prepare(
      `INSERT INTO progress (student_id, grade, lesson_id)
       VALUES (?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET grade = excluded.grade, lesson_id = excluded.lesson_id`,
    )
    .run(studentId, lesson.grade, lesson.lesson_id);
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
        OR EXISTS (
          SELECT 1
          FROM classical_texts ct
          WHERE ct.lesson_id = lessons.id
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
  const textbookRows = allRows(
    catalogDb,
    `SELECT
       lw.id,
       lw.lesson_id,
       w.text,
       w.pinyin,
       lw.word_order,
       l.grade,
       l.title AS lesson_title,
       CASE
         WHEN EXISTS (
           SELECT 1
           FROM word_characters wc
           JOIN lesson_characters lc
             ON lc.lesson_id = lw.lesson_id
            AND lc.char = wc.char
            AND lc.category = '一类'
           WHERE wc.word_id = lw.word_id
         ) THEN '一类'
         ELSE '二类'
       END AS category
     FROM lesson_words lw
     JOIN words w ON w.id = lw.word_id
     JOIN lessons l ON l.id = lw.lesson_id
     WHERE lw.source_column = '词语表'
    ORDER BY lw.lesson_id, lw.word_order`,
  );
  const classicalTextRows = allRows(
    catalogDb,
    `SELECT id, lesson_id, title, title_pinyin, author, dynasty, text_order
     FROM classical_texts
     WHERE lesson_id IS NOT NULL
     ORDER BY lesson_id, text_order`,
  );
  const classicalLineRows = allRows(
    catalogDb,
    `SELECT text_id, line_order, text, pinyin
     FROM classical_lines
     ORDER BY text_id, line_order`,
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
  const textbookWordsByLesson = new Map();
  for (const row of textbookRows) {
    const word = {
      id: row.id,
      text: row.text,
      pinyin: row.pinyin,
      chars: Array.from(row.text).filter((char) => /\p{Script=Han}/u.test(char)),
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      category: normalizeCategory(row.category),
    };
    textbookWordsByLesson.set(row.lesson_id, [...(textbookWordsByLesson.get(row.lesson_id) || []), word]);
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
  const classicalLinesByText = new Map();
  for (const row of classicalLineRows) {
    classicalLinesByText.set(row.text_id, [
      ...(classicalLinesByText.get(row.text_id) || []),
      { text: row.text, pinyin: row.pinyin },
    ]);
  }
  const classicalTextsByLesson = new Map();
  for (const row of classicalTextRows) {
    const text = {
      id: row.id,
      title: row.title,
      titlePinyin: row.title_pinyin,
      author: row.author || undefined,
      dynasty: row.dynasty || undefined,
      lines: classicalLinesByText.get(row.id) || [],
    };
    classicalTextsByLesson.set(row.lesson_id, [...(classicalTextsByLesson.get(row.lesson_id) || []), text]);
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
    textbookWords: textbookWordsByLesson.get(lesson.id) || [],
    textCompanions: companionsByLesson.get(lesson.id) || {},
    classicalTexts: classicalTextsByLesson.get(lesson.id) || [],
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
  const logRows = allRows(learningDb, "SELECT id, date, practice_mode FROM review_logs WHERE student_id = ? ORDER BY date DESC LIMIT 120", studentId);
  const wordsByLog = new Map();
  const wrongCharsByLog = new Map();
  const lessonsByLog = new Map();
  if (logRows.length > 0) {
    const placeholders = logRows.map(() => "?").join(", ");
    const logIds = logRows.map((log) => log.id);
    for (const item of allRows(
      learningDb,
      `SELECT log_id, word_id, is_wrong FROM review_log_words WHERE log_id IN (${placeholders}) ORDER BY log_id, item_order`,
      ...logIds,
    )) {
      wordsByLog.set(item.log_id, [...(wordsByLog.get(item.log_id) || []), item]);
    }
    for (const item of allRows(
      learningDb,
      `SELECT log_id, word_id, char FROM review_log_chars WHERE log_id IN (${placeholders}) ORDER BY log_id, item_order, char_order`,
      ...logIds,
    )) {
      wrongCharsByLog.set(item.log_id, [...(wrongCharsByLog.get(item.log_id) || []), item]);
    }
    for (const item of allRows(
      learningDb,
      `SELECT log_id, lesson_id, lesson_title FROM review_log_lessons WHERE log_id IN (${placeholders}) ORDER BY log_id, lesson_order`,
      ...logIds,
    )) {
      lessonsByLog.set(item.log_id, [...(lessonsByLog.get(item.log_id) || []), { id: item.lesson_id, title: item.lesson_title }]);
    }
  }
  const catalogLessons = allRows(catalogDb, "SELECT id, title FROM lessons ORDER BY LENGTH(id) DESC");
  const poetryLessons = new Map(
    allRows(
      catalogDb,
      `SELECT 'poem-' || ct.id AS word_id, l.id AS lesson_id, l.title
       FROM classical_texts ct
       JOIN lessons l ON l.id = ct.lesson_id`,
    ).map((row) => [row.word_id, { id: row.lesson_id, title: row.title }]),
  );
  const inferLessons = (items) => {
    const inferred = new Map();
    for (const item of items) {
      const poetryLesson = poetryLessons.get(item.word_id);
      const lesson = poetryLesson || catalogLessons.find((candidate) => item.word_id.startsWith(`${candidate.id}-`));
      if (lesson) inferred.set(lesson.id, { id: lesson.id, title: lesson.title });
    }
    return [...inferred.values()];
  };
  const logs = logRows.map((log) => {
    const items = wordsByLog.get(log.id) || [];
    const wrongChars = wrongCharsByLog.get(log.id) || [];
    const lessons = lessonsByLog.get(log.id) || inferLessons(items);
    const practiceMode = log.practice_mode === "lesson" || log.practice_mode === "history"
      ? log.practice_mode
      : lessons.length === 1 ? "lesson" : lessons.length > 1 ? "history" : undefined;
    return {
      id: log.id,
      date: log.date,
      practiceMode,
      lessons,
      wordIds: items.map((item) => item.word_id),
      wrongWordIds: items.filter((item) => item.is_wrong).map((item) => item.word_id),
      wrongChars: wrongChars.map((item) => ({ wordId: item.word_id, char: item.char })),
    };
  });
  return {
    progress: { grade: progress?.grade || 3, lessonId: progress?.lesson_id || "" },
    wordStats,
    charStats,
    logs,
  };
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

    learningDb.prepare("DELETE FROM review_logs WHERE student_id = ?").run(studentId);
    const insertLog = learningDb.prepare("INSERT INTO review_logs (id, student_id, date, practice_mode) VALUES (?, ?, ?, ?)");
    const insertLogLesson = learningDb.prepare(
      "INSERT INTO review_log_lessons (log_id, lesson_id, lesson_title, lesson_order) VALUES (?, ?, ?, ?)",
    );
    const insertLogWord = learningDb.prepare("INSERT INTO review_log_words (log_id, word_id, is_wrong, item_order) VALUES (?, ?, ?, ?)");
    const insertLogChar = learningDb.prepare("INSERT INTO review_log_chars (log_id, word_id, char, item_order, char_order) VALUES (?, ?, ?, ?, ?)");
    for (const log of (state.logs || []).slice(0, 120)) {
      const wrongIds = new Set(log.wrongWordIds || []);
      const wrongChars = log.wrongChars || [];
      const wrongCharWordIds = new Set(wrongChars.map((item) => item.wordId));
      const practiceMode = log.practiceMode === "lesson" || log.practiceMode === "history" ? log.practiceMode : null;
      insertLog.run(log.id, studentId, log.date, practiceMode);
      const seenLessonIds = new Set();
      for (const [index, lesson] of (log.lessons || []).entries()) {
        if (!lesson?.id || seenLessonIds.has(lesson.id)) continue;
        seenLessonIds.add(lesson.id);
        insertLogLesson.run(log.id, lesson.id, lesson.title || "", index);
      }
      for (const [index, wordId] of (log.wordIds || []).entries()) {
        insertLogWord.run(log.id, wordId, wrongIds.has(wordId) || wrongCharWordIds.has(wordId) ? 1 : 0, index);
      }
      for (const [index, item] of wrongChars.entries()) {
        insertLogChar.run(log.id, item.wordId, item.char, Math.max(0, (log.wordIds || []).indexOf(item.wordId)), index);
      }
    }

  });
};
