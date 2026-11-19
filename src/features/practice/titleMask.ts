import type { DictationWord } from "../../../shared/types.ts";

type TitleMaskWord = Pick<DictationWord, "text" | "pinyin">;

export const hanCharacterCount = (value: string) => Array.from(value).filter((char) => /\p{Script=Han}/u.test(char)).length;

const pinyinSyllables = (pinyin: string) => pinyin
  .split(/\s+/u)
  .map((syllable) => syllable.replace(/[^\p{Letter}]/gu, ""))
  .filter(Boolean);

export const createTextbookHintMask = (words: readonly TitleMaskWord[], protectedChars: ReadonlySet<string>) => {
  const pronunciations = new Map<string, Set<string>>();
  const phrases = new Map<string, Array<{ chars: string[]; syllables: string[] }>>();
  for (const word of words) {
    const chars = Array.from(word.text);
    const syllables = pinyinSyllables(word.pinyin);
    if (!chars.length || hanCharacterCount(word.text) !== chars.length || syllables.length !== chars.length) continue;
    chars.forEach((char, index) => {
      const readings = pronunciations.get(char) ?? new Set<string>();
      readings.add(syllables[index]);
      pronunciations.set(char, readings);
    });
    if (chars.length > 1) {
      const candidates = phrases.get(chars[0]) ?? [];
      candidates.push({ chars, syllables });
      phrases.set(chars[0], candidates);
    }
  }
  for (const candidates of phrases.values()) candidates.sort((left, right) => right.chars.length - left.chars.length);

  const displayChar = (char: string, syllable?: string) => {
    if (!protectedChars.has(char)) return char;
    const readings = pronunciations.get(char);
    const reading = syllable ?? (readings?.size === 1 ? [...readings][0] : undefined);
    return reading ? ` ${reading} ` : "…";
  };
  return (hint: string) => {
    const chars = Array.from(hint);
    let masked = "";
    for (let index = 0; index < chars.length;) {
      const phrase = phrases.get(chars[index])?.find((candidate) =>
        candidate.chars.every((char, offset) => char === chars[index + offset]),
      );
      if (phrase) {
        masked += phrase.chars.map((char, offset) => displayChar(char, phrase.syllables[offset])).join("");
        index += phrase.chars.length;
      } else {
        masked += displayChar(chars[index]);
        index += 1;
      }
    }
    return masked.replace(/ +/gu, " ").replace(/ +([，。？！、；：])/gu, "$1").trim();
  };
};

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
