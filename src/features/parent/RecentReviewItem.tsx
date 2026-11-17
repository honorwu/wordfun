import { ClipboardCheck } from "lucide-react";
import type { DictationWord, LessonSummary, ReviewLog } from "../../../shared/types.ts";
import { lessonLabel } from "../../lib/lessonPresentation";
import { formatDate } from "../../lib/dates";

export function RecentReviewItem({
  lessons,
  log,
  onOpenCorrection,
  wordById,
}: {
  lessons: LessonSummary[];
  log: ReviewLog;
  onOpenCorrection: () => void;
  wordById: Map<string, DictationWord>;
}) {
  const wrongWordsWithCharDetails = new Set((log.wrongChars ?? []).map((item) => item.wordId));
  const reviewedLessons = (log.lessons ?? []).map((reference) => ({
    reference,
    lesson: lessons.find((lesson) => lesson.id === reference.id),
  }));
  const lessonText = reviewedLessons.length === 0
    ? "课文信息未记录"
    : reviewedLessons
        .slice(0, 2)
        .map(({ reference, lesson }) => lesson ? lessonLabel(lesson) : reference.title)
        .join("、") + (reviewedLessons.length > 2 ? ` 等 ${reviewedLessons.length} 课` : "");
  const wrongChars = Array.from(new Set((log.wrongChars ?? []).map((item) => item.char)));
  const undetailedWrongWordIds = log.wrongWordIds.filter((wordId) => !wrongWordsWithCharDetails.has(wordId));
  const undetailedWrongWordText = undetailedWrongWordIds.map((id) => wordById.get(id)?.text).filter(Boolean).join("、");
  const wrongSummary = wrongChars.length === 0 && undetailedWrongWordIds.length === 0
    ? "全部正确"
    : [
        wrongChars.length > 0 ? `错 ${wrongChars.length} 字：${wrongChars.join("、")}` : "",
        undetailedWrongWordIds.length > 0
          ? `另有 ${undetailedWrongWordIds.length} 题旧版整词错误${undetailedWrongWordText ? `：${undetailedWrongWordText}` : ""}`
          : "",
      ].filter(Boolean).join("；");
  const modeText = log.practiceMode === "lesson" ? "当课复习" : log.practiceMode === "history" ? "历史复习" : "旧记录";
  const canSupplementMistakes = log.practiceMode === "lesson" || log.practiceMode === "history";

  return (
    <div className="recent-item">
      <div className="recent-item-heading"><time dateTime={log.date}>{formatDate(log.date)}</time><b className={`review-mode ${log.practiceMode ?? "legacy"}`}>{modeText}</b></div>
      <strong className="recent-lesson">{lessonText}</strong>
      <small>{log.wordIds.length} 项 · {wrongSummary}</small>
      {canSupplementMistakes ? (
        <div className="recent-item-actions">
          <button
            aria-label={`打开${modeText}错字补记页面，${formatDate(log.date)}`}
            className="supplement-mistakes-button"
            id={`review-correction-open-${log.id}`}
            type="button"
            onClick={onOpenCorrection}
          >
            <ClipboardCheck size={15} />补记错字
          </button>
        </div>
      ) : null}
    </div>
  );
}
