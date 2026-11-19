import { useMemo, useState } from "react";
import type { AppState, BookCharacterIndex, LessonSummary } from "../../../shared/types.ts";
import { groupCharacterMastery } from "../../../shared/domain/characterMastery.ts";
import { historyMistakeCooldownDays, historyMistakeWordLimit } from "../../../shared/domain/reviewPolicy.ts";
import { lessonLabel } from "../../lib/lessonPresentation";

const labels = {
  mastered: "未错过 · 已掌握",
  corrected: "曾写错 · 已掌握",
  pending: "曾写错 · 仍未掌握",
  unreviewed: "已学 · 还没默过",
  future: "后续课 · 尚未学到",
};
const learnedStatuses = ["mastered", "corrected", "pending", "unreviewed"] as const;
const bookKey = (grade: number, term: number) => `${grade}-${term}`;
const gradeNames = ["", "一", "二", "三", "四", "五", "六"];

export function CharacterMasteryPanel({ books, progress, charStats }: {
  books: BookCharacterIndex[];
  progress: LessonSummary;
  charStats: AppState["charStats"];
}) {
  const [selectedBook, setSelectedBook] = useState("all");
  const [status, setStatus] = useState<keyof typeof labels>("pending");
  const [selectedChar, setSelectedChar] = useState("");
  const book = books.find((item) => bookKey(item.grade, item.term) === selectedBook);
  const { groups, examples } = useMemo(() => groupCharacterMastery(books, progress, charStats, book), [books, progress, charStats, book]);
  if (!books.length) return null;

  const selectedExamples = groups[status].includes(selectedChar) ? examples.get(selectedChar) : undefined;
  const learnedTotal = learnedStatuses.reduce((total, key) => total + groups[key].length, 0);
  const masteredTotal = groups.mastered.length + groups.corrected.length;
  const masteryPercent = masteredTotal === learnedTotal ? 100 : Math.min(99.9, Math.round(masteredTotal / learnedTotal * 1000) / 10);
  const statusButton = (key: keyof typeof labels) => (
    <button type="button" key={key} aria-pressed={status === key} onClick={() => {
      setStatus(key);
      setSelectedChar("");
    }}>{labels[key]} <strong>{groups[key].length}</strong></button>
  );
  return (
    <section className="panel wide character-mastery-panel">
      <div className="panel-title-row">
        <div className="panel-heading"><h2>已学字的掌握进度</h2></div>
        <label>查看范围{" "}
          <select value={selectedBook} onChange={(event) => {
            setSelectedBook(event.target.value);
            setSelectedChar("");
          }}>
            <option value="all">全部教材（按字去重）</option>
            {books.map((item) => (
              <option key={bookKey(item.grade, item.term)} value={bookKey(item.grade, item.term)}>
                {gradeNames[item.grade]}年级{item.term === 1 ? "上" : "下"}册
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">统计到{lessonLabel(progress)}（含本课），按字去重。古诗词单独整篇练习，不计入这项字词进度。</p>
      <div className="mastery-summary">
        <div className="mastery-summary-count">
          <strong>已掌握 {masteredTotal} / {learnedTotal} 个已学字</strong>
          <span>{learnedTotal ? `${masteryPercent}%` : "—"}</span>
        </div>
        <progress aria-label="已学字掌握进度" value={masteredTotal} max={Math.max(1, learnedTotal)} />
        <p>已默写 <strong>{learnedTotal - groups.unreviewed.length}</strong> 字，距离已学字全部掌握还差 <strong>{learnedTotal - masteredTotal}</strong> 字。</p>
      </div>
      <div className="mastery-statuses" aria-label="已学字的掌握状态">
        {learnedStatuses.map(statusButton)}
      </div>
      <div className="mastery-statuses mastery-future" aria-label="后续课的生字">
        {statusButton("future")}
      </div>
      <p className="muted">本课用当课复习。历史复习每轮最多 {historyMistakeWordLimit} 道到期错词，其余向前筛查没默过的字。出题后整词默写；未掌握的错字满 {historyMistakeCooldownDays} 天才再练。</p>
      <p className="muted">还没默过的字表示尚未测过，不等于不会。</p>
      <div className="mastery-characters" aria-label={labels[status]}>
        {groups[status].length ? groups[status].map((char) => (
          <button type="button" key={char} aria-pressed={char === selectedChar} onClick={() => setSelectedChar(char)}>{char}</button>
        )) : <span className="muted">所选范围没有这类字。</span>}
      </div>
      {selectedExamples && <p className="mastery-examples" aria-live="polite"><strong>{selectedChar}</strong>：{
        selectedExamples.size ? [...selectedExamples].join("、") : "识字表或写字表收录，无对应的册末词语。"
      }</p>}
    </section>
  );
}
