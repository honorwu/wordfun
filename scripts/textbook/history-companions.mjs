import { pinyin } from "pinyin-pro";

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const verifiedPhrases = {
  "二年级上册": { 日月潭: { 绕: "环绕" }, 寒号鸟: { 哀: "哀号" } },
  "三年级下册": {
    漏: { 贼: "一个贼", 驮: "驮着", 颠: "颠得" },
    火烧云: { 庙: "庙门", 揉: "揉一揉" },
    我不能失信: { 盼: "盼着" },
    肥皂泡: { 悬: "悬着心", 巍: "颤巍巍", 巅: "山巅" },
  },
  "四年级上册": {
    夜间飞行的秘密: { 荧: "荧光屏", 屏: "荧光屏" },
    女娲补天: { 拣: "拣来" },
  },
};
const pronunciationOverrides = { 哀号: "āi háo", 簸箕: "bò ji", 颤巍巍: "chàn wēi wēi", 颠得: "diān de" };

const sourceExcerpts = (content) => {
  const excerpts = [];
  let inBody = false;
  let poetry = false;
  for (const [index, raw] of content.split("\n").entries()) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inBody) break;
      inBody = line === "## 课文原文或覆盖短句短语";
    }
    if (!inBody || !line) continue;
    if (line.startsWith("### ")) poetry = /古诗|日积月累/u.test(line);
    if (poetry || /^(?:#|来源｜|内容性质｜|\||\[)/u.test(line)) continue;
    for (const excerpt of line.match(/[^。！？]+[。！？]+[”’」』]?|[^。！？]+$/gu) ?? []) {
      excerpts.push({ text: excerpt.trim(), row: index + 1 });
    }
  }
  return excerpts;
};

const hintFrom = (source, word) => {
  if (!/[。！？][”’」』]?$/u.test(source)) return null;
  if (source.length <= 62) return source.replaceAll(word, "〔　〕");
  const clause = source.split(/[，；]/u).find((part) => part.includes(word));
  return clause ? clause.replaceAll(word, "〔　〕") : null;
};

export const buildHistoryCompanions = ({ book, title, content, chars, words }) => {
  const covered = new Set(words.flatMap((word) => Array.from(word.text)));
  const uncovered = new Set(chars.map(({ char }) => char).filter((char) => !covered.has(char)));
  if (!uncovered.size) return [];
  const excerpts = sourceExcerpts(content);
  const verified = verifiedPhrases[book]?.[title] ?? {};
  const bestByChar = new Map();
  const add = (char, word, excerpt, verifiedPhrase = false) => {
    const syllables = pronunciationOverrides[word] ?? pinyin(word, { nonZh: "removed" });
    if (syllables.split(/\s+/u).length !== Array.from(word).length) return;
    const hint = hintFrom(excerpt.text, word);
    const rank = (verifiedPhrase ? 100 : 0) + (hint ? 10 : 0) - word.length;
    if ((bestByChar.get(char)?.rank ?? -Infinity) >= rank) return;
    bestByChar.set(char, { char, word, pinyin: syllables, hint, sourceRow: excerpt.row, rank });
  };
  for (const [char, word] of Object.entries(verified)) {
    if (!uncovered.has(char)) continue;
    const excerpt = excerpts.find((item) => item.text.includes(word));
    if (!excerpt || !word.includes(char)) throw new Error(`${book}《${title}》无法核对课文用词：${word}`);
    add(char, word, excerpt, true);
  }
  for (const excerpt of excerpts) {
    for (const { segment } of segmenter.segment(excerpt.text)) {
      if (!/^\p{Script=Han}{2,4}$/u.test(segment)) continue;
      for (const char of new Set(segment)) if (uncovered.has(char)) add(char, segment, excerpt);
    }
  }
  return [...bestByChar.values()];
};
