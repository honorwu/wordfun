export const migrateLearningDatabase = (db) => {
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
  const reviewLogWordColumns = new Set(db.prepare("PRAGMA table_info(review_log_words)").all().map((column) => column.name));
  if (!reviewLogWordColumns.has("prompt_text")) {
    db.exec("ALTER TABLE review_log_words ADD COLUMN prompt_text TEXT");
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
