import { charReviewKey, fullDictationCharsForWord } from "../../shared/domain/characters.ts";
import { canSupplementReview, isWithinReviewCorrectionWindow } from "../../shared/domain/reviewPolicy.ts";
import { addMissedWrongChars, applyReviewResult } from "../../shared/domain/reviews.ts";
import { normalizeWordIssues, toggleWordIssue } from "../../shared/domain/wordIssues.ts";
import { defaultStudentId } from "../config.mjs";
import { allRows, oneRow, runReadTransaction, runTransaction } from "./query.mjs";

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

const getWordStats = (learningDb, studentId) => Object.fromEntries(allRows(
  learningDb,
  "SELECT word_id, attempts, mistakes, streak, last_reviewed_at, last_mistake_at FROM word_stats WHERE student_id = ?",
  studentId,
).map((row) => [row.word_id, {
  attempts: row.attempts,
  mistakes: row.mistakes,
  streak: row.streak,
  lastReviewedAt: row.last_reviewed_at || undefined,
  lastMistakeAt: row.last_mistake_at || undefined,
}]));

export const getReviewCarryover = (learningDb, studentId = defaultStudentId) => Object.fromEntries(allRows(
  learningDb,
  "SELECT word_id, baseline_attempts, available_at FROM review_carryover WHERE student_id = ?",
  studentId,
).map(({ word_id, baseline_attempts, available_at }) => [word_id, { baselineAttempts: baseline_attempts, availableAt: available_at }]));

export const getPracticeSnapshot = (learningDb, studentId = defaultStudentId) => runReadTransaction(learningDb, () => ({
  wordStats: getWordStats(learningDb, studentId),
  carryover: getReviewCarryover(learningDb, studentId),
}));

export const getAppDataSnapshot = (learningDb, catalogDb, studentId = defaultStudentId) => {
  ensureDefaultStudent(learningDb, catalogDb, studentId);
  return runReadTransaction(learningDb, () => ({
    state: getState(learningDb, catalogDb, studentId, { includeLogs: false, ensureStudentExists: false }),
    activity: getReviewActivity(learningDb, studentId),
    carryover: getReviewCarryover(learningDb, studentId),
  }));
};

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

