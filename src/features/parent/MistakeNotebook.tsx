import { NotebookPen, Printer } from "lucide-react";
import { useMemo, useState } from "react";
import type { DictationWord, LessonSummary, WordStat } from "../../../shared/types.ts";
import { lessonOrder } from "../../../shared/domain/catalog.ts";
import { isMasteredQuestion } from "../../../shared/domain/reviewPolicy.ts";
import { lessonLabel } from "../../lib/lessonPresentation";
import { MarkedQuestionText } from "./QuestionMasteryPanel";
import "./MistakeNotebook.css";

const pageSize = 20;

type NotebookQuestion = { question: DictationWord; lesson: LessonSummary };
type NotebookRow = NotebookQuestion & { mastered: boolean; carried?: boolean };

export function MistakeNotebook({ carriedQuestions, scoredQuestions, selectedLesson, wrongCharsById }: {
  carriedQuestions: ReadonlyArray<NotebookQuestion>;
  scoredQuestions: ReadonlyArray<NotebookQuestion & { stat: WordStat }>;
  selectedLesson: LessonSummary;
  wrongCharsById: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  const [filter, setFilter] = useState<"pending" | "history">("pending");
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const { history, pending } = useMemo(() => {
    const courseOrder = lessonOrder(selectedLesson);
    const historyRows: NotebookRow[] = scoredQuestions.filter(({ stat }) => stat.mistakes > 0)
      .map((item) => ({ ...item, mastered: isMasteredQuestion(item.stat) }))
      .sort((left, right) => Number(left.mastered) - Number(right.mastered)
        || (right.stat.lastMistakeAt ?? "").localeCompare(left.stat.lastMistakeAt ?? ""));
    const pendingMap = new Map(historyRows.filter(({ lesson, mastered }) => !mastered && lessonOrder(lesson) <= courseOrder)
      .map((row) => [row.question.id, row]));
    for (const { question, lesson } of carriedQuestions) {
      if (lessonOrder(lesson) > courseOrder || pendingMap.has(question.id)) continue;
      pendingMap.set(question.id, { question, lesson, mastered: false, carried: true });
    }
    return { history: historyRows, pending: pendingMap };
  }, [scoredQuestions, carriedQuestions, selectedLesson]);
  const showHistory = filter === "history";
  const rows = showHistory ? history : [...pending.values()];
  const listTitle = showHistory ? "历史错题" : "待巩固题目";

  return (
    <section className="panel wide mistake-notebook printable-report" aria-label="错题本">
      <div className="panel-title-row">
        <div className="panel-heading"><NotebookPen size={20} aria-hidden="true" /><h2>错题本</h2></div>
        <button className="print-report-button" type="button" onClick={() => window.print()} disabled={!rows.length}>
          <Printer size={16} aria-hidden="true" />打印{listTitle}
        </button>
      </div>
      <div className="notebook-filters" role="group" aria-label="错题范围">
        {(["pending", "history"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => {
            setFilter(value);
            setVisibleCount(pageSize);
          }}>
            {value === "pending" ? "待巩固" : "全部历史"} <b>{value === "pending" ? pending.size : history.length}</b>
          </button>
        ))}
      </div>
      <p className="print-metadata">{listTitle} · {rows.length} 题 · {new Date().toLocaleDateString("zh-CN")}</p>
      {rows.length === 0 ? <p className="muted notebook-empty">{showHistory ? "还没有整题写错的记录。" : "当前学习进度内没有待巩固的题目。"}</p> : (
        <>
          <p className="notebook-guide">
            {showHistory ? `所有曾写错的整题中，${history.filter(({ mastered }) => mastered).length} 道现已掌握。` : "收录截至当前课仍需巩固的错题和历史错字复练题。"}
            <span className="notebook-target-key">下划线</span>标出考察字，<span className="notebook-error-key">红字</span>标出曾错字。
          </p>
          <table className="notebook-table" aria-label={listTitle}>
            <thead><tr><th scope="col">题目</th><th scope="col">课次</th>{showHistory && <th scope="col">状态</th>}</tr></thead>
            <tbody>
              {rows.map(({ question, lesson, mastered, carried }, index) => {
                const wrongChars = carried ? undefined : wrongCharsById.get(question.id);
                const poem = lesson.lessonKind === "classical_poetry";
                return (
                  <tr key={question.id} className={index >= visibleCount ? "notebook-print-row" : undefined}>
                    <th scope="row" className="notebook-question">
                      {poem ? <strong>《{question.lessonTitle}》全文</strong> : <strong
                        aria-label={wrongChars?.size ? `${question.text}，曾错字 ${[...wrongChars].join("、")}` : undefined}
                      ><MarkedQuestionText text={question.text} targets={question.chars} wrongChars={wrongChars} /></strong>}
                      {carried ? <small>历史错字复练</small> : !wrongChars?.size ? <small>未记录具体错字</small>
                        : poem && <small>曾错字 <b className="notebook-error-key">{[...wrongChars].join("、")}</b></small>}
                    </th>
                    <td className="notebook-source">{lessonLabel(lesson)}</td>
                    {showHistory && <td className="notebook-status"><span className={mastered ? "is-mastered" : "is-pending"}>
                      {mastered ? "已掌握" : "待巩固"}
                    </span></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > visibleCount && <button type="button" className="show-more-logs" onClick={() => setVisibleCount(visibleCount + pageSize)}>
            显示更多 · 已显示 {visibleCount} / {rows.length} 题
          </button>}
        </>
      )}
    </section>
  );
}
