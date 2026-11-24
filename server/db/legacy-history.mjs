import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hanChars } from "../../shared/domain/characters.ts";
import { allRows, hasTable } from "./query.mjs";

// The index contains textbook data from the release before current question IDs.
const legacyIndex = () => JSON.parse(readFileSync(new URL("./legacy-catalog-index.json", import.meta.url), "utf8"));
const rowsIfPresent = (db, table) => hasTable(db, table) ? allRows(db, `SELECT * FROM ${table}`) : [];
const pair = (left, right) => JSON.stringify([left, right]);
const lessonKey = ({ grade, term, title }) => JSON.stringify([grade, term, title]);
const pinyinKey = (value) => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
const hasDifferentReading = (historic, prompt, question) => historic?.text === prompt && historic.pinyin && question.pinyin
  && pinyinKey(historic.pinyin) !== pinyinKey(question.pinyin);

const currentLessons = (db) => allRows(db, "SELECT id, grade, term, section, title FROM lessons");
const historicLessons = (index) => index.lessons.map(([id, grade, term, section, title]) => ({ id, grade, term, section, title }));

const lessonResolver = (current, historic) => {
  const currentIds = new Set(current.map(({ id }) => id));
  const historicById = new Map(historic.map((lesson) => [lesson.id, lesson]));
  const currentByKey = Map.groupBy(current, lessonKey);
  const historicByKey = Map.groupBy(historic, lessonKey);
  return (id) => {
    if (currentIds.has(id)) return id;
    const lesson = historicById.get(id);
    if (!lesson) return undefined;
    const key = lessonKey(lesson);
    const candidates = currentByKey.get(key) ?? [];
    if (candidates.length === 1 && historicByKey.get(key).length === 1) return candidates[0].id;
    const matching = candidates.filter(({ section }) => section === lesson.section);
    const historicMatching = historicByKey.get(key).filter(({ section }) => section === lesson.section);
    return matching.length === 1 && historicMatching.length === 1 ? matching[0].id : undefined;
  };
};

export const createLegacyLessonResolver = (catalogDb) => lessonResolver(currentLessons(catalogDb), historicLessons(legacyIndex()));

const questionAnswer = ({ text, poem }) => {
  if (!poem) return text;
  const { title, dynasty, author } = JSON.parse(poem);
  return [title, dynasty, author, text].filter(Boolean).join("\n");
};

const makeQuestionMatcher = (catalogDb, index, sessionLessons) => {
  const historic = historicLessons(index);
  const resolveLesson = lessonResolver(currentLessons(catalogDb), historic);
  const historicLessonIds = new Set(historic.map(({ id }) => id));
  const historicQuestions = new Map(index.questions.map(([id, lessonId, text, pinyin]) => [id, { lessonId, text, pinyin }]));
  const questions = allRows(catalogDb, "SELECT id, lesson_id, text, pinyin, poem FROM questions")
    .map((question) => ({ ...question, answer: questionAnswer(question) }));
  const byId = new Map(questions.map((question) => [question.id, question]));
  const byLessonAnswer = Map.groupBy(questions, ({ lesson_id, answer }) => pair(lesson_id, answer));
  const match = (row) => {
    const { log_id, word_id, prompt_text } = row;
    if (!prompt_text) return undefined;
    const allowedLessons = sessionLessons.get(log_id);
    const current = byId.get(word_id);
    const previous = historicQuestions.get(word_id);
    if (current) {
      const confirmed = current.answer === prompt_text && (!allowedLessons || allowedLessons.has(current.lesson_id));
      return confirmed && !hasDifferentReading(previous, prompt_text, current) ? current : undefined;
    }
    const prefix = /^(.+)-char-.$/u.exec(word_id)?.[1];
    const origin = previous?.lessonId ?? (historicLessonIds.has(prefix) ? prefix : undefined);
    if (!origin || (allowedLessons && !allowedLessons.has(origin))) return undefined;
    const lessonId = resolveLesson(origin);
    const candidates = byLessonAnswer.get(pair(lessonId, prompt_text));
    if (candidates?.length !== 1) return undefined;
    const [candidate] = candidates;
    return hasDifferentReading(previous, prompt_text, candidate) ? undefined : candidate;
  };
  return { byId, match };
};

const legacyId = (wordId, detail) => {
  const marker = createHash("sha256").update(`${wordId}\0${detail}`).digest("hex").slice(0, 16);
  return `${wordId}-legacy-${marker}`;
};

const summarize = (studentId, wordId, attempts) => {
  let total = 0;
  let mistakes = 0;
  let streak = 0;
  let lastReviewedAt = null;
  let lastMistakeAt = null;
  for (const { date, wrong, evaluated } of attempts) {
    lastReviewedAt = date;
    if (evaluated) total += 1;
    if (wrong) {
      mistakes += 1;
      streak = 0;
      lastMistakeAt = date;
    } else if (evaluated) {
      streak += 1;
    }
  }
  return [studentId, wordId, total, mistakes, streak, lastReviewedAt, lastMistakeAt];
};

const copyStats = (row, wordId) => [row.student_id, wordId, row.attempts, row.mistakes,
  row.streak ?? (row.mistakes === 0 ? row.attempts : 0), row.last_reviewed_at ?? null, row.last_mistake_at ?? null];

