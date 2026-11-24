import { BookOpenCheck } from "lucide-react";
import { useState } from "react";
import type { AppState, DictationWord, LessonSummary, QuestionCarryover } from "../../../shared/types.ts";
import { lessonOrder } from "../../../shared/domain/catalog.ts";
import { hasQuestionAttempt, isMasteredChar, isMasteredQuestion, isQuestionCarryoverActive, isQuestionMasteryInherited } from "../../../shared/domain/reviewPolicy.ts";
import { lessonLabel } from "../../lib/lessonPresentation";

const labels = {
  mastered: "整题已掌握",
  inherited: "考察字已继承",
  pending: "已练待掌握",
  carryover: "错字待复练",
  unreviewed: "还没练过",
  future: "后续课",
};
const statuses = Object.keys(labels) as Array<keyof typeof labels>;
const bookKey = ({ grade, unit }: LessonSummary) => `${grade}-${unit}`;
const gradeNames = ["", "一", "二", "三", "四", "五", "六"];
const previewSize = 6;
const pageSize = 48;

export function MarkedQuestionText({ text, targets, wrongChars }: {
  text: string;
  targets: readonly string[];
  wrongChars?: ReadonlySet<string>;
}) {
  return Array.from(text).map((char, index) => (
    <span
      className={[targets.includes(char) && "target-character", wrongChars?.has(char) && "wrong-character"].filter(Boolean).join(" ")}
      key={index}
    >{char}</span>
  ));
}

