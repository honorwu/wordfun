import { hanLength } from "../../../shared/domain/characters.ts";
import type { DictationWord } from "../../../shared/types.ts";
import { createRoundTextMask } from "./hintMask.ts";

export const hanCharacterCount = hanLength;

export const maskLessonTitle = (title: string, words: readonly Pick<DictationWord, "text" | "pinyin">[]) =>
  createRoundTextMask(words)(title);
