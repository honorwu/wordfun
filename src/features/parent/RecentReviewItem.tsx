import { ClipboardCheck, Eye } from "lucide-react";
import type { DictationWord, LessonSummary, ReviewLog } from "../../../shared/types.ts";
import { canSupplementReview } from "../../../shared/domain/reviewPolicy.ts";
import { formatDate } from "../../lib/dates";
import { reviewRecordLessonText, reviewRecordModeLabel } from "./reviewRecord";

export function RecentReviewItem({
  lessons,
  log,
  correctionNow,
  onOpenReview,
  wordById,
}: {
  lessons: LessonSummary[];
  log: ReviewLog;
  correctionNow: number;
  onOpenReview: () => void;
  wordById: Map<string, DictationWord>;
}) {
  const wrongWordsWithCharDetails = new Set((log.wrongChars ?? []).map((item) => item.wordId));
  const wrongChars = Array.from(new Set((log.wrongChars ?? []).map((item) => item.char)));
  const undetailedWrongWordIds = log.wrongWordIds.filter((wordId) => !wrongWordsWithCharDetails.has(wordId));
  const undetailedWrongWordText = undetailedWrongWordIds.map((id) =>
    log.reviewedItems?.find(({ wordId }) => wordId === id)?.wordText ?? wordById.get(id)?.text,
  ).filter(Boolean).join("、");
  const wrongSummary = wrongChars.length === 0 && undetailedWrongWordIds.length === 0
    ? "全部正确"
    : [
        wrongChars.length > 0 ? `错 ${wrongChars.length} 字：${wrongChars.join("、")}` : "",
        undetailedWrongWordIds.length > 0
          ? `另有 ${undetailedWrongWordIds.length} 题旧版整词错误${undetailedWrongWordText ? `：${undetailedWrongWordText}` : ""}`
          : "",
      ].filter(Boolean).join("；");
  const modeText = reviewRecordModeLabel(log);
  const date = formatDate(log.date);
  const canSupplement = canSupplementReview(log, correctionNow);
  const actionLabel = canSupplement ? "补记错字" : "查看默写";
  const ActionIcon = canSupplement ? ClipboardCheck : Eye;

  return (
    <div className="recent-item">
      <div className="recent-item-heading"><time dateTime={log.date}>{date}</time><b className={`review-mode ${log.practiceMode ?? "legacy"}`}>{modeText}</b></div>
      <strong className="recent-lesson">{reviewRecordLessonText(log, lessons)}</strong>
      <small>{log.wordIds.length} 项 · {wrongSummary}</small>
      <div className="recent-item-actions">
        <button
          aria-label={`${actionLabel}，${modeText}，${date}`}
          className="review-open-button"
          id={`review-open-${log.id}`}
          type="button"
          onClick={onOpenReview}
        >
          <ActionIcon size={15} />{actionLabel}
        </button>
      </div>
    </div>
  );
}