export function QuestionMasteryPanel({ charStats, inheritedMasteredChars, questions, lessons, progress, reviewCarryover, wordStats, wrongCharsById }: {
  charStats: AppState["charStats"];
  inheritedMasteredChars: string[];
  questions: DictationWord[];
  lessons: LessonSummary[];
  progress: LessonSummary;
  reviewCarryover: Record<string, QuestionCarryover>;
  wordStats: AppState["wordStats"];
  wrongCharsById: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  const [selectedBook, setSelectedBook] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState<keyof typeof labels>();
  const [visibleQuestionCount, setVisibleQuestionCount] = useState(previewSize);
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const books = new Map<string, LessonSummary>();
  const inherited = new Set(inheritedMasteredChars.filter((char) => isMasteredChar(charStats[char])));
  const groups: Record<keyof typeof labels, Array<{ question: DictationWord; lesson: LessonSummary }>> = {
    mastered: [], inherited: [], pending: [], carryover: [], unreviewed: [], future: [],
  };
  const allTargets = new Set<string>();
  const learnedTargets = new Set<string>();
  const attemptedTargets = new Set<string>();
  let attemptedTotal = 0;
  const progressOrder = lessonOrder(progress);
  for (const question of questions) {
    const lesson = lessonsById.get(question.lessonId);
    if (!lesson || lesson.lessonKind === "classical_poetry") continue;
    const book = bookKey(lesson);
    books.set(book, lesson);
    if (selectedBook !== "all" && selectedBook !== book) continue;

    for (const char of question.chars) allTargets.add(char);
    if (lessonOrder(lesson) > progressOrder) {
      groups.future.push({ question, lesson });
      continue;
    }

    const stat = wordStats[question.id];
    const attempted = hasQuestionAttempt(stat);
    if (attempted) attemptedTotal++;
    for (const char of question.chars) {
      learnedTargets.add(char);
      if (attempted) attemptedTargets.add(char);
    }
    const group = isQuestionCarryoverActive(stat, reviewCarryover[question.id])
      ? "carryover" : isMasteredQuestion(stat) ? "mastered"
      : isQuestionMasteryInherited(question, stat, inherited) ? "inherited" : attempted ? "pending" : "unreviewed";
    groups[group].push({ question, lesson });
  }

  if (!books.size) return null;
  const masteredCharTotal = [...learnedTargets].filter((char) => isMasteredChar(charStats[char])).length;
  const masteredTotal = groups.mastered.length;
  const learnedTotal = masteredTotal + groups.inherited.length + groups.pending.length + groups.carryover.length + groups.unreviewed.length;
  const masteryPercent = masteredTotal === learnedTotal ? 100 : Math.min(99.9, Math.round(masteredTotal / learnedTotal * 1000) / 10);
  const visibleStatuses = statuses.filter((key) => (key !== "carryover" || Object.keys(reviewCarryover).length > 0)
    && (key !== "inherited" || inheritedMasteredChars.length > 0));
  const status = selectedStatus ?? visibleStatuses.find((key) => groups[key].length > 0) ?? "unreviewed";
  const visibleQuestions = groups[status].slice(0, visibleQuestionCount);

  return (
    <section className="panel wide question-mastery-panel">
      <div className="mastery-heading">
        <div>
          <div className="panel-heading"><BookOpenCheck size={20} aria-hidden="true" /><h2>字词掌握进度</h2></div>
          <p>统计到当前课（含本课）。考察字按字去重，古诗按整篇另计。</p>
        </div>
        <label>教材范围
          <select value={selectedBook} onChange={(event) => {
            setSelectedBook(event.target.value);
            setVisibleQuestionCount(previewSize);
          }}>
            <option value="all">全部教材</option>
            {[...books.entries()].sort(([, left], [, right]) => lessonOrder(left) - lessonOrder(right)).map(([key, book]) => (
              <option key={key} value={key}>{gradeNames[book.grade]}年级{book.unit === 1 ? "上" : "下"}册</option>
            ))}
          </select>
        </label>
      </div>
      <dl className="mastery-summary">
        {[
          { label: "已掌握整题", value: masteredTotal, total: learnedTotal, unit: "题",
            note: learnedTotal ? `占已学字词题的 ${masteryPercent}%` : "当前范围暂无已学题" },
          { label: "已掌握考察字", value: masteredCharTotal, total: learnedTargets.size, unit: "字",
            note: `所选教材共 ${allTargets.size} 个考察字` },
          { label: "已练题覆盖的字", value: attemptedTargets.size, total: learnedTargets.size, unit: "字",
            note: `来自 ${attemptedTotal} 道已练题` },
        ].map(({ label, value, total, unit, note }) => (
          <div className="mastery-metric" key={label}>
            <dt>{label}</dt>
            <dd className="mastery-metric-value"><strong>{value}</strong> / {total} {unit}</dd>
            <dd className="mastery-metric-bar"><progress aria-hidden="true" value={value} max={Math.max(1, total)} /></dd>
            <dd className="mastery-metric-note">{note}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mastery-list-heading">按状态查看题目</h3>
      <div className="mastery-statuses" role="group" aria-label="题目掌握状态">
        {visibleStatuses.map((key) => (
          <button key={key} type="button" aria-pressed={status === key} onClick={() => {
            setSelectedStatus(key);
            setVisibleQuestionCount(previewSize);
          }}>{labels[key]} <strong>{groups[key].length}</strong></button>
        ))}
      </div>
      {visibleQuestions.length ? (
        <>
          <p className="muted">{status === "inherited"
            ? "以往的逐字记录显示，这些题的考察字都已掌握。完成整题默写后，按整题结果计分。"
            : "下划线标出考察字，红字标出有记录的错字。"}</p>
          <ul className="mastery-question-list" aria-label={labels[status]}>
            {visibleQuestions.map(({ question, lesson }) => {
              const wrongChars = wrongCharsById.get(question.id);
              return (
                <li key={question.id} className="mastery-question-item">
                  <strong aria-label={`${question.text}，考察字 ${question.chars.join("、")}${wrongChars?.size ? `，曾错字 ${[...wrongChars].join("、")}` : ""}`}>
                    <MarkedQuestionText text={question.text} targets={question.chars} wrongChars={wrongChars} />
                  </strong>
                  <small>{lessonLabel(lesson)}</small>
                </li>
              );
            })}
          </ul>
          {visibleQuestions.length < groups[status].length && (
            <button className="show-more-logs" type="button" onClick={() => setVisibleQuestionCount((current) => current + pageSize)}>
              显示更多 · 已显示 {visibleQuestions.length} / {groups[status].length} 题
            </button>
          )}
        </>
      ) : <p className="muted">所选范围没有这类题目。</p>}
    </section>
  );
}
