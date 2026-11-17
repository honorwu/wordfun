import { defaultStudentId } from "../config.mjs";
import { allRows, oneRow, runTransaction } from "./query.mjs";

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

export const getState = (learningDb, catalogDb, studentId = defaultStudentId, { includeLogs = true } = {}) => {
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
  const logRows = includeLogs ? allRows(learningDb, "SELECT id, date, practice_mode FROM review_logs WHERE student_id = ? ORDER BY date DESC LIMIT 120", studentId) : [];
  const wordsByLog = new Map();
  const wrongCharsByLog = new Map();
  const reviewedCharsByLog = new Map();
  const lessonsByLog = new Map();
  if (logRows.length > 0) {
    const placeholders = logRows.map(() => "?").join(", ");
    const logIds = logRows.map((log) => log.id);
    for (const item of allRows(
      learningDb,
      `SELECT log_id, word_id, prompt_text, is_wrong FROM review_log_words WHERE log_id IN (${placeholders}) ORDER BY log_id, item_order`,
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
      `SELECT log_id, word_id, char FROM review_log_reviewed_chars WHERE log_id IN (${placeholders}) ORDER BY log_id, item_order, char_order`,
      ...logIds,
    )) {
      const byWord = reviewedCharsByLog.get(item.log_id) || new Map();
      byWord.set(item.word_id, [...(byWord.get(item.word_id) || []), item.char]);
      reviewedCharsByLog.set(item.log_id, byWord);
    }
    for (const item of allRows(
      learningDb,
      `SELECT log_id, lesson_id, lesson_title FROM review_log_lessons WHERE log_id IN (${placeholders}) ORDER BY log_id, lesson_order`,
      ...logIds,
    )) {
      lessonsByLog.set(item.log_id, [...(lessonsByLog.get(item.log_id) || []), { id: item.lesson_id, title: item.lesson_title }]);
    }
  }
  const catalogLessons = logRows.length ? allRows(catalogDb, "SELECT id, title FROM lessons ORDER BY LENGTH(id) DESC") : [];
  const poetryLessons = new Map(
    (logRows.length ? allRows(
      catalogDb,
      `SELECT 'poem-' || ct.id AS word_id, l.id AS lesson_id, l.title
       FROM classical_texts ct
       JOIN lessons l ON l.id = ct.lesson_id`,
    ) : []).map((row) => [row.word_id, { id: row.lesson_id, title: row.title }]),
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
    const reviewedChars = reviewedCharsByLog.get(log.id);
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
      reviewedItems: reviewedChars || items.some((item) => item.prompt_text)
        ? items.map((item) => ({
            wordId: item.word_id,
            wordText: item.prompt_text || "",
            reviewedChars: reviewedChars?.get(item.word_id) || [],
          }))
        : undefined,
    };
  });
  return {
    progress: { grade: progress?.grade || 3, lessonId: progress?.lesson_id || "" },
    wordStats,
    charStats,
    logs,
    wordIssues: allRows(learningDb, "SELECT * FROM word_issues WHERE student_id = ? ORDER BY created_at DESC, id", studentId).map((row) => ({
      id: row.id,
      word: JSON.parse(row.word_snapshot),
      lessonLabel: row.lesson_label,
      kinds: [row.wording_issue ? "wording" : null, row.pronunciation_issue ? "pronunciation" : null].filter(Boolean),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at || undefined,
    })),
  };
};

// 首页只需要打卡数量，不读取逐题、逐字的历史记录。
export const getReviewActivity = (learningDb, studentId = defaultStudentId) => allRows(
  learningDb,
  `SELECT rl.id, rl.date, COUNT(rw.word_id) AS count
   FROM (SELECT id, date FROM review_logs WHERE student_id = ? ORDER BY date DESC LIMIT 120) rl
   LEFT JOIN review_log_words rw ON rw.log_id = rl.id
   GROUP BY rl.id ORDER BY rl.date DESC`,
  studentId,
);

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
    const insertLogWord = learningDb.prepare("INSERT INTO review_log_words (log_id, word_id, prompt_text, is_wrong, item_order) VALUES (?, ?, ?, ?, ?)");
    const insertLogChar = learningDb.prepare("INSERT INTO review_log_chars (log_id, word_id, char, item_order, char_order) VALUES (?, ?, ?, ?, ?)");
    const insertReviewedChar = learningDb.prepare("INSERT INTO review_log_reviewed_chars (log_id, word_id, char, item_order, char_order) VALUES (?, ?, ?, ?, ?)");
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
      const reviewedItemByWordId = new Map((log.reviewedItems || []).map((item) => [item.wordId, item]));
      for (const [index, wordId] of (log.wordIds || []).entries()) {
        const reviewedItem = reviewedItemByWordId.get(wordId);
        insertLogWord.run(log.id, wordId, reviewedItem?.wordText || null, wrongIds.has(wordId) || wrongCharWordIds.has(wordId) ? 1 : 0, index);
        for (const [charIndex, char] of (reviewedItem?.reviewedChars || []).entries()) {
          insertReviewedChar.run(log.id, wordId, char, index, charIndex);
        }
      }
      for (const [index, item] of wrongChars.entries()) {
        insertLogChar.run(log.id, item.wordId, item.char, Math.max(0, (log.wordIds || []).indexOf(item.wordId)), index);
      }
    }

    // 旧客户端未带此字段时保留已有标记；空数组表示明确取消全部标记。
    if (Array.isArray(state.wordIssues)) {
      learningDb.prepare("DELETE FROM word_issues WHERE student_id = ?").run(studentId);
      const insertIssue = learningDb.prepare(
        `INSERT INTO word_issues (student_id, id, word_snapshot, lesson_label, wording_issue, pronunciation_issue, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const issue of state.wordIssues) {
        const kinds = new Set(issue.kinds || []);
        if (!kinds.has("wording") && !kinds.has("pronunciation")) continue;
        insertIssue.run(
          studentId, issue.id, JSON.stringify(issue.word), issue.lessonLabel || "",
          kinds.has("wording") ? 1 : 0, kinds.has("pronunciation") ? 1 : 0,
          issue.createdAt, issue.resolvedAt || null,
        );
      }
    }

  });
};
