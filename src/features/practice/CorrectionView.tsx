import { Check, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { hanChars, hanLength } from "../../../shared/domain/characters.ts";
import type { CorrectionItem } from "./types";
import { mistakeReviewLabels } from "./types";
import { TextbookHint } from "./TextbookHint";
import "./CorrectionView.css";

const maxCopyRepetitions = 3;

export function CorrectionView({ items, onFinish }: { items: CorrectionItem[]; onFinish: () => void }) {
  const [finishArmed, setFinishArmed] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const wrongCharTotal = new Set(items.flatMap((item) => item.wrongChars)).size;
  const allHidden = items.length > 0 && hiddenIds.size === items.length;

  useEffect(() => {
    if (!finishArmed) return;
    const timeout = window.setTimeout(() => setFinishArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [finishArmed]);

  const confirmFinish = () => {
    if (!finishArmed) {
      setFinishArmed(true);
      return;
    }
    setFinishArmed(false);
    onFinish();
  };

  const toggleHidden = (wordId: string) => {
    setHiddenIds((current) => {
      const next = new Set(current);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });
  };

  const toggleAllHidden = () => {
    setHiddenIds(allHidden ? new Set() : new Set(items.map((item) => item.wordId)));
  };

  return (
    <section className="student-main correction-view">
      <div className="correction-heading">
        <div>
          <p className="eyebrow">第 3 步 · 订正与复默</p>
          <h1>把写错的题看清、抄写再闭卷默 1 遍</h1>
          <p>先对照红字抄写 2～3 遍，再点击“遮住答案”不看屏幕默写 1 遍并核对。抄写封顶 3 遍，重点靠后期的间隔复测真正记住。</p>
          <div className="correction-heading-actions">
            <button className="secondary-button" type="button" onClick={toggleAllHidden}>
              {allHidden ? <><Eye size={16} />显示全部答案</> : <><EyeOff size={16} />全部遮住，闭卷默写检验</>}
            </button>
          </div>
        </div>
        <div className="correction-total"><strong>{items.length}</strong><span>道错题</span><small>共 {wrongCharTotal} 个错字</small></div>
      </div>

      <div className={`correction-grid ${items.length === 1 ? "single" : ""}`}>
        {items.map((item, index) => {
          const mistakeOrder = new Map(item.wrongChars.map((char, mistakeIndex) => [char, mistakeIndex + 1]));
          const isLongText = item.text.includes("\n") || hanLength(item.text) > 10;
          const isPoetry = item.wordId.startsWith("poem-");
          const label = isPoetry ? "整首" : "整词";
          const copyRepetitions = Math.min(maxCopyRepetitions, Math.max(2, item.mistakeCount + 1));
          const isHidden = hiddenIds.has(item.wordId);
          const charSlots = hanChars(item.text);

          return <article className={`correction-card ${isLongText ? "long-text" : ""} ${isHidden ? "is-recall-mode" : ""}`} key={item.wordId}>
            <div className="correction-card-heading">
              <span className="correction-number">{String(index + 1).padStart(2, "0")}</span>
              {item.mistakeReview && <span className="mistake-review-label">{mistakeReviewLabels[item.mistakeReview]}</span>}
              <span>{item.wrongChars.length > 1 ? `${item.wrongChars.length} 个错字` : "1 个错字"}</span>
              <button
                className="correction-mask-toggle"
                type="button"
                aria-pressed={isHidden}
                onClick={() => toggleHidden(item.wordId)}
              >
                {isHidden ? <><Eye size={14} />核对答案</> : <><EyeOff size={14} />遮住答案默 1 遍</>}
              </button>
            </div>
            <TextbookHint text={item.textbookHint} />
            <div className="correction-answer">
              <div className="correction-pinyin">
                <span>{isPoetry ? "题目与正文拼音" : "拼音"}</span>
                <p>{item.pinyin.trim() || "暂无拼音"}</p>
                {isPoetry ? <small>朝代、作者未标注拼音</small> : null}
              </div>
              {isHidden ? (
                <div className="correction-recall-box" aria-label="答案已遮住，请闭卷默写 1 遍">
                  {isPoetry ? (
                    <div className="correction-recall-lines" aria-hidden="true">
                      {item.text.split("\n").slice(0, 6).map((_, lineIndex) => <i key={lineIndex} />)}
                    </div>
                  ) : (
                    <div className="correction-recall-cells" aria-hidden="true">
                      {charSlots.map((_, cellIndex) => <span key={cellIndex} />)}
                    </div>
                  )}
                  <small>请不看答案在本子上默写 1 遍，写完点击“核对答案”</small>
                </div>
              ) : (
                <div className="correction-word" aria-label={`错题：${item.text}；错字：${item.wrongChars.join("、")}`}>
                  {Array.from(item.text).map((char, charIndex) => {
                    const order = mistakeOrder.get(char);
                    return <span className={order ? "wrong" : ""} key={`${char}-${charIndex}`}>{char}{order && item.wrongChars.length > 1 ? <sup aria-hidden="true">{order}</sup> : null}</span>;
                  })}
                </div>
              )}
            </div>
            <div className="correction-error-list">
              <div className="correction-error-detail">
                <div className="correction-requirement">
                  <b>{label}抄写 {copyRepetitions} 遍 + 闭卷默 1 遍</b>
                  <span>本题第 {item.mistakeCount} 次写错</span>
                </div>
                <div className="correction-writing-count" aria-label={`${label}抄写 ${copyRepetitions} 遍并闭卷默写 1 遍`}>
                  {Array.from({ length: copyRepetitions }, (_, repeatIndex) => <i key={repeatIndex}>{repeatIndex + 1}</i>)}
                  <i className="recall-pass" title="遮住答案闭卷默写 1 遍">默</i>
                </div>
              </div>
            </div>
          </article>;
        })}
      </div>

      <div className="correction-actions">
        <div>
          <strong>{finishArmed ? "确认要完成订正吗？" : "抄写并闭卷默写核对后再继续"}</strong>
          <span>{finishArmed ? "请再次点击橙色按钮，4 秒后自动取消" : "确认每道错题都已经不看答案默写正确"}</span>
        </div>
        <button className={`primary-button ${finishArmed ? "finish-confirm" : ""}`} type="button" onClick={confirmFinish}>
          <Check size={19} />{finishArmed ? "确认完成订正" : "我已完成订正"}
        </button>
      </div>
    </section>
  );
}