const writeArchiveStats = (insert, sourceStats, archived, originalAttempts, currentIds) => {
  for (const row of sourceStats) {
    const key = pair(row.student_id, row.word_id);
    const history = originalAttempts.get(key) ?? [];
    const groups = Map.groupBy(archived.get(key) ?? [], ({ outputId }) => outputId);
    if (history.length === 0) {
      const archiveId = currentIds.has(row.word_id) ? legacyId(row.word_id, "summary") : row.word_id;
      insert.run(...copyStats(row, archiveId));
      continue;
    }
    if (groups.size === 1 && [...groups.values()][0].length === history.length) {
      insert.run(...copyStats(row, groups.keys().next().value));
      continue;
    }

    const matchesFullHistory = row.attempts === history.length && row.mistakes === history.filter(({ wrong }) => wrong).length;
    if (!matchesFullHistory) {
      // The old summary may include sessions that are no longer present. Keep its totals separate from current question evidence.
      insert.run(...copyStats(row, legacyId(row.word_id, "summary")));
      continue;
    }
    for (const [id, attempts] of groups) insert.run(...summarize(row.student_id, id, attempts));
  }
};

export const migrateLegacyHistory = ({ source, target, catalogDb }) => {
  const logs = new Map(rowsIfPresent(source, "review_logs").map((log) => [log.id, log]));
  const sessionLessons = new Map([...Map.groupBy(rowsIfPresent(source, "review_log_lessons"), ({ log_id }) => log_id)]
    .map(([id, lessons]) => [id, new Set(lessons.map(({ lesson_id }) => lesson_id))]));
  const reviewed = rowsIfPresent(source, "review_log_reviewed_chars");
  const issues = rowsIfPresent(source, "review_log_chars");
  const reviewedChars = new Map([...Map.groupBy(reviewed, ({ log_id, word_id }) => pair(log_id, word_id))]
    .map(([id, details]) => [id, new Set(details.map(({ char }) => char))]));
  const wrongEntries = new Set(issues.map(({ log_id, word_id }) => pair(log_id, word_id)));
  const entries = rowsIfPresent(source, "review_log_words").sort((left, right) => {
    const a = logs.get(left.log_id);
    const b = logs.get(right.log_id);
    return (Date.parse(a.date) - Date.parse(b.date)) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
      || left.item_order - right.item_order;
  });
  const { byId, match } = makeQuestionMatcher(catalogDb, legacyIndex(), sessionLessons);
  const candidates = entries.map((row) => ({ row, candidate: match(row) }));
  const matchesBySession = Map.groupBy(candidates.filter(({ candidate }) => candidate),
    ({ row, candidate }) => pair(row.log_id, candidate.id));
  const insertWord = target.prepare("INSERT INTO review_log_words (log_id, word_id, prompt_text, is_wrong, item_order) VALUES (?, ?, ?, ?, ?)");
  const versions = new Map();
  const active = [];
  const archived = [];
  const actualAttempts = [];
  for (const { row, candidate } of candidates) {
    const { log_id, word_id, prompt_text, is_wrong, item_order } = row;
    const key = pair(log_id, word_id);
    const verified = candidate && matchesBySession.get(pair(log_id, candidate.id)).length === 1;
    const outputId = verified ? candidate.id : byId.has(word_id) ? legacyId(word_id, prompt_text ?? "") : word_id;
    versions.set(key, { outputId, itemOrder: item_order });
    insertWord.run(log_id, outputId, prompt_text ?? null, is_wrong, item_order);

    const previous = logs.get(log_id);
    const wrong = Boolean(is_wrong || wrongEntries.has(key));
    const chars = reviewedChars.get(key);
    const evaluated = wrong || Boolean(verified && chars && hanChars(candidate.answer).every((char) => chars.has(char)));
    const attempt = { studentId: previous.student_id, originalId: word_id, outputId, date: previous.date, wrong, evaluated };
    actualAttempts.push(attempt);
    if (verified) active.push(attempt);
    else archived.push({ ...attempt, evaluated: true });
  }

  for (const [table, details] of [["review_log_chars", issues], ["review_log_reviewed_chars", reviewed]]) {
    const insert = target.prepare(`INSERT INTO ${table} (log_id, word_id, char, item_order, char_order) VALUES (?, ?, ?, ?, ?)`);
    for (const { log_id, word_id, char, item_order, char_order } of details) {
      const version = versions.get(pair(log_id, word_id));
      const id = version?.outputId ?? (byId.has(word_id) ? legacyId(word_id, "") : word_id);
      insert.run(log_id, id, char, item_order ?? version?.itemOrder ?? 0, char_order ?? 0);
    }
  }

  const insertStat = target.prepare(`INSERT INTO word_stats
    (student_id, word_id, attempts, mistakes, streak, last_reviewed_at, last_mistake_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const activeGroups = Map.groupBy(active, ({ studentId, outputId }) => pair(studentId, outputId));
  for (const [key, attempts] of activeGroups) insertStat.run(...summarize(...JSON.parse(key), attempts));
  const byOriginal = ({ studentId, originalId }) => pair(studentId, originalId);
  writeArchiveStats(insertStat, rowsIfPresent(source, "word_stats"), Map.groupBy(archived, byOriginal), Map.groupBy(actualAttempts, byOriginal), byId);
  return { reviewItems: entries.length, matchedReviewItems: active.length, matchedQuestions: activeGroups.size };
};
