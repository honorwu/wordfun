import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pinyin } from "pinyin-pro";
import { buildSupplementPrompts } from "./supplement-prompts.mjs";

export const hanChars = (text) => Array.from(text).filter((char) => /\p{Script=Han}/u.test(char));
export const stableId = (prefix, ...parts) => `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;

const books = [
  [2, 1, "二年级上册", 229],
  [2, 2, "二年级下册", 297],
  [3, 1, "三年级上册", 272],
  [3, 2, "三年级下册", 271],
  [4, 1, "四年级上册", 220],
];
const unitNames = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const markdownCells = (line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
const phonetics = (text) => pinyin(text, { nonZh: "removed", v: false });
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const readAt = (root, relative) => readFileSync(path.join(root, relative), "utf8").replaceAll("\r\n", "\n");

const readEntries = (content) => {
  const sourceLines = content.split("\n");
  const heading = sourceLines.findIndex((line) => line.trim() === "## 词条数据");
  const header = sourceLines.findIndex((line, index) => index > heading && line.startsWith("|"));
  const table = heading >= 0 && header >= 0 ? sourceLines.slice(header) : [];
  requireValue(table?.length > 2, "未找到词条数据表");
  const headers = markdownCells(table[0]);
  requireValue(headers.includes("original_context_text") && headers.includes("hint_status"), "词条数据列不完整");
  const seen = new Set();
  return table.slice(2).filter(Boolean).map((line, index) => {
    const cells = markdownCells(line);
    requireValue(line.startsWith("|") && line.endsWith("|") && cells.length === headers.length, `词条数据第 ${index + 1} 行列数不对`);
    const entry = Object.fromEntries(headers.map((header, column) => [header, cells[column] || null]));
    const { entry_id, text, pinyin: pronunciation, hint_status, context_text, hint_text, context_type } = entry;
    requireValue(entry_id && !seen.has(entry_id), `词条 ID 缺失或重复：${entry_id}`);
    seen.add(entry_id);
    requireValue(text && pronunciation?.split(/\s+/u).length === hanChars(text).length, `词条拼音音节数不符：${entry_id}`);
    requireValue(hint_status === "ready"
      ? ["sentence", "textbook_sentence"].includes(context_type) && context_text?.includes(text) && hint_text === context_text.replaceAll(text, "〔　〕")
      : hint_status === "needs_hint" && !hint_text, `教材挖空提示不符：${entry_id}`);
    for (const field of ["grade", "term", "word_order", "wordlist_pdf_page"]) {
      requireValue(/^[1-9]\d*$/u.test(entry[field]), `词条 ${field} 无效：${entry_id}`);
      entry[field] = Number(entry[field]);
    }
    return { ...entry, sourceRow: header + index + 3 };
  });
};

const readList = (content, column, source) => {
  const line = content.match(new RegExp(`^## ${column}\\s*\\n\\s*([^\\n]+)`, "mu"))?.[1].trim();
  requireValue(line, `${source} 缺少${column}`);
  if (line.startsWith("收录情况｜")) return [];
  const items = line.split("、");
  requireValue(items.every((item) => /^\p{Script=Han}+$/u.test(item)), `${source} 无法解析${column}`);
  return items;
};

