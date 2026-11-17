import type { DictationWord } from "../types.ts";

export const hanChars = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char));

export const uniqueChars = (chars: string[]) => Array.from(new Set(chars));

export const charReviewKey = (wordId: string, char: string) => `${wordId}\u0000${char}`;

export const reviewCharsForWord = (word: DictationWord) =>
  uniqueChars((word.chars.length > 0 ? word.chars : hanChars(word.text)).filter((char) => hanChars(word.text).includes(char)));

export const fullDictationCharsForWord = (word: DictationWord) => uniqueChars(hanChars(word.text));

export const hanLength = (value: string) => hanChars(value).length;
