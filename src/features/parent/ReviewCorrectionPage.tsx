import { Check, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DictationWord, LessonSummary, ReviewLog } from "../../../shared/types.ts";
import { charReviewKey } from "../../../shared/domain/characters.ts";
import { canSupplementReview } from "../../../shared/domain/reviewPolicy.ts";
import type { MissedWrongCharCorrection } from "../../../shared/domain/reviews.ts";
import { ReviewCards } from "../practice/ReviewCards";
import { reviewRecordLessonText, reviewRecordModeLabel, reviewRecordQuestions } from "./reviewRecord";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export function ReviewCorrectionPage({
  correctionNow,
  lessons,
  log,
  onBack,
  onSupplementReviewMistakes,
  wordById,
}: {
  correctionNow: number;
  lessons: LessonSummary[];
  log: ReviewLog;
  onBack: () => void;
  onSupplementReviewMistakes: (logId: string, corrections: MissedWrongCharCorrection[]) => Promise<number>;
  wordById: ReadonlyMap<string, DictationWord>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState(() => new Map<string, MissedWrongCharCorrection>());
  const [expiredDuringSubmit, setExpiredDuringSubmit] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const canEdit = !expiredDuringSubmit && canSupplementReview(log, correctionNow);
  const questions = reviewRecordQuestions(log, wordById, lessons);
  const savedWrongKeys = new Set((log.wrongChars ?? []).map(({ wordId, char }) => charReviewKey(wordId, char)));
  const selectedKeys = new Set(canEdit ? draft.keys() : []);
  const mode = log.practiceMode === "history" ? "history" : "lesson";
  const questionUnit = questions.length > 0 && questions.every(({ poem }) => poem) ? "篇" : "题";

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const submitCorrections = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || draft.size === 0) return;
    if (!canEdit || !canSupplementReview(log)) {
      setExpiredDuringSubmit(true);
      return;
    }
    setIsSubmitting(true);
    setSubmitError("");
    try {
      if (await onSupplementReviewMistakes(log.id, [...draft.values()]) > 0) onBack();
      else setSubmitError("没有可写入的更正，请重新打开记录核对。");
    } catch (error) {
      if (!canSupplementReview(log)) setExpiredDuringSubmit(true);
      setSubmitError(error instanceof Error ? error.message : "补记保存失败，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleWrong = (wordId: string, char: string) => {
    const key = charReviewKey(wordId, char);
    setDraft((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, { wordId, char });
      return next;
    });
  };

  return (
    <section className={`student-main review-record practice-mode-${mode}`}>
      <button className="secondary-button" disabled={isSubmitting} type="button" onClick={onBack}><ChevronLeft size={19} />返回默写记录</button>
      <header className="practice-heading">
        <div className="practice-heading-row">
          <h1 ref={headingRef} tabIndex={-1}>默写批改记录</h1>
          <span className="phase-badge">{canEdit ? "补记错字" : "只读"}</span>
        </div>
        <div className="practice-details">
          <p>
            <time dateTime={log.date}>{dateFormat.format(new Date(log.date))}</time>
            {` · ${reviewRecordModeLabel(log)} · ${reviewRecordLessonText(log, lessons)} · 共 ${questions.length} ${questionUnit}`}
          </p>
        </div>
      </header>
      {canEdit ? (
        <p className="word-issue-guide">对照当时的默写，点选漏标的错字。红色实线框是已记错的字，虚线框是待补记的字。</p>
      ) : (
        <p className="word-issue-guide" role="status">{log.practiceMode ? "这场默写的 72 小时补记期限已结束。" : "这条早期记录可供回看。"}</p>
      )}
      {!log.reviewedItems?.length && <p className="word-issue-guide">早期记录的题目按当前词库还原。{canEdit && "补记以可确认的计分字为准。"}</p>}
      {submitError && !canEdit && <p className="word-issue-guide" role="alert">{submitError}</p>}
      <form aria-busy={isSubmitting} onSubmit={submitCorrections}>
        <ReviewCards questions={questions} marks={{ selectedKeys, savedWrongKeys, onToggle: canEdit ? toggleWrong : undefined, disabled: isSubmitting }} />
        {(canEdit || isSubmitting) && <div className="sticky-actions">
          <div aria-live="polite">
            <strong>已选 {selectedKeys.size} 处错字</strong>
            {submitError && <p className="review-save-error" role="alert">{submitError}</p>}
          </div>
          <div className="action-buttons">
            <button className="secondary-button" disabled={isSubmitting} type="button" onClick={onBack}>取消</button>
            <button className="primary-button" disabled={isSubmitting || !canEdit || selectedKeys.size === 0} type="submit">
              <Check size={19} />{isSubmitting ? "正在保存…" : "确认补记"}
            </button>
          </div>
        </div>}
      </form>
    </section>
  );
}
