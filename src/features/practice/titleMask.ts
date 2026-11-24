import type { DictationWord } from "../../../shared/types.ts";

type TitleMaskWord = Pick<DictationWord, "text" | "pinyin">;

export const hanCharacterCount = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char)).length;

const pinyinSyllables = (pinyin: string) => pinyin
  .split(/\s+/u)
  .map((syllable) => syllable.replace(/[^\p{Letter}]/gu, ""))
  .filter(Boolean);

const pinyinForSubstring = (word: TitleMaskWord, substring: string) => {
  const startIndex = word.text.indexOf(substring);
  if (startIndex < 0) return "";
  const syllables = pinyinSyllables(word.pinyin);
  const startSyllable = hanCharacterCount(word.text.slice(0, startIndex));
  return syllables.slice(startSyllable, startSyllable + hanCharacterCount(substring)).join(" ");
};

export const maskLessonTitle = (title: string, words: readonly TitleMaskWord[]) => {
  const replacements = new Map<string, string>();
  for (const word of words) {
    const text = word.text.trim();
    const pinyin = word.pinyin.trim();
    if (!text || !pinyin) continue;
    if (title.includes(text)) {
      replacements.set(text, pinyin);
      continue;
    }
    if (text.includes(title)) {
      const titlePinyin = pinyinForSubstring(word, title);
      if (titlePinyin) replacements.set(title, titlePinyin);
    }
  }

  let maskedTitle = title;
  for (const [text, pinyin] of [...replacements].sort((left, right) => right[0].length - left[0].length)) {
    maskedTitle = maskedTitle.split(text).join(` ${pinyin} `);
  }

  const pinyinByCharacter = new Map<string, string>();
  for (const word of words) {
    const chars = Array.from(word.text).filter((char) => /\p{Script=Han}/u.test(char));
    const syllables = pinyinSyllables(word.pinyin);
    chars.forEach((char, index) => {
      const syllable = syllables[index];
      if (syllable && !pinyinByCharacter.has(char)) pinyinByCharacter.set(char, syllable);
    });
  }
  maskedTitle = Array.from(maskedTitle)
    .map((char) => pinyinByCharacter.has(char) ? ` ${pinyinByCharacter.get(char)} ` : char)
    .join("");

  return maskedTitle.replace(/\s+/gu, " ").trim();
};
