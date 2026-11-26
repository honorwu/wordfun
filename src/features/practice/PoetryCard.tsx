import { BookOpen } from "lucide-react";
import type { ClassicalText } from "../../../shared/types.ts";
import { hanChars, uniqueChars } from "../../../shared/domain/characters.ts";
import { reviewMark, type CardReview } from "./reviewMarks";

export function PoetryCard({
  index,
  poem,
  wordId,
  review,
}: {
  index: number;
  poem: ClassicalText;
  wordId: string;
  review?: CardReview;
}) {
  const byline = `${poem.dynasty ? `〔${poem.dynasty}〕` : ""}${poem.author ?? ""}`;
  const marks = new Map(review ? uniqueChars(hanChars([poem.title, byline, ...poem.lines.map((line) => line.text)].join("")))
    .map((char) => [char, reviewMark(review, wordId, char)]) : []);
  const wrongCount = [...marks.values()].filter((mark) => mark.wrong).length;
  const renderReviewText = (text: string, punctuationClass: string) => Array.from(text).map((char, charIndex) => {
    const mark = marks.get(char);
    if (!mark) return <span className={punctuationClass} key={charIndex}>{char}</span>;
    return (
      <button
        className={mark.pending ? "wrong pending-wrong" : mark.wrong ? "wrong" : undefined}
        type="button"
        key={charIndex}
        {...mark.props}
      >
        {char}
      </button>
    );
  });

  return (
    <article className={`poetry-card ${review ? "revealed" : ""} ${wrongCount > 0 ? "has-wrong" : ""}`}>
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span>古诗背诵默写</span>
        {review && <b>{wrongCount > 0 ? `${wrongCount} 个错字` : review.result ?? "待批改"}</b>}
      </div>
      <header className={`poetry-title ${review ? "answer-title" : "prompt-title"}`}>
        {review ? (
          <>
            <h3>{renderReviewText(poem.title, "poetry-heading-punctuation")}</h3>
            {byline && <span className="poetry-byline">{renderReviewText(byline, "poetry-heading-punctuation")}</span>}
            {poem.titlePinyin ? <small>{poem.titlePinyin}</small> : null}
          </>
        ) : (
          <>
            <p>{poem.titlePinyin || "题目拼音待补充"}</p>
            <small>根据拼音默写题目</small>
          </>
        )}
      </header>
      {review ? (
        <div className="poetry-answer">
          {poem.lines.map((line, lineIndex) => (
            <div className="poetry-line" key={`${poem.id}-${lineIndex}`}>
              <div className="poetry-chars">{renderReviewText(line.text, "poetry-punctuation")}</div>
              {line.pinyin && <p>{line.pinyin}</p>}
            </div>
          ))}
          {!review.savedWrongKeys && <p className="poetry-review-hint">只需点击写错的字，未点选的字会记为正确。</p>}
        </div>
      ) : (
        <div className="poetry-memory-prompt">
          <BookOpen size={28} />
          <strong>请默写题目、朝代、作者和全文</strong>
          <span>只提供题目拼音 · 不播放语音</span>
          <div className="poetry-writing-lines" aria-hidden="true">
            {poem.lines.map((_, lineIndex) => <i key={lineIndex} />)}
          </div>
        </div>
      )}
    </article>
  );
}
