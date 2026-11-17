import { Check, Eye, Volume2, X } from "lucide-react";
import type { PracticeItem, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import type { SpeechPlayback } from "./types";
import { charReviewKey, fullDictationCharsForWord, reviewCharsForWord } from "../../../shared/domain/index.ts";
import { WordIssueControls } from "../../components/WordIssues";

export function DictationCard({
  active,
  dictationLessonTitle,
  hintRevealed,
  index,
  item,
  onActivate,
  onRevealHint,
  onTogglePlayback,
  onToggleWrong,
  playback,
  protectedChars,
  reviewing,
  wrongCharKeys,
  issue,
  onToggleIssue,
}: {
  active: boolean;
  dictationLessonTitle: string;
  hintRevealed: boolean;
  index: number;
  item: PracticeItem;
  onActivate: () => void;
  onRevealHint: () => void;
  onTogglePlayback: () => void;
  onToggleWrong: (wordId: string, char: string) => void;
  playback: SpeechPlayback;
  protectedChars: ReadonlySet<string>;
  reviewing: boolean;
  wrongCharKeys: Set<string>;
  issue?: WordIssue;
  onToggleIssue: (kind: WordIssueKind) => void;
}) {
  const chars = Array.from(item.word.text).filter((char) => /\p{Script=Han}/u.test(char));
  const syllables = item.word.pinyin
    .split(/\s+/u)
    .map((syllable) => syllable.replace(/[，。！？；：、,.!?;:]/gu, ""))
    .filter(Boolean);
  const targets = new Set(reviewCharsForWord(item.word));
  const helpersVisible = reviewing || hintRevealed;
  const restrictReviewToTargets = hintRevealed;
  const fullReviewTargets = new Set(fullDictationCharsForWord(item.word));
  const reviewTargets = reviewing ? fullReviewTargets : restrictReviewToTargets ? targets : fullReviewTargets;
  const targetIndexes = new Set<number>();
  chars.forEach((char, index) => {
    if (targets.has(char)) targetIndexes.add(index);
  });
  const hasWrong = [...reviewTargets].some((char) => wrongCharKeys.has(charReviewKey(item.word.id, char)));
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
        <span>{reviewing ? item.word.lessonTitle : dictationLessonTitle}</span>
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
            <Eye size={17} />{hintRevealed ? "提示已显示" : "没听清？查看提示"}
        </button>
      </div> : null}
      <div className="word-cells" aria-label={`第 ${index + 1} 题`}>
        {chars.map((char, charIndex) => {
          const isCoreTarget = targetIndexes.has(charIndex);
          const isProtectedHelper = hintRevealed && !isCoreTarget && protectedChars.has(char);
          const isReviewTarget = reviewing || !restrictReviewToTargets || isCoreTarget;
          const isHelperChar = hintRevealed && !isCoreTarget;
          const displayAsTarget = !hintRevealed || isCoreTarget || isProtectedHelper;
          const isWrong = isReviewTarget && wrongCharKeys.has(charReviewKey(item.word.id, char));
          const showPinyin = reviewing || (hintRevealed && (isCoreTarget || isProtectedHelper));
          const cellHint = reviewing
            ? isWrong ? "写错了" : isHelperChar ? "提示字，也可标错" : "点击标错"
            : hintRevealed
              ? isCoreTarget ? "按拼音默写" : isProtectedHelper ? "本轮默写字" : "提示字"
              : "待默写";
          return (
            <div className={`word-cell ${displayAsTarget ? "target" : "helper"} ${isWrong ? "wrong" : ""}`} key={`${char}-${charIndex}`}>
              <span className={`pinyin ${showPinyin ? "answer-pinyin" : "dictation-pinyin-hidden"}`}>
                {showPinyin ? syllables[charIndex] ?? "" : ""}
              </span>
              {isReviewTarget && reviewing ? (
                <button type="button" onClick={() => onToggleWrong(item.word.id, char)} aria-pressed={isWrong} aria-label={`${isWrong ? "取消" : "标记"}错字：${char}`}>
                  <strong>{char}</strong><small>{isWrong ? "写错了" : "点击标错"}</small>{isWrong ? <X size={17} /> : <Check size={17} />}
                </button>
              ) : (
                <div className="character-box">
                  {helpersVisible && !isCoreTarget && !isProtectedHelper ? <strong>{char}</strong> : <span className="writing-line" />}
                </div>
              )}
              <em>{cellHint}</em>
            </div>
          );
        })}
      </div>
      {reviewing ? <WordIssueControls issue={issue} onToggle={onToggleIssue} /> : null}
    </article>
  );
}
