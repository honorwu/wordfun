import { BookOpen } from "lucide-react";
import type { ClassicalText, PracticeItem } from "../../../shared/types.ts";
import { charReviewKey } from "../../../shared/domain/index.ts";

export function PoetryCard({
  index,
  item,
  onToggleWrong,
  poem,
  reviewing,
  wrongCharKeys,
}: {
  index: number;
  item: PracticeItem;
  onToggleWrong: (wordId: string, char: string) => void;
  poem: ClassicalText;
  reviewing: boolean;
  wrongCharKeys: Set<string>;
}) {
  const poemChars = item.word.chars;
  const wrongCount = poemChars.filter((char) => wrongCharKeys.has(charReviewKey(item.word.id, char))).length;
  const renderReviewText = (text: string, keyPrefix: string) => Array.from(text).map((char, charIndex) => {
    if (!/\p{Script=Han}/u.test(char)) return <span className="poetry-heading-punctuation" key={`${keyPrefix}-${charIndex}`}>{char}</span>;
    const isWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
    return (
      <button
        className={isWrong ? "wrong" : ""}
        type="button"
        key={`${keyPrefix}-${char}-${charIndex}`}
        onClick={() => onToggleWrong(item.word.id, char)}
        aria-pressed={isWrong}
        aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}
      >
        {char}
      </button>
    );
  });

  return (
    <article className={`poetry-card ${reviewing ? "revealed" : ""} ${wrongCount > 0 ? "has-wrong" : ""}`}>
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        <span>古诗背诵默写</span>
        {reviewing ? <b>{wrongCount > 0 ? `${wrongCount} 个错字` : "待批改"}</b> : null}
      </div>
      <header className={`poetry-title ${reviewing ? "answer-title" : "prompt-title"}`}>
        {reviewing ? (
          <>
            <h3>{renderReviewText(poem.title, "title")}</h3>
            {poem.dynasty || poem.author ? <span className="poetry-byline">{renderReviewText(`${poem.dynasty ? `〔${poem.dynasty}〕` : ""}${poem.author ?? ""}`, "byline")}</span> : null}
            {poem.titlePinyin ? <small>{poem.titlePinyin}</small> : null}
          </>
        ) : (
          <>
            <p>{poem.titlePinyin || "题目拼音待补充"}</p>
            <small>根据拼音默写题目</small>
          </>
        )}
      </header>
      {reviewing ? (
        <div className="poetry-answer">
          {poem.lines.map((line, lineIndex) => (
            <div className="poetry-line" key={`${poem.id}-${lineIndex}`}>
              <div className="poetry-chars">
                {Array.from(line.text).map((char, charIndex) => {
                  if (!/\p{Script=Han}/u.test(char)) return <span className="poetry-punctuation" key={`${char}-${charIndex}`}>{char}</span>;
                  const isWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
                  return (
                    <button
                      className={isWrong ? "wrong" : ""}
                      type="button"
                      key={`${char}-${charIndex}`}
                      onClick={() => onToggleWrong(item.word.id, char)}
                      aria-pressed={isWrong}
                      aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}
                    >
                      {char}
                    </button>
                  );
                })}
              </div>
              <p>{line.pinyin}</p>
            </div>
          ))}
          <p className="poetry-review-hint">只需点击写错的字，未点选的字会记为正确。</p>
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
