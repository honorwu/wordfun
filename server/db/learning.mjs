import { masteryNetCorrect } from "../../shared/domain/reviewPolicy.ts";
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

export const getReviewCarryover = (learningDb, studentId = defaultStudentId) => Object.fromEntries(allRows(
  learningDb,
  "SELECT word_id, baseline_attempts, available_at FROM review_carryover WHERE student_id = ?",
  studentId,
).map(({ word_id, baseline_attempts, available_at }) => [word_id, { baselineAttempts: baseline_attempts, availableAt: available_at }]));

export const getInheritedMasteredChars = (learningDb, studentId = defaultStudentId) => allRows(
  learningDb,
  `SELECT inherited.char FROM inherited_char_mastery inherited
   JOIN char_stats stats ON stats.student_id = inherited.student_id AND stats.char = inherited.char
   WHERE inherited.student_id = ? AND stats.attempts - 2 * stats.mistakes >= ?
   ORDER BY inherited.char`,
  studentId, masteryNetCorrect,
).map(({ char }) => char);

export const getReviewLogs = (learningDb, catalogDb, studentId = defaultStudentId) => {
  const logRows = allRows(learningDb, "SELECT id, date, practice_mode FROM review_logs WHERE student_id = ? ORDER BY date DESC", studentId);
  if (logRows.length === 0) return [];

  const wordsByLog = Map.groupBy(allRows(learningDb,
    `SELECT item.log_id, item.word_id, item.prompt_text, item.is_wrong
     FROM review_logs log JOIN review_log_words item ON item.log_id = log.id
     WHERE log.student_id = ? ORDER BY item.log_id, item.item_order`, studentId), (item) => item.log_id);
  const wrongCharsByLog = Map.groupBy(allRows(learningDb,
    `SELECT item.log_id, item.word_id, item.char
     FROM review_logs log JOIN review_log_chars item ON item.log_id = log.id
     WHERE log.student_id = ? ORDER BY item.log_id, item.item_order, item.char_order`, studentId), (item) => item.log_id);
  const reviewedCharsByLog = Map.groupBy(allRows(learningDb,
    `SELECT item.log_id, item.word_id, item.char
     FROM review_logs log JOIN review_log_reviewed_chars item ON item.log_id = log.id
     WHERE log.student_id = ? ORDER BY item.log_id, item.item_order, item.char_order`, studentId), (item) => item.log_id);
  const lessonsByLog = Map.groupBy(allRows(learningDb,
    `SELECT item.log_id, item.lesson_id, item.lesson_title
     FROM review_logs log JOIN review_log_lessons item ON item.log_id = log.id
     WHERE log.student_id = ? ORDER BY item.log_id, item.lesson_order`, studentId), (item) => item.log_id);

  const questionLessons = new Map(logRows.some((log) => !lessonsByLog.has(log.id)) ? allRows(
    catalogDb,
    `SELECT q.id AS question_id, l.id AS lesson_id, l.title
     FROM questions q JOIN lessons l ON l.id = q.lesson_id`,
  ).map((row) => [row.question_id, { id: row.lesson_id, title: row.title }]) : []);
  const inferLessons = (items) => {
    const inferred = new Map();
    for (const item of items) {
      const lesson = questionLessons.get(item.word_id);
      if (lesson) inferred.set(lesson.id, lesson);
    }
    return [...inferred.values()];
  };
  return logRows.map((log) => {
    const items = wordsByLog.get(log.id) ?? [];
    const wrongChars = wrongCharsByLog.get(log.id) ?? [];
    const reviewedChars = reviewedCharsByLog.get(log.id);
    const reviewedCharsByWord = Map.groupBy(reviewedChars ?? [], (item) => item.word_id);
    const lessons = lessonsByLog.get(log.id)?.map((item) => ({ id: item.lesson_id, title: item.lesson_title })) ?? inferLessons(items);
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
            reviewedChars: (reviewedCharsByWord.get(item.word_id) ?? []).map((row) => row.char),
          }))
        : undefined,
    };
  });
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
      streak: row.streak,
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
  return {
    progress: { grade: progress?.grade || 3, lessonId: progress?.lesson_id || "" },
    wordStats,
    charStats,
    logs: includeLogs ? getReviewLogs(learningDb, catalogDb, studentId) : [],
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
   FROM review_logs rl
   LEFT JOIN review_log_words rw ON rw.log_id = rl.id
   WHERE rl.student_id = ?
   GROUP BY rl.id ORDER BY rl.date DESC`,
  studentId,
);

const appendReviewLogs = (learningDb, studentId, logs) => {
  if (logs.length === 0) return;

  const findLog = learningDb.prepare("SELECT student_id FROM review_logs WHERE id = ?");
  const insertLog = learningDb.prepare("INSERT INTO review_logs (id, student_id, date, practice_mode) VALUES (?, ?, ?, ?)");
  const insertLogLesson = learningDb.prepare(
    "INSERT INTO review_log_lessons (log_id, lesson_id, lesson_title, lesson_order) VALUES (?, ?, ?, ?)",
  );
  const insertLogWord = learningDb.prepare(
    "INSERT INTO review_log_words (log_id, word_id, prompt_text, is_wrong, item_order) VALUES (?, ?, ?, ?, ?)",
  );
  const insertReviewedChar = learningDb.prepare(
    "INSERT INTO review_log_reviewed_chars (log_id, word_id, char, item_order, char_order) VALUES (?, ?, ?, ?, ?)",
  );
  const markWordWrong = learningDb.prepare(
    "UPDATE review_log_words SET is_wrong = 1 WHERE log_id = ? AND word_id = ? AND is_wrong = 0",
  );
  const insertWrongChar = learningDb.prepare(
    `INSERT INTO review_log_chars (log_id, word_id, char, item_order, char_order)
     SELECT word.log_id, word.word_id, ?, word.item_order,
       COALESCE((SELECT MAX(char_order) + 1 FROM review_log_chars
                 WHERE log_id = word.log_id AND word_id = word.word_id), 0)
     FROM review_log_words word WHERE word.log_id = ? AND word.word_id = ?
     ON CONFLICT(log_id, word_id, char) DO NOTHING`,
  );

  for (const log of logs) {
    const existing = findLog.get(log.id);
    if (existing && existing.student_id !== studentId) throw new Error("默写记录 ID 已被使用");

    const wrongChars = log.wrongChars ?? [];
    const wrongWordIds = new Set(log.wrongWordIds ?? []);
    for (const { wordId } of wrongChars) wrongWordIds.add(wordId);

    if (existing) {
      // 同一场次只补充错误，保留首次保存的题目和计分快照。
      for (const wordId of wrongWordIds) markWordWrong.run(log.id, wordId);
    } else {
      const practiceMode = log.practiceMode === "lesson" || log.practiceMode === "history" ? log.practiceMode : null;
      insertLog.run(log.id, studentId, log.date, practiceMode);
      const seenLessonIds = new Set();
      for (const [index, lesson] of (log.lessons ?? []).entries()) {
        if (!lesson?.id || seenLessonIds.has(lesson.id)) continue;
        seenLessonIds.add(lesson.id);
        insertLogLesson.run(log.id, lesson.id, lesson.title || "", index);
      }
      const reviewedItemByWordId = new Map((log.reviewedItems ?? []).map((item) => [item.wordId, item]));
      for (const [index, wordId] of (log.wordIds ?? []).entries()) {
        const reviewedItem = reviewedItemByWordId.get(wordId);
        insertLogWord.run(log.id, wordId, reviewedItem?.wordText || null, Number(wrongWordIds.has(wordId)), index);
        for (const [charIndex, char] of (reviewedItem?.reviewedChars ?? []).entries()) {
          insertReviewedChar.run(log.id, wordId, char, index, charIndex);
        }
      }
    }
    for (const { wordId, char } of wrongChars) insertWrongChar.run(char, log.id, wordId);
  }
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

    appendReviewLogs(learningDb, studentId, state.logs ?? []);

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
