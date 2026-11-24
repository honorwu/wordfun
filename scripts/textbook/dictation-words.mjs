import { hanChars } from "./materials.mjs";

const selectTextbookSupplement = (reviewed, generated) => {
  if (!reviewed) return generated;
  if (!generated || reviewed.replaces || reviewed.word !== reviewed.char) return reviewed;
  return generated.word !== generated.char || (reviewed.kind !== "课文原句" && generated.kind === "课文原句")
    ? generated : reviewed;
};

export const compileSupplementWords = (lesson, reviewedPrompts) => {
  const reviewed = new Map(reviewedPrompts.map((entry) => [entry.char, entry]));
  const generated = new Map(lesson.supplementPrompts.map((entry) => [entry.char, entry]));
  const covered = new Set(lesson.words.flatMap((entry) => hanChars(entry.text)));
  const ordered = [...lesson.chars].sort((left, right) => left.order - right.order || (left.char > right.char) - (left.char < right.char));
  const wordsByPrompt = new Map();
  for (const { char } of ordered) {
    if (covered.has(char)) continue;
    covered.add(char);
    const chosen = selectTextbookSupplement(reviewed.get(char), generated.get(char));
    if (!chosen || (chosen.word === char && !chosen.hint)) {
      throw new Error(`《${lesson.title}》的补充题缺少教材语境：${char}`);
    }
    const key = `${chosen.word}\u0000${chosen.pinyin}`;
    const existing = wordsByPrompt.get(key);
    if (!existing) {
      wordsByPrompt.set(key, { prompt: chosen, targets: [char] });
      continue;
    }
    existing.targets.push(char);
    if (!existing.prompt.hint && chosen.hint) existing.prompt = chosen;
  }
  return [...wordsByPrompt.values()];
};
