import { readFileSync } from "node:fs";
import { hanChars } from "./materials.mjs";

const approved = JSON.parse(readFileSync(new URL("./reviewed-prompts.json", import.meta.url), "utf8"));

export const resolveReviewedPrompts = (lessons, sources) => {
  const lessonsByFile = new Map(lessons.filter((lesson) => lesson.kind !== "classical_poetry").map((lesson) => [lesson.source, lesson]));
  const seen = new Set();
  return approved.map((entry) => {
    const { file, rows, char, word, pinyin, hint, kind, source } = entry;
    const lesson = lessonsByFile.get(file);
    const key = `${file}:${char}`;
    const sourceLines = sources.get(file)?.content.split("\n") ?? [];
    const excerpt = rows.map((row) => sourceLines[row - 1]?.trim() ?? "").join("");
    const matchesSource = kind === "教材选字练习"
      ? source.includes(word.replace(char, "（　）")) && source.includes(char) && hint === null
      : source.includes(word) && (hint === null || hint === source.replaceAll(word, "〔　〕"));
    if (!lesson?.chars.some((entry) => entry.char === char) || lesson.words.some((entry) => entry.text.includes(char))
      || seen.has(key) || !word.includes(char) || word.includes("砌") || hanChars(word).length !== pinyin.split(/\s+/u).length
      || !source || !excerpt.includes(source) || !matchesSource || (word === char && !hint?.includes("〔　〕"))) {
      throw new Error(`已审阅的补充题与教材不符：${key}`);
    }
    seen.add(key);
    return { ...entry, lessonId: lesson.id };
  });
};
