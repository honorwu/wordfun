import type { PracticeItem } from "../../../shared/types.ts";

export function maskedRoundHints(items: readonly PracticeItem[]): Map<string, string> {
  const answers = items.map(({ word }) => ({
    word,
    chars: Array.from(word.text),
    syllables: word.pinyin.trim().split(/\s+/u),
  })).filter(({ chars }) => chars.length > 0);
  const hints = new Map<string, string>();
  for (const { word } of items) {
    const hint = word.textbookHint;
    if (!hint) continue;

    // 较长词的读音优先。同形词在不同课可能读音不同，优先用语境所在课的题词。
    const preferred = answers.filter(({ word: answer }) => hint.includes(answer.text)).sort((a, b) =>
      b.chars.length - a.chars.length ||
      Number(b.word.lessonId === word.lessonId) - Number(a.word.lessonId === word.lessonId) ||
      a.word.id.localeCompare(b.word.id));
    if (!preferred.length) continue;

    const readings = new Map<number, string>();
    for (const { word: answer, chars, syllables } of preferred) {
      for (let start = hint.indexOf(answer.text); start !== -1; start = hint.indexOf(answer.text, start + 1)) {
        let offset = start;
        for (const [index, char] of chars.entries()) {
          if (!readings.has(offset)) readings.set(offset, syllables[index]);
          offset += char.length;
        }
      }
    }

    // 只在连续汉字内分隔拼音，原有的标点、空白和本题的挖空原样保留。
    hints.set(word.id, hint.replace(/\p{Script=Han}+/gu, (run, start: number) => {
      let offset = start;
      return Array.from(run, (char) => {
        const syllable = readings.get(offset);
        offset += char.length;
        return syllable ? ` ${syllable} ` : char;
      }).join("").trim().replace(/ +/gu, " ");
    }));
  }
  return hints;
}
