import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { CorrectionItem } from "./types";
import { hanCharacterCount } from "./titleMask";

export function CorrectionView({ items, onFinish }: { items: CorrectionItem[]; onFinish: () => void }) {
  const [finishArmed, setFinishArmed] = useState(false);
  const wrongCharTotal = new Set(items.flatMap((item) => item.wrongChars.map((mistake) => mistake.char))).size;

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

  return (
    <section className="student-main correction-view">
      <div className="correction-heading">
        <div>
          <p className="eyebrow">第 3 步 · 订正</p>
          <h1>把写错的词认真订正好</h1>
          <p>先看完整词语，红色字是本次错字。第一次写错订正 2 遍，以后每错一次增加 1 遍。</p>
        </div>
        <div className="correction-total"><strong>{items.length}</strong><span>道错题</span><small>共 {wrongCharTotal} 个错字</small></div>
      </div>

      <div className={`correction-grid ${items.length === 1 ? "single" : ""}`}>
        {items.map((item, index) => {
          const mistakeOrder = new Map(item.wrongChars.map((mistake, mistakeIndex) => [mistake.char, mistakeIndex + 1]));
          const isLongText = item.text.includes("\n") || hanCharacterCount(item.text) > 10;
          const isPoetry = item.wordId.startsWith("poem-");
          const hasRepeatedWrongChar = isPoetry && item.wrongChars.some((mistake) => Array.from(item.text).filter((char) => char === mistake.char).length > 1);
          const instructions = isPoetry ? item.wrongChars.map(({ char, mistakeCount }) => ({ label: `红字「${char}」`, mistakeCount }))
            : [{ label: "整词", mistakeCount: item.mistakeCount }];
          return <article className={`correction-card ${isLongText ? "long-text" : ""}`} key={item.wordId}>
            <div className="correction-card-heading">
              <span className="correction-number">{String(index + 1).padStart(2, "0")}</span>
              <span>{item.wrongChars.length > 1 ? `${item.wrongChars.length} 个错字` : "1 个错字"}</span>
            </div>
            <div className="correction-answer">
              <div className="correction-pinyin">
                <span>{isPoetry ? "题目与正文拼音" : "拼音"}</span>
                <p>{item.pinyin.trim() || "暂无拼音"}</p>
                {isPoetry ? <small>朝代、作者未标注拼音</small> : null}
              </div>
              <div className="correction-word" aria-label={`错词：${item.text}；错字：${item.wrongChars.map((mistake) => mistake.char).join("、")}`}>
                {Array.from(item.text).map((char, charIndex) => {
                  const order = mistakeOrder.get(char);
                  return <span className={order ? "wrong" : ""} key={`${char}-${charIndex}`}>{char}{order && item.wrongChars.length > 1 ? <sup aria-hidden="true">{order}</sup> : null}</span>;
                })}
              </div>
            </div>
            {hasRepeatedWrongChar ? <p className="correction-duplicate-note">同一个红字在原文中出现多次，只需按下方要求订正一次。</p> : null}
            <div className="correction-error-list">
              {instructions.map(({ label, mistakeCount }) => {
                const repetitions = Math.max(2, mistakeCount + 1);
                return (
                  <div className="correction-error-detail" key={label}>
                    <div className="correction-requirement">
                      <b>{label}订正 {repetitions} 遍</b>
                      <span>这是第 {mistakeCount} 次写错</span>
                    </div>
                    <div className="correction-writing-count" aria-label={`${label}需要订正 ${repetitions} 遍`}>
                      {Array.from({ length: repetitions }, (_, repeatIndex) => <i key={repeatIndex}>{repeatIndex + 1}</i>)}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>;
        })}
      </div>

      <div className="correction-actions">
        <div>
          <strong>{finishArmed ? "确认要完成订正吗？" : "订正完成后再继续"}</strong>
          <span>{finishArmed ? "请再次点击橙色按钮，4 秒后自动取消" : "请确认每道题都按要求订正了相应遍数"}</span>
        </div>
        <button className={`primary-button ${finishArmed ? "finish-confirm" : ""}`} type="button" onClick={confirmFinish}>
          <Check size={19} />{finishArmed ? "确认完成订正" : "我已完成订正"}
        </button>
      </div>
    </section>
  );
}