const readPoems = (content, title, garden) => {
  const body = content.split(/^## 写字表\s*$/mu)[0];
  const blocks = body.split(/^### /mu).slice(1).map((section) => section.split("\n").map((line) => line.trim()));
  const grouped = /^古诗[二三]首$/u.test(title);
  const poems = [];
  for (const [heading, ...lines] of blocks) {
    if (!grouped && !(garden && /日积月累/u.test(heading))) continue;
    let previous = "";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      const attribution = line.match(/^(?:\[(\p{Script=Han}+)\]\s*(\p{Script=Han}+)|(北朝民歌))$/u);
      if (attribution) {
        const poemTitle = previous;
        const poemLines = lines.slice(index + 1).map((value) => value.trimStart()).filter(Boolean);
        const boundary = poemLines.findIndex((value) => !/^[\p{Script=Han}，。？！、；：]+$/u.test(value) || !/[，。？！；]$/u.test(value));
        const text = boundary < 0 ? poemLines : poemLines.slice(0, boundary);
        requireValue(poemTitle && text.length, `${title} 的古诗缺少题目或正文`);
        poems.push({ title: poemTitle, titlePinyin: phonetics(poemTitle), dynasty: attribution[1] ?? attribution[3], author: attribution[2] ?? null,
          lines: text.map((value) => ({ text: value, pinyin: phonetics(value) })) });
      }
      previous = line;
    }
  }
  if (grouped) requireValue(poems.length === (title.includes("二") ? 2 : 3), `${title} 的古诗首数不符`);
  return poems;
};

export const readMaterials = (root) => {
  const wordSource = "默写词库-教材入库.md";
  const wordContent = readAt(root, wordSource);
  const entries = readEntries(wordContent);
  const entriesByFile = Map.groupBy(entries, (entry) => entry.lesson_file);
  const lessons = [];
  const sources = new Map([[wordSource, { content: wordContent, grade: null, term: null }]]);
  for (const [grade, term, book, expectedCount] of books) {
    const directory = `小学语文教材结构化/${book}`;
    requireValue(entries.filter((entry) => entry.grade === grade && entry.term === term).length === expectedCount, `${book} 的词条数不符`);
    for (const name of readdirSync(path.join(root, directory)).filter((file) => /^\d{3}-.+\.md$/u.test(file)).sort()) {
      const [, sequence] = name.match(/^(\d{3})-/u);
      const source = `${directory}/${name}`;
      const content = readAt(root, source);
      const metadata = new Map(content.split("\n").filter((line) => line.startsWith("|")).map(markdownCells));
      const rawTitle = content.match(/^# (.+)$/mu)?.[1].trim();
      const unit = metadata.get("单元");
      const unitIndex = unitNames.indexOf(unit?.match(/^第(.+)单元$/u)?.[1]);
      requireValue(rawTitle && unitIndex > 0 && metadata.get("年级学期") === book, `${source} 课次信息无效`);
      const title = rawTitle === "语文园地" ? `语文园地${unitNames[unitIndex]}` : rawTitle;
      const words = (entriesByFile.get(source) ?? []).sort((left, right) => left.word_order - right.word_order);
      const listedWords = readList(content, "词语表", source);
      requireValue(words.length === listedWords.length && words.every((entry, index) => entry.text === listedWords[index] && entry.word_order === index + 1
        && entry.grade === grade && entry.term === term && entry.unit === unit && entry.lesson_title === rawTitle
        && entry.lesson_key === `g${grade}-t${term}-tb${sequence}`), `${source} 与册末词条不一致`);
      entriesByFile.delete(source);
      const syllables = new Map();
      for (const word of words) {
        const parts = word.pinyin.split(/\s+/u);
        hanChars(word.text).forEach((char, index) => { if (!syllables.has(char)) syllables.set(char, parts[index]); });
      }
      for (const note of content.split("\n").filter((line) => line.startsWith("教材") || line.startsWith("表内"))) {
        if (!/多音字/u.test(note)) continue;
        for (const [, char, parenthesized, inline] of note.matchAll(/(\p{Script=Han})(?:（([a-z\u00c0-\u024f]+)）|\s+([a-z\u00c0-\u024f]+))/gu)) {
          syllables.set(char, parenthesized ?? inline);
        }
      }
      const chars = ["写字表", "识字表"].flatMap((column) => [...new Set(readList(content, column, source))]
        .map((char, index) => ({ char, column, pinyin: syllables.get(char) || phonetics(char), order: index + (column === "写字表" ? 0 : 500) })));
      const garden = title.startsWith("语文园地");
      const poems = readPoems(content, title, garden);
      const grouped = /^古诗[二三]首$/u.test(title);
      const lessonNumber = Number(metadata.get("篇目序号")?.match(/\d+/u)?.[0] ?? sequence);
      const id = stableId("textbook-lesson", grade, term, unit, title);
      sources.set(source, { content, grade, term });
      lessons.push({ id, grade, term, unit, unitIndex, title, source, chars, words,
        number: lessonNumber, sortOrder: Number(sequence), kind: grouped ? "classical_poetry" : garden ? "garden" : "regular",
        section: metadata.get("篇目类型"), poems: grouped ? poems : [],
        supplementPrompts: grouped ? [] : buildSupplementPrompts({ book, title, rawTitle, content, chars, words, poems }) });
      if (!grouped) {
        for (const [index, poem] of poems.entries()) {
          lessons.push({ id: stableId("textbook-poem", id, poem.title), grade, term, unit, unitIndex, title: poem.title, source,
            chars: [], words: [], number: lessonNumber + (index + 1) / 100,
            sortOrder: Number(sequence) + (index + 1) / 100, kind: "classical_poetry", section: "日积月累", poems: [poem] });
        }
      }
    }
  }
  requireValue(!entriesByFile.size, `未找到词条课次：${[...entriesByFile.keys()].join("、")}`);
  return { lessons, sources, wordSource };
};
