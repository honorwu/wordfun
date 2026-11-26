import { charReviewKey } from "../../../shared/domain/characters.ts";

export interface ReviewMarks {
  selectedKeys: ReadonlySet<string>;
  savedWrongKeys?: ReadonlySet<string>;
  onToggle?: (wordId: string, char: string) => void;
  disabled?: boolean;
}

export interface ReviewQuestionResult {
  editableChars?: ReadonlySet<string>;
  result?: string;
  unavailableLabel?: string;
}

export type CardReview = ReviewMarks & ReviewQuestionResult;

export function reviewMark(review: CardReview, wordId: string, char: string) {
  const key = charReviewKey(wordId, char);
  const saved = review.savedWrongKeys?.has(key) ?? false;
  const marked = review.selectedKeys.has(key);
  const pending = marked && Boolean(review.savedWrongKeys);
  const inRange = review.editableChars?.has(char) ?? true;
  const wrong = saved || marked;
  const label = saved ? "已记错"
    : pending ? "待补记"
    : wrong ? "写错了"
    : !inRange ? review.unavailableLabel ?? "未计分"
    : !review.onToggle ? "已计分"
    : review.savedWrongKeys ? "点击补记" : "点击标错";
  const action = saved || !inRange || !review.onToggle ? `${char}，${label}`
    : pending ? `取消补记错字：${char}`
    : review.savedWrongKeys ? `补记错字：${char}`
    : `${wrong ? "取消" : "标记"}错字：${char}`;
  return {
    wrong,
    pending,
    label,
    props: {
      disabled: !review.onToggle || review.disabled || saved || !inRange,
      "aria-pressed": wrong,
      "aria-label": action,
      onClick: () => review.onToggle?.(wordId, char),
    },
  };
}
