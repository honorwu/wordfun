import { Check, Eye, Volume2, X } from "lucide-react";
import { Fragment } from "react";
import type { PracticeItem, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import type { SpeechPlayback } from "./types";
import { charReviewKey, fullDictationCharsForWord, reviewCharsForWord } from "../../../shared/domain/index.ts";
import { WordIssueControls } from "../../components/WordIssues";

export function DictationCard({
  active,
  lessonSource,
  hintRevealed,
  index,
  item,
  onActivate,
  onRevealHint,
  onTogglePlayback,
  onToggleWrong,
  playback,
  protectedChars,
  maskedSentence,
  reviewing,
  wholeWord,
  wrongCharKeys,
  issue,
  onToggleIssue,
}: {
  active: boolean;
  lessonSource: string;
  hintRevealed: boolean;
  index: number;
  item: PracticeItem;
  onActivate: () => void;
  onRevealHint: () => void;
  onTogglePlayback: () => void;
  onToggleWrong: (wordId: string, char: string) => void;
  playback: SpeechPlayback;
  protectedChars: ReadonlySet<string>;
  maskedSentence?: string;
  reviewing: boolean;
  wholeWord: boolean;
  wrongCharKeys: Set<string>;
  issue?: WordIssue;
  onToggleIssue: (kind: WordIssueKind) => void;
}) {
  const chars = Array.from(item.word.text).filter((char) => /\p{Script=Han}/u.test(char));
  const syllables = item.word.pinyin
    .split(/\s+/u)
    .map((syllable) => syllable.replace(/[，。！？；：、,.!?;:]/gu, ""))
    .filter(Boolean);
  const fullWordChars = fullDictationCharsForWord(item.word);
  const targets = new Set(wholeWord ? fullWordChars : reviewCharsForWord(item.word));
  const hasWrong = fullWordChars.some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
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
          className={hintRevealed ? "hint-button revealed" : "hint-button"}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
            onRevealHint();
          }}
          disabled={hintRevealed}
        >
            <Eye size={17} />{hintRevealed ? "提示已显示" : "查看拼音提示"}
        </button>
      </div> : null}
      {!reviewing && maskedSentence ? (
        <p className="textbook-hint">
          <strong className="textbook-hint-label">教材提示</strong>
          {maskedSentence.split("〔　〕").map((part, partIndex) => (
            <Fragment key={partIndex}>
              {partIndex > 0 ? <strong className="textbook-hint-blank">（　）</strong> : null}
              {part}
            </Fragment>
          ))}
        </p>
      ) : null}
      <div className="word-cells" aria-label={`第 ${index + 1} 题`}>
        {chars.map((char, charIndex) => {
          const isCoreTarget = targets.has(char);
          const isProtectedHelper = hintRevealed && !isCoreTarget && protectedChars.has(char);
          const displayAsTarget = !hintRevealed || isCoreTarget || isProtectedHelper;
          const isWrong = wrongCharKeys.has(charReviewKey(item.word.id, char));
          const showPinyin = reviewing || (hintRevealed && (isCoreTarget || isProtectedHelper));
          const cellHint = !hintRevealed ? null
            : reviewing ? !isWrong && !isCoreTarget ? "提示字，也可标错" : null
              : isCoreTarget ? "按拼音默写" : isProtectedHelper ? "本轮默写字" : "提示字";
          return (
            <div className={`word-cell ${displayAsTarget ? "target" : "helper"} ${isWrong ? "wrong" : ""}`} key={`${char}-${charIndex}`}>
              <span className={`pinyin ${showPinyin ? "answer-pinyin" : "dictation-pinyin-hidden"}`}>
                {showPinyin ? syllables[charIndex] ?? "" : ""}
              </span>
              {reviewing ? (
                <button type="button" onClick={() => onToggleWrong(item.word.id, char)} aria-pressed={isWrong} aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}>
                  <strong>{char}</strong><small>{isWrong ? "写错了" : "点击标错"}</small>{isWrong ? <X size={17} /> : <Check size={17} />}
                </button>
              ) : (
                <div className="character-box">
                  {hintRevealed && !isCoreTarget && !isProtectedHelper ? <strong>{char}</strong> : <span className="writing-line" />}
                </div>
              )}
              {cellHint && <em>{cellHint}</em>}
            </div>
          );
        })}
      </div>
      {reviewing ? <WordIssueControls issue={issue} onToggle={onToggleIssue} /> : null}
    </article>
  );
}
