import { pinyin } from "pinyin-pro";
import { hanChars } from "../../shared/domain/characters.ts";

const blank = "〔　〕";
const syllablePattern = /^[\p{Script=Latin}\p{Mark}]+$/u;

export function createRoundTextMask(words) {
  const answerChars = new Set(words.flatMap(({ text }) => hanChars(text)));
  const phrases = words.flatMap((word) => {
    const parts = word.poem
      ? [{ text: word.poem.title, pinyin: word.poem.titlePinyin }, ...word.poem.lines]
      : [word];
    return parts.flatMap(({ text, pinyin: reading }) => {
      const letters = [...text.matchAll(/\p{Script=Han}/gu)];
      const syllables = reading.trim().split(/\s+/u);
      if (!letters.length || letters.length !== syllables.length || !syllables.every((syllable) => syllablePattern.test(syllable))) return [];
      const sounds = letters.map(({ index }, i) => ({ offset: index, syllable: syllables[i] }));
      return [{ text, sounds, lessonId: word.lessonId, id: word.id ?? text }];
    });
  });

  return (text, lessonId, blankAnswer = blank) => {
    if (!Array.from(text).some((char) => answerChars.has(char))) return text;

    // 完整题词沿用教材读音，重叠时先取长词，同形词优先取语境所在课。
    const matches = phrases.filter((phrase) => text.includes(phrase.text)).sort((a, b) =>
      b.sounds.length - a.sounds.length ||
      Number(b.lessonId === lessonId) - Number(a.lessonId === lessonId) || a.id.localeCompare(b.id));
    const exactReadings = new Map();
    for (const phrase of matches) {
      for (let start = text.indexOf(phrase.text); start >= 0; start = text.indexOf(phrase.text, start + 1)) {
        for (const { offset, syllable } of phrase.sounds) {
          if (!exactReadings.has(start + offset)) exactReadings.set(start + offset, syllable);
        }
      }
    }

    // 散落在别的词里的字按原句取音，例如“拳头”的“头”在“竖起头来”中读 tóu。
    // 只在取读音时填回题词，显示时保留原挖空、标点和空白。
    const readings = pinyin(text.replaceAll(blank, blankAnswer), { type: "array", nonZh: "spaced" });
    let contextIndex = 0;
    let offset = 0;
    return text.split(/(〔　〕|\p{Script=Han}+)/u).map((part) => {
      if (!part) return "";
      const chars = Array.from(part);
      if (!/^\p{Script=Han}/u.test(part)) {
        contextIndex += part === blank ? Array.from(blankAnswer).length : chars.length;
        offset += part.length;
        return part;
      }
      return chars.map((char) => {
        const contextual = readings[contextIndex++];
        const reading = exactReadings.get(offset) ?? (syllablePattern.test(contextual ?? "") ? contextual : "□");
        offset += char.length;
        return answerChars.has(char) ? ` ${reading} ` : char;
      }).join("").trim().replace(/ +/gu, " ");
    }).join("");
  };
}

export function maskedRoundHints(items, mask = createRoundTextMask(items.map(({ word }) => word))) {
  const hints = new Map();
  for (const { word } of items) {
    if (!word.textbookHint) continue;
    const shown = mask(word.textbookHint, word.lessonId, word.text);
    if (shown !== word.textbookHint) hints.set(word.id, shown);
  }
  return hints;
}

export function buildPracticeMasks(items, termLessons) {
  if (items.length === 0) {
    return { hints: {}, lessonTitles: {}, itemTitles: {} };
  }
  const mask = createRoundTextMask(items.map(({ word }) => word));
  const hints = Object.fromEntries(maskedRoundHints(items, mask));
  const lessonTitles = {};
  for (const entry of termLessons) {
    const masked = mask(entry.title, entry.id);
    if (masked !== entry.title) lessonTitles[entry.id] = masked;
  }
  const itemTitles = {};
  for (const { word } of items) {
    const masked = mask(word.lessonTitle, word.lessonId);
    if (masked !== word.lessonTitle) itemTitles[word.id] = masked;
  }
  return { hints, lessonTitles, itemTitles };
}
