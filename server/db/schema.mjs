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

CREATE TABLE IF NOT EXISTS textbook_word_contexts (
  lesson_word_id TEXT PRIMARY KEY REFERENCES lesson_words(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL UNIQUE,
  context_type TEXT NOT NULL,
  context_text TEXT,
  original_context_text TEXT,
  hint_text TEXT,
  context_pdf_pages TEXT,
  wordlist_pdf_page INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS lesson_history_companions (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  word TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  hint_text TEXT,
  source_row INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, char)
);

CREATE TABLE IF NOT EXISTS lesson_reviewed_prompts (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL REFERENCES characters(char),
  word TEXT NOT NULL CHECK (instr(word, char) > 0),
  pinyin TEXT NOT NULL,
  hint_text TEXT CHECK (word <> char OR (hint_text IS NOT NULL AND instr(hint_text, '〔　〕') > 0)),
  context_kind TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_rows TEXT NOT NULL,
  PRIMARY KEY (lesson_id, char)
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
  prompt_text TEXT,
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
