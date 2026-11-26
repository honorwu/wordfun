import { Check, Eye, Volume2, X } from "lucide-react";
import type { DictationWord, PracticeItem, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import type { SpeechPlayback } from "./types";
import { mistakeReviewLabels } from "./types";
import { hanChars } from "../../../shared/domain/characters.ts";
import { WordIssueControls } from "../../components/WordIssues";
import { TextbookHint } from "./TextbookHint";
import { reviewMark, type CardReview } from "./reviewMarks";

export interface DictationQuestion {
  word: Pick<DictationWord, "id" | "text" | "pinyin" | "textbookHint">;
  lessonSource: string;
  textbookExcerpt?: boolean;
  mistakeReview?: PracticeItem["mistakeReview"];
}

export function DictationCard({
  index,
  question: { word, lessonSource, textbookExcerpt, mistakeReview },
  dictation,
  review,
  issue,
  onToggleIssue,
}: {
  index: number;
  question: DictationQuestion;
  dictation?: {
    active: boolean;
    pinyinShown: boolean;
    maskedHint?: string;
    onActivate: () => void;
    onShowPinyin: () => void;
    onTogglePlayback: () => void;
    playback: SpeechPlayback;
  };
  review?: CardReview;
  issue?: WordIssue;
  onToggleIssue?: (kind: WordIssueKind) => void;
}) {
  const chars = hanChars(word.text);
  const syllables = word.pinyin
    .split(/\s+/u)
    .map((syllable) => syllable.replace(/[，。！？；：、,.!?;:]/gu, ""))
    .filter(Boolean);
  const marks = review ? chars.map((char) => reviewMark(review, word.id, char)) : [];
  const hasWrong = marks.some((mark) => mark.wrong);
  const active = dictation?.active;
  const playback = dictation?.playback;
  const isPlaybackActive = Boolean(playback && playback.stage !== "idle");
  const playbackLabel = playback?.stage === "first"
    ? "正在播放第 1 遍 · 点击停止"
    : playback?.stage === "waiting"
      ? `${playback.countdown} 秒后播放第 2 遍 · 点击停止`
      : playback?.stage === "second"
        ? "正在播放第 2 遍 · 点击停止"
        : "播放两遍";

  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`dictation-card ${active ? "is-current" : ""} ${chars.length >= 5 ? "long-word" : ""} ${review ? "revealed" : ""} ${hasWrong ? "has-wrong" : ""}`}
      data-item-index={index}
      onClick={dictation?.onActivate}
    >
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        {mistakeReview && <span className="mistake-review-label">{mistakeReviewLabels[mistakeReview]}</span>}
        <span>{lessonSource}</span>
        {textbookExcerpt ? <span className="card-source-label">课文取词</span> : null}
        {review ? <b>{hasWrong ? "有错字" : review.result ?? "待批改"}</b> : active ? <b className="current-item-badge">当前题</b> : null}
      </div>
      {dictation && <div className="card-listen-actions">
        <button
          aria-pressed={isPlaybackActive}
          className={`listen-button ${dictation.playback.stage === "waiting" ? "waiting" : isPlaybackActive ? "speaking" : ""}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            dictation.onActivate();
            dictation.onTogglePlayback();
          }}
        >
          <Volume2 size={19} />{playbackLabel}
        </button>
        <button
          className="pinyin-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            dictation.onActivate();
            dictation.onShowPinyin();
          }}
          disabled={dictation.pinyinShown}
        >
          <Eye size={17} />{dictation.pinyinShown ? "拼音已显示" : "显示拼音"}
        </button>
      </div>}
      <TextbookHint text={dictation?.maskedHint ?? word.textbookHint} />
      <div className="word-cells" aria-label={`第 ${index + 1} 题`}>
        {chars.length === 0 && <p className="muted">{word.text || "题目信息缺失"}</p>}
        {chars.map((char, charIndex) => {
          const mark = marks[charIndex];
          return (
            <div className={mark?.wrong ? "word-cell wrong" : "word-cell"} key={`${char}-${charIndex}`}>
              {(review || dictation?.pinyinShown) && <span className="pinyin">{syllables[charIndex]}</span>}
              {mark ? (
                <button type="button" className={mark.pending ? "pending-wrong" : undefined} {...mark.props}>
                  <strong>{char}</strong><small>{mark.label}</small>
                  {mark.wrong ? <X size={17} /> : !mark.props.disabled && <Check size={17} />}
                </button>
              ) : (
                <div className="character-box">
                  <span className="writing-line" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {onToggleIssue && <WordIssueControls issue={issue} onToggle={onToggleIssue} />}
    </article>
  );
}
