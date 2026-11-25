import { Check, Eye, Volume2, X } from "lucide-react";
import type { PracticeItem, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import type { SpeechPlayback } from "./types";
import { mistakeReviewLabels } from "./types";
import { charReviewKey, hanChars } from "../../../shared/domain/characters.ts";
import { WordIssueControls } from "../../components/WordIssues";
import { TextbookHint } from "./TextbookHint";

export function DictationCard({
  active,
  lessonSource,
  pinyinShown,
  index,
  item,
  maskedHint,
  onActivate,
  onShowPinyin,
  onTogglePlayback,
  onToggleWrong,
  playback,
  reviewing,
  wrongCharKeys,
  issue,
  onToggleIssue,
}: {
  active: boolean;
  lessonSource: string;
  pinyinShown: boolean;
  index: number;
  item: PracticeItem;
  maskedHint?: string;
  onActivate: () => void;
  onShowPinyin: () => void;
  onTogglePlayback: () => void;
  onToggleWrong: (wordId: string, char: string) => void;
  playback: SpeechPlayback;
  reviewing: boolean;
  wrongCharKeys: Set<string>;
  issue?: WordIssue;
  onToggleIssue: (kind: WordIssueKind) => void;
}) {
  const chars = hanChars(item.word.text);
  const syllables = item.word.pinyin
    .split(/\s+/u)
    .map((syllable) => syllable.replace(/[，。！？；：、,.!?;:]/gu, ""))
    .filter(Boolean);
  const showPinyin = reviewing || pinyinShown;
  const hasWrong = chars.some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
  const isPlaybackActive = playback.stage !== "idle";
  const playbackLabel = playback.stage === "first"
    ? "正在播放第 1 遍 · 点击停止"
    : playback.stage === "waiting"
      ? `${playback.countdown} 秒后播放第 2 遍 · 点击停止`
      : playback.stage === "second"
        ? "正在播放第 2 遍 · 点击停止"
        : "播放两遍";

  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`dictation-card ${active ? "is-current" : ""} ${chars.length >= 5 ? "long-word" : ""} ${reviewing ? "revealed" : ""} ${hasWrong ? "has-wrong" : ""}`}
      data-item-index={index}
      onClick={onActivate}
    >
      <div className="card-meta">
        <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
        {item.mistakeReview && <span className="mistake-review-label">{mistakeReviewLabels[item.mistakeReview]}</span>}
        <span>{lessonSource}</span>
        {item.reasons.includes("课文取词") ? <span className="card-source-label">课文取词</span> : null}
        {reviewing ? <b>{hasWrong ? "有错字" : "待批改"}</b> : active ? <b className="current-item-badge">当前题</b> : null}
      </div>
      {!reviewing ? <div className="card-listen-actions">
        <button
          aria-pressed={isPlaybackActive}
          className={`listen-button ${playback.stage === "waiting" ? "waiting" : isPlaybackActive ? "speaking" : ""}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
            onTogglePlayback();
          }}
        >
          <Volume2 size={19} />{playbackLabel}
        </button>
        <button
          className="pinyin-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
            onShowPinyin();
          }}
          disabled={pinyinShown}
        >
          <Eye size={17} />{pinyinShown ? "拼音已显示" : "显示拼音"}
        </button>
      </div> : null}
      <TextbookHint text={maskedHint ?? item.word.textbookHint} />
      <div className="word-cells" aria-label={`第 ${index + 1} 题`}>
        {chars.map((char, charIndex) => {
          const isWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
          return (
            <div className={isWrong ? "word-cell wrong" : "word-cell"} key={`${char}-${charIndex}`}>
              {showPinyin && <span className="pinyin">{syllables[charIndex]}</span>}
              {reviewing ? (
                <button type="button" onClick={() => onToggleWrong(item.word.id, char)} aria-pressed={isWrong} aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}>
                  <strong>{char}</strong><small>{isWrong ? "写错了" : "点击标错"}</small>{isWrong ? <X size={17} /> : <Check size={17} />}
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
      {reviewing ? <WordIssueControls issue={issue} onToggle={onToggleIssue} /> : null}
    </article>
  );
}
