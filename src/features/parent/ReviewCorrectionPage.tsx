import { Check, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DictationWord, LessonSummary, ReviewLog } from "../../../shared/types.ts";
import { charReviewKey, fullDictationCharsForWord, reviewCharsForWord } from "../../../shared/domain/index.ts";
import { isWithinReviewCorrectionWindow } from "../../../shared/domain/reviewPolicy.ts";
import type { MissedWrongCharCorrection } from "../../../shared/domain/reviews.ts";
import { lessonLabel } from "../../lib/lessonPresentation";
import "./ReviewCorrectionPage.css";

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
  wordById: Map<string, DictationWord>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [expiredDuringSubmit, setExpiredDuringSubmit] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const expired = expiredDuringSubmit || !isWithinReviewCorrectionWindow(log.date, correctionNow);
  const isLegacyRecord = !log.reviewedItems || log.reviewedItems.length === 0;
  const snapshotByWordId = new Map((log.reviewedItems ?? []).map((item) => [item.wordId, item]));
  const existingWrongKeys = new Set((log.wrongChars ?? []).map((item) => charReviewKey(item.wordId, item.char)));
  const wrongWordsWithCharDetails = new Set((log.wrongChars ?? []).map((item) => item.wordId));
  const correctionItems = log.wordIds.map((wordId) => {
    const snapshot = snapshotByWordId.get(wordId);
    const word = wordById.get(wordId);
    const wordText = snapshot ? snapshot.wordText : word?.text ?? "";
    const isUndetailedLegacyWrongWord = isLegacyRecord
      && log.wrongWordIds.includes(wordId)
      && !wrongWordsWithCharDetails.has(wordId);
    const possibleChars = snapshot
      ? snapshot.reviewedChars
      : word ? fullDictationCharsForWord(word) : [];
    const chars = Array.from(new Set(possibleChars)).map((char) => ({
      char,
      canCorrect: !isUndetailedLegacyWrongWord
        && wordText.includes(char)
        && (isLegacyRecord ? Boolean(word && reviewCharsForWord(word).includes(char)) : Boolean(snapshot)),
      isUndetailedLegacyWrongWord,
    }));
    const sourceLesson = word ? lessons.find((lesson) => lesson.id === word.lessonId) : undefined;
    return {
      wordId,
      wordText,
      chars,
      lessonText: sourceLesson ? lessonLabel(sourceLesson) : word?.lessonTitle || "课次信息缺失",
    };
  });
  const modeText = log.practiceMode === "history" ? "历史复习" : "当课复习";
  const reviewedLessons = (log.lessons ?? []).map((reference) => {
    const lesson = lessons.find((item) => item.id === reference.id);
    return lesson ? lessonLabel(lesson) : reference.title;
  });
  const lessonText = reviewedLessons.length === 0
    ? "课文信息未记录"
    : reviewedLessons.slice(0, 2).join("、") + (reviewedLessons.length > 2 ? ` 等 ${reviewedLessons.length} 课` : "");

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const submitCorrections = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (expired || !isWithinReviewCorrectionWindow(log.date)) {
      setExpiredDuringSubmit(true);
      return;
    }
    const corrections = correctionItems.flatMap((item) => item.chars.flatMap(({ char }) =>
      selectedKeys.has(charReviewKey(item.wordId, char))
        ? [{ wordId: item.wordId, char }]
        : [],
    ));
    if (corrections.length === 0) return;

    setIsSubmitting(true);
    setSubmitError("");
    try {
      if (await onSupplementReviewMistakes(log.id, corrections) > 0) onBack();
      else setSubmitError("没有可写入的更正，请重新打开记录核对。");
    } catch (error) {
      if (!isWithinReviewCorrectionWindow(log.date)) setExpiredDuringSubmit(true);
      setSubmitError(error instanceof Error ? error.message : "补记保存失败，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className={`parent-main review-correction-page practice-mode-${log.practiceMode === "history" ? "history" : "lesson"}`}>
      <div className="review-correction-hero">
        <button className="review-correction-back" disabled={isSubmitting} type="button" onClick={onBack}><ChevronLeft size={19} />返回默写记录</button>
        <p className="eyebrow">{modeText} · 错字补记</p>
        <h1 ref={headingRef} tabIndex={-1}>补记这次漏标的错字</h1>
        <div className="review-correction-meta">
          <time dateTime={log.date}>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(log.date))}</time>
          <span>{lessonText}</span>
          <span>共 {correctionItems.length} 题</span>
        </div>
      </div>

      {expired && !isSubmitting ? (
        <div className="review-correction-guidance" role="status"><strong>这次默写的 72 小时补记期限已结束。</strong></div>
      ) : (
        <div className="review-correction-guidance">
          <strong>请对照孩子当时的默写，点选漏标的错字。</strong>
          <span>橙色“已有错字”不能重复补记；只会修正这次的错字结果，作答次数和其他字不变。</span>
          {isLegacyRecord ? <span className="legacy-correction-note">旧记录没有保存逐字题目快照，以下题词按当前词库还原；只开放词库目标字。提示字缺少当场计分证据，不能安全补记。请先核对当时的题词。</span> : null}
        </div>
      )}
      {submitError && <p className="muted" role="alert">{submitError}</p>}

      <form aria-busy={isSubmitting} onSubmit={submitCorrections}>
        <div className="review-correction-grid">
          {correctionItems.map((item, itemIndex) => {
            const isLongText = item.wordText.includes("\n") || Array.from(item.wordText).length > 20;
            return (
              <article className={`review-correction-card ${isLongText ? "long-text" : ""}`} key={`${item.wordId}-${itemIndex}`}>
                <div className="review-correction-card-heading">
                  <span className="question-number">{String(itemIndex + 1).padStart(2, "0")}</span>
                  <small>{item.lessonText}</small>
                </div>
                <div className="review-correction-prompt">
                  {item.wordText ? Array.from(item.wordText).map((char, charIndex) => {
                    const key = charReviewKey(item.wordId, char);
                    return <span className={existingWrongKeys.has(key) ? "existing" : !expired && selectedKeys.has(key) ? "selected" : ""} key={charIndex}>{char}</span>;
                  }) : "题目信息缺失"}
                </div>
              <div className="review-correction-characters" role="group" aria-label={`第 ${itemIndex + 1} 题计分字`}>
                  {item.chars.length === 0 ? <span className="unavailable-correction">无法从旧记录确认计分字</span> : item.chars.map(({ canCorrect, char, isUndetailedLegacyWrongWord }) => {
                    const key = charReviewKey(item.wordId, char);
                    const alreadyWrong = existingWrongKeys.has(key);
                    const selected = !expired && selectedKeys.has(key);
                    const status = alreadyWrong ? "已有错字" : isUndetailedLegacyWrongWord ? "已有整词错误" : !canCorrect ? "无法确认" : selected ? "新补记错字" : "原记正确";
                    return (
                      <button
                        aria-label={`第 ${itemIndex + 1} 题“${char}”：${status}`}
                        aria-pressed={selected}
                        className={`review-correction-choice ${alreadyWrong ? "existing" : selected ? "selected" : !canCorrect ? "unavailable" : ""}`}
                        disabled={isSubmitting || expired || alreadyWrong || !canCorrect}
                        key={char}
                        type="button"
                        onClick={() => setSelectedKeys((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                      >
                        <b>{char}</b><span>{status}</span>
                      </button>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
        {(!expired || isSubmitting) && <div className="review-correction-footer">
          <div><strong>已选 {selectedKeys.size} 处漏标错字</strong><span>确认后写入原默写记录</span></div>
          <div className="action-buttons">
            <button className="secondary-button" disabled={isSubmitting} type="button" onClick={onBack}>取消</button>
            <button className="primary-button" disabled={isSubmitting || expired || selectedKeys.size === 0} type="submit">
              <Check size={17} />{isSubmitting ? "正在保存…" : `确认补记 ${selectedKeys.size} 处错字`}
            </button>
          </div>
        </div>}
      </form>
    </section>
  );
}
