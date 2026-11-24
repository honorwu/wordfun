import { lessonOrder } from "../../shared/domain/catalog.ts";
import { historyMistakeCooldownDays, isMasteredChar, isMasteredQuestion } from "../../shared/domain/reviewPolicy.ts";
import { allRows } from "./query.mjs";

const cooldownMilliseconds = historyMistakeCooldownDays * 24 * 60 * 60 * 1000;

const compareQuestion = (left, right) => left.phase - right.phase
  || Number(left.mastered) - Number(right.mastered)
  || Number(right.kind === "textbook") - Number(left.kind === "textbook")
  || (left.phase === 2 ? left.order - right.order : right.order - left.order)
  || left.position - right.position
  || left.id.localeCompare(right.id);

const availableAt = (chars) => {
  const dates = chars.flatMap((char) => [char.last_reviewed_at, char.last_mistake_at])
    .map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  return dates.length ? new Date(Math.max(...dates) + cooldownMilliseconds).toISOString() : null;
};

const chooseReviewQuestions = (pending) => {
  const groups = new Map();
  for (const { char, candidates } of pending) {
    const best = candidates[0];
    // 同一道题可以复练多个字，前提是每个字都适合在这门课的阶段复习。
    for (const question of candidates) {
      if (question.phase !== best.phase || question.mastered !== best.mastered) break;
      let group = groups.get(question.id);
      if (!group) {
        group = { question, chars: [] };
        groups.set(question.id, group);
      }
      group.chars.push(char);
    }
  }

  const assigned = new Set();
  const chosen = new Map();
  const shared = [...groups.values()].filter(({ chars }) => chars.length > 1)
    .sort((left, right) => right.chars.length - left.chars.length || compareQuestion(left.question, right.question));
  for (const { question, chars } of shared) {
    const remaining = chars.filter(({ char }) => !assigned.has(char));
    if (remaining.length < 2) continue;
    chosen.set(question.id, remaining);
    for (const row of remaining) assigned.add(row.char);
  }
  for (const { char, candidates: [best] } of pending) {
    if (assigned.has(char.char)) continue;
    if (!chosen.has(best.id)) chosen.set(best.id, []);
    chosen.get(best.id).push(char);
  }
  return chosen;
};

// 一次性迁移种子。日常练习使用写入后的学习库成绩和复练队列。
export const seedLegacyReview = ({ target, catalogDb }) => {
  const lessonOrders = new Map(allRows(catalogDb,
    "SELECT id, grade, term AS unit, lesson_number AS number, sort_order AS sortOrder FROM lessons")
    .map((lesson) => [lesson.id, lessonOrder(lesson)]));
  const questions = allRows(catalogDb,
    `SELECT q.id, q.lesson_id, q.kind, q.position, q.target_chars
     FROM questions q JOIN lessons l ON l.id = q.lesson_id
     WHERE q.kind != 'poem' AND l.lesson_kind != 'classical_poetry'`)
    .map(({ target_chars, ...question }) => ({
      ...question, order: lessonOrders.get(question.lesson_id), chars: JSON.parse(target_chars),
    }));
  const existingStats = Map.groupBy(allRows(target, "SELECT student_id, word_id, attempts, mistakes FROM word_stats"), (row) => row.student_id);
  const students = Map.groupBy(allRows(target,
    `SELECT c.student_id, c.char, c.attempts, c.mistakes,
       c.last_reviewed_at, c.last_mistake_at, p.lesson_id
     FROM char_stats c LEFT JOIN progress p ON p.student_id = c.student_id
     WHERE c.attempts > 0 ORDER BY c.student_id, c.char`), (row) => row.student_id);
  const insertMastery = target.prepare("INSERT INTO inherited_char_mastery (student_id, char) VALUES (?, ?)");
  const insertCarryover = target.prepare(
    "INSERT INTO review_carryover (student_id, word_id, baseline_attempts, available_at) VALUES (?, ?, ?, ?)",
  );
  let inheritedChars = 0;
  let carriedQuestions = 0;

  for (const [studentId, chars] of students) {
    const cutoff = lessonOrders.get(chars[0].lesson_id) ?? -Infinity;
    const wordStats = new Map((existingStats.get(studentId) ?? []).map((row) => [row.word_id, row]));
    const candidatesByChar = new Map();
    for (const question of questions) {
      const candidate = {
        ...question,
        phase: question.order < cutoff ? 0 : question.order === cutoff ? 1 : 2,
        mastered: isMasteredQuestion(wordStats.get(question.id)),
      };
      for (const char of new Set(candidate.chars)) {
        if (!candidatesByChar.has(char)) candidatesByChar.set(char, []);
        candidatesByChar.get(char).push(candidate);
      }
    }

    const pending = [];
    for (const char of chars) {
      const candidates = candidatesByChar.get(char.char);
      if (!candidates) continue;
      if (isMasteredChar(char)) {
        if (candidates.some(({ phase }) => phase < 2)) {
          insertMastery.run(studentId, char.char);
          inheritedChars++;
        }
      } else {
        pending.push({ char, candidates: candidates.sort(compareQuestion) });
      }
    }
    for (const [questionId, chars] of chooseReviewQuestions(pending)) {
      insertCarryover.run(studentId, questionId, wordStats.get(questionId)?.attempts ?? 0, availableAt(chars));
      carriedQuestions++;
    }
  }
  return { inheritedChars, carriedQuestions };
};
