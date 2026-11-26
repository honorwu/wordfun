export const CATALOG_FORMAT = "dictation-textbook-v4";

export const catalogSchemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  path TEXT PRIMARY KEY,
  grade INTEGER CHECK (grade BETWEEN 1 AND 6),
  term INTEGER CHECK (term IN (1, 2)),
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  term INTEGER NOT NULL CHECK (term IN (1, 2)),
  unit_name TEXT NOT NULL,
  unit_index INTEGER NOT NULL,
  section TEXT NOT NULL,
  lesson_number REAL NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  lesson_kind TEXT NOT NULL CHECK (lesson_kind IN ('regular', 'garden', 'classical_poetry')),
  source_file TEXT NOT NULL REFERENCES source_files(path) ON DELETE RESTRICT,
  UNIQUE (grade, term, section, lesson_number, title)
);

CREATE TABLE IF NOT EXISTS lesson_characters (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  pinyin TEXT NOT NULL,
  char_order INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, char, category)
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('textbook', 'supplement', 'poem')),
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  target_chars TEXT NOT NULL CHECK (json_valid(target_chars) AND json_type(target_chars) = 'array' AND json_array_length(target_chars) > 0),
  hint_text TEXT,
  source_file TEXT NOT NULL REFERENCES source_files(path) ON DELETE RESTRICT,
  source_row INTEGER NOT NULL CHECK (source_row > 0),
  source_details TEXT CHECK (source_details IS NULL OR (json_valid(source_details) AND json_type(source_details) = 'object')),
  poem TEXT CHECK (poem IS NULL OR (json_valid(poem) AND json_type(poem) = 'object')),
  CHECK ((kind = 'poem') = (poem IS NOT NULL)),
  UNIQUE (lesson_id, position)
);

CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(grade, term, sort_order);
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

CREATE TABLE IF NOT EXISTS review_carryover (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  baseline_attempts INTEGER NOT NULL CHECK (baseline_attempts >= 0),
  available_at TEXT,
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

CREATE TABLE IF NOT EXISTS inherited_char_mastery (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
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
  prompt_text TEXT,
  is_wrong INTEGER NOT NULL CHECK (is_wrong IN (0, 1)),
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  PRIMARY KEY (log_id, word_id)
);

CREATE TABLE IF NOT EXISTS review_log_word_presentations (
  log_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  PRIMARY KEY (log_id, word_id),
  FOREIGN KEY (log_id, word_id) REFERENCES review_log_words(log_id, word_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_log_chars (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  char TEXT NOT NULL,
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  char_order INTEGER NOT NULL CHECK (char_order >= 0),
  PRIMARY KEY (log_id, word_id, char)
);

CREATE TABLE IF NOT EXISTS review_log_reviewed_chars (
  log_id TEXT NOT NULL REFERENCES review_logs(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  char TEXT NOT NULL,
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  char_order INTEGER NOT NULL CHECK (char_order >= 0),
  PRIMARY KEY (log_id, word_id, char)
);

CREATE TABLE IF NOT EXISTS word_issues (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  word_snapshot TEXT NOT NULL,
  lesson_label TEXT NOT NULL,
  wording_issue INTEGER NOT NULL CHECK (wording_issue IN (0, 1)),
  pronunciation_issue INTEGER NOT NULL CHECK (pronunciation_issue IN (0, 1)),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (student_id, id)
);

CREATE INDEX IF NOT EXISTS idx_review_logs_student_date ON review_logs(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_review_log_lessons_log ON review_log_lessons(log_id, lesson_order);
CREATE INDEX IF NOT EXISTS idx_review_log_words_log ON review_log_words(log_id, item_order);
CREATE INDEX IF NOT EXISTS idx_review_log_chars_log ON review_log_chars(log_id, item_order, char_order);
CREATE INDEX IF NOT EXISTS idx_review_log_reviewed_chars_log ON review_log_reviewed_chars(log_id, item_order, char_order);
`;
