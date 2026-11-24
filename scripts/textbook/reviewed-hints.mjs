import { readFileSync } from "node:fs";

const approved = JSON.parse(readFileSync(new URL("./reviewed-hints.json", import.meta.url), "utf8"));
const hintKey = (file, word) => `${file}\u0000${word}`;

export const resolveReviewedHints = (sources) => {
  const hints = new Map();
  for (const [file, groups] of Object.entries(approved)) {
    const lines = sources.get(file)?.content.split("\n") ?? [];
    for (const { rows, source, sentences } of groups) {
      const excerpt = rows.map((row) => lines[row - 1]?.trim() ?? "").join("");
      if (!source || !excerpt.includes(source)) {
        throw new Error(`已审阅的语境来源与教材不符：${file}:${rows.join("、")}`);
      }
      for (const [word, sentence] of Object.entries(sentences)) {
        const key = hintKey(file, word);
        const hint = sentence.replaceAll(word, "〔　〕");
        if (hints.has(key) || !sentence.includes(word) || !/\p{Script=Han}/u.test(hint)) {
          throw new Error(`已审阅的挖空语境无效：${file} · ${word}`);
        }
        hints.set(key, {
          hint,
          source: { kind: sentence === source ? "教材原文" : "据教材编写", file, rows, excerpt: source },
        });
      }
    }
  }
  return {
    forQuestion(file, word, hint, details) {
      const key = hintKey(file, word);
      const reviewed = hints.get(key);
      if (!reviewed) return [hint, JSON.stringify(details)];
      hints.delete(key);
      return [reviewed.hint, JSON.stringify({ ...details, hint_source: reviewed.source })];
    },
    assertAllUsed() {
      if (hints.size > 0) {
        throw new Error(`已审阅的语境找不到对应原题：${[...hints.keys()].map((key) => key.replace("\u0000", " · ")).join("、")}`);
      }
    },
  };
};