export const getState = (learningDb, catalogDb, studentId = defaultStudentId, { includeLogs = true, ensureStudentExists = true } = {}) => {
  if (ensureStudentExists) ensureDefaultStudent(learningDb, catalogDb, studentId);
  const progress = oneRow(learningDb, "SELECT grade, lesson_id FROM progress WHERE student_id = ?", studentId) || defaultProgress(catalogDb);
  const wordStats = getWordStats(learningDb, studentId);
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

  const findLog = learningDb.prepare("SELECT student_id, date FROM review_logs WHERE id = ?");
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

  const now = Date.now();
  for (const log of logs) {
    const existing = findLog.get(log.id);
    if (existing && existing.student_id !== studentId) throw new Error("默写记录 ID 已被使用");

    const wrongChars = log.wrongChars ?? [];
    const wrongWordIds = new Set(log.wrongWordIds ?? []);
    for (const { wordId } of wrongChars) wrongWordIds.add(wordId);

    let changed = false;
    if (existing) {
      // 同一场次只补充错误，保留首次保存的题目和计分快照。
      for (const wordId of wrongWordIds) {
        if (markWordWrong.run(log.id, wordId).changes) changed = true;
      }
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
    for (const { wordId, char } of wrongChars) {
      if (insertWrongChar.run(char, log.id, wordId).changes) changed = true;
    }
    if (existing && changed && !isWithinReviewCorrectionWindow(existing.date, now)) {
      throw Object.assign(new Error("这条默写记录不在 3 天补记期限内"), { statusCode: 409 });
    }
  }
};

const getWordIssues = (learningDb, studentId) =>
  allRows(learningDb, "SELECT * FROM word_issues WHERE student_id = ? ORDER BY created_at DESC, id", studentId).map((row) => ({
    id: row.id,
    word: JSON.parse(row.word_snapshot),
    lessonLabel: row.lesson_label,
    kinds: [row.wording_issue ? "wording" : null, row.pronunciation_issue ? "pronunciation" : null].filter(Boolean),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || undefined,
  }));

const upsertWordStats = (learningDb, studentId, wordStats) => {
  const statement = learningDb.prepare(
    `INSERT INTO word_stats (student_id, word_id, attempts, mistakes, streak, last_reviewed_at, last_mistake_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id, word_id) DO UPDATE SET
       attempts = excluded.attempts,
       mistakes = excluded.mistakes,
       streak = excluded.streak,
       last_reviewed_at = excluded.last_reviewed_at,
       last_mistake_at = excluded.last_mistake_at`,
  );
  for (const [wordId, stat] of Object.entries(wordStats)) {
    statement.run(studentId, wordId, stat.attempts || 0, stat.mistakes || 0, stat.streak || 0, stat.lastReviewedAt || null, stat.lastMistakeAt || null);
  }
};

const upsertCharStats = (learningDb, studentId, charStats) => {
  const upsertChar = learningDb.prepare(
    `INSERT INTO char_stats (student_id, char, attempts, mistakes, streak, last_reviewed_at, last_mistake_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id, char) DO UPDATE SET
       attempts = excluded.attempts,
       mistakes = excluded.mistakes,
       streak = excluded.streak,
       last_reviewed_at = excluded.last_reviewed_at,
       last_mistake_at = excluded.last_mistake_at`,
  );
  const upsertEvidence = learningDb.prepare(
    `INSERT INTO char_word_evidence (student_id, char, word_text, correct_count, mistake_count, last_reviewed_at, last_mistake_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id, char, word_text) DO UPDATE SET
       correct_count = MAX(char_word_evidence.correct_count, excluded.correct_count),
       mistake_count = MAX(char_word_evidence.mistake_count, excluded.mistake_count),
       last_reviewed_at = excluded.last_reviewed_at,
       last_mistake_at = COALESCE(excluded.last_mistake_at, char_word_evidence.last_mistake_at)`,
  );
  for (const [char, stat] of Object.entries(charStats)) {
    upsertChar.run(studentId, char, stat.attempts || 0, stat.mistakes || 0, stat.streak || 0, stat.lastReviewedAt || null, stat.lastMistakeAt || null);
    const correctWordTexts = new Set((stat.correctWordTexts || []).filter(Boolean));
    const wrongWordTexts = new Set((stat.wrongWordTexts || []).filter(Boolean));
    for (const wordText of new Set([...correctWordTexts, ...wrongWordTexts])) {
      upsertEvidence.run(
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
};

export const saveProgress = (learningDb, catalogDb, progress, studentId = defaultStudentId) => {
  if (!progress || typeof progress !== "object" || typeof progress.lessonId !== "string" || !progress.lessonId) {
    throw Object.assign(new Error("课次信息不正确"), { statusCode: 400 });
  }
  const lesson = oneRow(catalogDb, "SELECT id, grade FROM lessons WHERE id = ?", progress.lessonId);
  if (!lesson) {
    throw Object.assign(new Error("所选课次不存在，请刷新后重新选择"), { statusCode: 404 });
  }
  const nextProgress = { grade: lesson.grade, lessonId: lesson.id };
  runTransaction(learningDb, () => {
    ensureStudent(learningDb, studentId);
    learningDb
      .prepare(
        `INSERT INTO progress (student_id, grade, lesson_id)
         VALUES (?, ?, ?)
         ON CONFLICT(student_id) DO UPDATE SET grade = excluded.grade, lesson_id = excluded.lesson_id`,
      )
      .run(studentId, nextProgress.grade, nextProgress.lessonId);
  });
  return { progress: nextProgress };
};

export const recordReview = (learningDb, payload, questionMap, studentId = defaultStudentId) => {
  const { practiceMode, lessons, wordIds, wrongChars } = payload ?? {};
  if (practiceMode !== "lesson" && practiceMode !== "history") {
    throw Object.assign(new Error("复习方式不正确"), { statusCode: 400 });
  }
  if (!Array.isArray(wordIds) || wordIds.length === 0) {
    throw Object.assign(new Error("默写题目不能为空"), { statusCode: 400 });
  }
  const items = [];
  const seenWordIds = new Set();
  for (const wordId of wordIds) {
    if (typeof wordId !== "string" || seenWordIds.has(wordId)) continue;
    const word = questionMap.get(wordId);
    if (!word) {
      throw Object.assign(new Error("包含词库中不存在的题目，请刷新页面后重试"), { statusCode: 400 });
    }
    seenWordIds.add(wordId);
    items.push({ word, score: 0, reasons: [] });
  }
  if (items.length === 0) {
    throw Object.assign(new Error("默写题目不能为空"), { statusCode: 400 });
  }
  const normalizedLessons = Array.isArray(lessons)
    ? lessons.filter((item) => item && typeof item.id === "string" && item.id).map((item) => ({
        id: item.id,
        title: typeof item.title === "string" ? item.title : "",
      }))
    : [];
  const wrongCharKeys = new Set(
    Array.isArray(wrongChars)
      ? wrongChars
          .filter((item) => item && typeof item.wordId === "string" && typeof item.char === "string")
          .map((item) => charReviewKey(item.wordId, item.char))
      : [],
  );

  return runTransaction(learningDb, () => {
    ensureStudent(learningDb, studentId);
    const affectedChars = new Set(items.flatMap(({ word }) => fullDictationCharsForWord(word)));
    const existingWordStats = {};
    const readWord = learningDb.prepare(
      "SELECT word_id, attempts, mistakes, streak, last_reviewed_at, last_mistake_at FROM word_stats WHERE student_id = ? AND word_id = ?",
    );
    for (const { word } of items) {
      const row = readWord.get(studentId, word.id);
      if (row) {
        existingWordStats[word.id] = {
          attempts: row.attempts,
          mistakes: row.mistakes,
          streak: row.streak,
          lastReviewedAt: row.last_reviewed_at || undefined,
          lastMistakeAt: row.last_mistake_at || undefined,
        };
      }
    }
    const existingCharStats = {};
    const readChar = learningDb.prepare(
      "SELECT char, attempts, mistakes, streak, last_reviewed_at, last_mistake_at FROM char_stats WHERE student_id = ? AND char = ?",
    );
    const readEvidence = learningDb.prepare(
      "SELECT word_text, correct_count, mistake_count FROM char_word_evidence WHERE student_id = ? AND char = ?",
    );
    for (const char of affectedChars) {
      const row = readChar.get(studentId, char);
      if (!row) continue;
      const correctWordTexts = [];
      const wrongWordTexts = [];
      for (const evidence of readEvidence.all(studentId, char)) {
        if (evidence.correct_count > 0) correctWordTexts.push(evidence.word_text);
        if (evidence.mistake_count > 0) wrongWordTexts.push(evidence.word_text);
      }
      existingCharStats[char] = {
        attempts: row.attempts,
        mistakes: row.mistakes,
        streak: row.streak,
        correctWordTexts,
        wrongWordTexts,
        lastReviewedAt: row.last_reviewed_at || undefined,
        lastMistakeAt: row.last_mistake_at || undefined,
      };
    }

    const baseState = {
      progress: { grade: 3, lessonId: "" },
      wordStats: existingWordStats,
      charStats: existingCharStats,
      logs: [],
      wordIssues: [],
    };
    const nextState = applyReviewResult(
      baseState,
      items,
      wrongCharKeys,
      { practiceMode, lessons: normalizedLessons },
      new Date().toISOString(),
    );
    const [newLog] = nextState.logs;
    upsertWordStats(learningDb, studentId, nextState.wordStats);
    upsertCharStats(learningDb, studentId, nextState.charStats);
    appendReviewLogs(learningDb, studentId, [newLog]);
    return {
      log: newLog,
      wordStats: nextState.wordStats,
      charStats: nextState.charStats,
    };
  });
};

export const supplementReview = (learningDb, catalogDb, logId, payload, questionMap, studentId = defaultStudentId) => {
  if (typeof logId !== "string" || !logId) {
    throw Object.assign(new Error("默写记录 ID 不正确"), { statusCode: 400 });
  }
  const requested = payload?.corrections;
  if (!Array.isArray(requested)) {
    throw Object.assign(new Error("补记内容格式不正确"), { statusCode: 400 });
  }
  const corrections = requested
    .filter((item) => item && typeof item.wordId === "string" && typeof item.char === "string")
    .map(({ wordId, char }) => ({ wordId, char }));

  return runTransaction(learningDb, () => {
    const state = getState(learningDb, catalogDb, studentId, { includeLogs: true, ensureStudentExists: false });
    const targetLog = state.logs.find((log) => log.id === logId);
    if (!targetLog) {
      throw Object.assign(new Error("未找到对应的默写记录"), { statusCode: 404 });
    }
    const now = Date.now();
    if (!canSupplementReview(targetLog, now)) {
      throw Object.assign(new Error("这条默写记录不在 3 天补记期限内"), { statusCode: 409 });
    }
    const nextState = addMissedWrongChars(state, logId, corrections, questionMap, now);
    const updatedLog = nextState.logs.find((log) => log.id === logId);
    const previousKeys = new Set((targetLog.wrongChars ?? []).map((item) => charReviewKey(item.wordId, item.char)));
    const addedItems = (updatedLog?.wrongChars ?? []).filter((item) => !previousKeys.has(charReviewKey(item.wordId, item.char)));
    if (addedItems.length === 0 || !updatedLog) {
      return { log: targetLog, appliedCount: 0, wordStats: {}, charStats: {} };
    }

    const updatedWordStats = {};
    for (const wordId of new Set(addedItems.map((item) => item.wordId))) {
      if (nextState.wordStats[wordId]) updatedWordStats[wordId] = nextState.wordStats[wordId];
    }
    const updatedCharStats = {};
    for (const char of new Set(addedItems.map((item) => item.char))) {
      if (nextState.charStats[char]) updatedCharStats[char] = nextState.charStats[char];
    }
    upsertWordStats(learningDb, studentId, updatedWordStats);
    upsertCharStats(learningDb, studentId, updatedCharStats);
    appendReviewLogs(learningDb, studentId, [updatedLog]);
    return {
      log: updatedLog,
      appliedCount: addedItems.length,
      wordStats: updatedWordStats,
      charStats: updatedCharStats,
    };
  });
};

export const toggleSavedWordIssue = (learningDb, payload, studentId = defaultStudentId) => {
  const { word, lessonLabel, kind } = payload ?? {};
  if (kind !== "wording" && kind !== "pronunciation") {
    throw Object.assign(new Error("问题类型不正确"), { statusCode: 400 });
  }
  const normalized = normalizeWordIssues([{
    id: "validate",
    word,
    lessonLabel: typeof lessonLabel === "string" ? lessonLabel : word?.lessonTitle ?? "",
    kinds: [kind],
    createdAt: new Date().toISOString(),
  }]);
  if (normalized.length === 0) {
    throw Object.assign(new Error("题目信息不完整"), { statusCode: 400 });
  }
  const safeWord = normalized[0].word;
  const safeLabel = normalized[0].lessonLabel;

  return runTransaction(learningDb, () => {
    ensureStudent(learningDb, studentId);
    const existing = getWordIssues(learningDb, studentId);
    const next = toggleWordIssue(existing, safeWord, safeLabel, kind);
    const nextById = new Map(next.map((issue) => [issue.id, issue]));
    const deleteIssue = learningDb.prepare("DELETE FROM word_issues WHERE student_id = ? AND id = ?");
    for (const issue of existing) {
      if (!nextById.has(issue.id)) deleteIssue.run(studentId, issue.id);
    }
    const upsertIssue = learningDb.prepare(
      `INSERT INTO word_issues (student_id, id, word_snapshot, lesson_label, wording_issue, pronunciation_issue, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(student_id, id) DO UPDATE SET
         word_snapshot = excluded.word_snapshot,
         lesson_label = excluded.lesson_label,
         wording_issue = excluded.wording_issue,
         pronunciation_issue = excluded.pronunciation_issue,
         created_at = excluded.created_at,
         resolved_at = excluded.resolved_at`,
    );
    for (const issue of next) {
      const kinds = new Set(issue.kinds);
      upsertIssue.run(
        studentId, issue.id, JSON.stringify(issue.word), issue.lessonLabel || "",
        kinds.has("wording") ? 1 : 0, kinds.has("pronunciation") ? 1 : 0,
        issue.createdAt, issue.resolvedAt || null,
      );
    }
    return { wordIssues: getWordIssues(learningDb, studentId) };
  });
};

export const resolveSavedWordIssue = (learningDb, issueId, resolved, studentId = defaultStudentId) => {
  if (typeof issueId !== "string" || !issueId || typeof resolved !== "boolean") {
    throw Object.assign(new Error("参数格式不正确"), { statusCode: 400 });
  }
  return runTransaction(learningDb, () => {
    const resolvedAt = resolved ? new Date().toISOString() : null;
    const result = learningDb
      .prepare("UPDATE word_issues SET resolved_at = ? WHERE student_id = ? AND id = ?")
      .run(resolvedAt, studentId, issueId);
    if (!result.changes) {
      throw Object.assign(new Error("未找到对应的词库问题记录"), { statusCode: 404 });
    }
    return { wordIssues: getWordIssues(learningDb, studentId) };
  });
};

export const saveState = (learningDb, state, studentId = defaultStudentId) => {
  if (!state || typeof state !== "object" || !state.progress || typeof state.progress.lessonId !== "string" || !Number.isInteger(state.progress.grade)) {
    throw Object.assign(new Error("保存内容格式不正确"), { statusCode: 400 });
  }
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
