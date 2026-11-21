import { pinyin } from "pinyin-pro";

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const verifiedPhrases = {
  "二年级上册": {
    小蝌蚪找妈妈: { 龟: "乌龟", 捕: "捕食" },
    我是什么: { 坏: "坏事" },
    植物妈妈有办法: { 炸: "炸开" },
    语文园地一: { 针: "指南针" },
    拍手歌: { 歌: "拍手歌" },
    语文园地四: { 铺: "下铺", 硬: "硬卧", 卧: "硬卧", 限: "限乘", 乘: "限乘" },
    日月潭: { 绕: "环绕" },
    寒号鸟: { 哀: "哀号" },
    语文园地七: { 椰: "椰树" },
  },
  "二年级下册": {
    "雷锋叔叔，你在哪里": { 弯: "弯弯", 背: "背着", 乘: "乘着", 献: "献出" },
    中国美食: { 爆: "葱爆羊肉", 炖: "炖蘑菇" },
    彩色的梦: { 郁: "葱郁" },
    语文园地六: { 馆: "博物馆" },
    祖先的摇篮: { 摘: "摘野果", 逗: "逗小松鼠" },
  },
  "三年级上册": {
    语文园地三: { 乙: "乙方" },
    语文园地四: { 轴: "车轴", 佳: "佳节" },
    语文园地六: { 蛾: "飞蛾" },
    语文园地八: { 睁: "怒目圆睁" },
  },
  "三年级下册": {
    漏: { 贼: "一个贼", 驮: "驮着", 颠: "颠得" },
    火烧云: { 庙: "庙门", 揉: "揉一揉" },
    我不能失信: { 盼: "盼着" },
    肥皂泡: { 和: "和弄", 悬: "悬着心", 巍: "颤巍巍", 巅: "山巅" },
    语文园地三: { 贸: "农贸市场" },
    语文园地六: { 缆: "缆绳", 锚: "铁锚" },
    我们奇妙的世界: { 雕: "雕饰" },
  },
  "四年级上册": {
    观潮: { 墙: "水墙", 盐: "盐官镇", 吼: "风号浪吼" },
    现代诗二首: { 巢: "归巢", 罗: "剪秋罗" },
    一个豆荚里的五粒豆: { 探: "探出头", 脏: "脏水" },
    夜间飞行的秘密: { 荧: "荧光屏", 屏: "荧光屏", 蛾: "飞蛾" },
    语文园地六: { 萨: "拉萨", 昭: "大昭寺", 堰: "都江堰", 尼: "哈尼", 廊: "长廊" },
    女娲补天: { 拣: "拣来", 浆: "石浆", 颂: "传颂" },
    长城: { 砖: "方砖" },
    颐和园: { 佛: "佛香阁" },
    陀螺: { 帅: "帅气", 溃: "溃败" },
  },
};
const verifiedExercises = {
  "二年级上册": {
    语文园地五: {
      锋: "刀（　）", 蜂: "蜜（　）", 墓: "扫（　）",
      慕: "爱（　）", 炒: "（　）饭",
    },
  },
};
const pageContinuations = {
  "二年级上册": { 刘胡兰: [[17, 21]], 玲玲的画: [[29, 33]] },
  "二年级下册": { 画杨桃: [[23, 25]] },
  "三年级下册": { 枣核: [[31, 35]] },
  "四年级上册": { 田忌赛马: [[33, 37]] },
};
const pronunciationOverrides = { 哀号: "āi háo", 簸箕: "bò ji", 和弄: "huò nòng", 颤巍巍: "chàn wēi wēi", 颠得: "diān de" };

const hanChars = (text) => text.match(/\p{Script=Han}/gu) ?? [];
const completeSentence = /(?:[。！？]|……)[”’」』]?$/u;

const sourceExcerpts = (content, poems, rawTitle, pageBreaks) => {
  const excerpts = [];
  const poetryLines = new Set(poems.flatMap(({ title, lines }) => [title, ...lines.map(({ text }) => text)]));
  let inBody = false;
  let poetry = false;
  for (const [index, raw] of content.split("\n").entries()) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inBody) break;
      inBody = line === "## 课文原文或覆盖短句短语";
    }
    if (!inBody || !line) continue;
    if (line.startsWith("### ")) poetry = /古诗/u.test(line);
    if (poetry || poetryLines.has(line) || /^(?:#|来源｜|内容性质｜|\||\[)/u.test(line)) continue;
    for (const part of line.match(/[^。！？]+[。！？]+[”’」』]?|[^。！？]+$/gu) ?? []) {
      const text = part.trim().replace(/^◇\s*/u, "");
      excerpts.push({ text, rows: [index + 1], kind: completeSentence.test(text) ? "课文原句" : "教材片段" });
    }
  }

  const byRow = Map.groupBy(excerpts, (excerpt) => excerpt.rows[0]);
  const joined = [];
  const addContinuation = (first, rows) => {
    if (first?.kind !== "教材片段" || rows.some((row) => !byRow.has(row))) return;
    const rest = rows.slice(1).map((row) => byRow.get(row)[0]);
    if (rest.length && rest.at(-1).kind === "课文原句") {
      joined.push({ text: [first, ...rest].map(({ text }) => text).join(""), rows, kind: "课文原句" });
    }
  };
  for (const [row, parts] of byRow) {
    const last = parts.at(-1);
    if (!/[，；：]$/u.test(last.text)) continue;
    const rows = [row];
    for (let next = row + 1; byRow.has(next); next += 1) {
      const first = byRow.get(next)[0];
      rows.push(next);
      if (first.kind === "课文原句") {
        addContinuation(last, rows);
        break;
      }
      if (!/[，；：]$/u.test(first.text)) break;
    }
  }
  for (const rows of pageBreaks) {
    if (!byRow.has(rows[0])) throw new Error(`《${rawTitle}》无法核对原文续页：${rows.join("、")}`);
    const count = joined.length;
    addContinuation(byRow.get(rows[0]).at(-1), rows);
    if (joined.length === count) throw new Error(`《${rawTitle}》无法核对原文续页：${rows.join("、")}`);
  }
  return [...excerpts, ...joined, { text: rawTitle, rows: [1], kind: "教材篇名" }];
};

export const buildSupplementPrompts = ({ book, title, rawTitle, content, chars, words, poems }) => {
  const covered = new Set(words.flatMap(({ text }) => hanChars(text)));
  const uncovered = new Set(chars.map(({ char }) => char).filter((char) => !covered.has(char)));
  if (!uncovered.size) return [];
  const excerpts = sourceExcerpts(content, poems, rawTitle, pageContinuations[book]?.[title] ?? []);
  const verified = verifiedPhrases[book]?.[title] ?? {};
  const bestByChar = new Map();
  const add = (char, word, { text, rows, kind }, verifiedPhrase = false) => {
    if (word.includes("砌")) return;
    const masked = text.replaceAll(word, "〔　〕");
    const hint = hanChars(masked).length ? masked : null;
    if (word === char && !hint) return;
    const contextScore = kind === "课文原句" ? 30 : kind === "教材片段" ? 15 : 5;
    const rank = (verifiedPhrase ? 200 : word === char ? 0 : 100) + (hint ? contextScore : 0)
      - word.length - Math.min(text.length, 180) / 1000;
    if ((bestByChar.get(char)?.rank ?? -Infinity) >= rank) return;
    const start = hanChars(text.slice(0, text.indexOf(word))).length;
    const length = hanChars(word).length;
    const syllables = pronunciationOverrides[word] ?? pinyin(text, { type: "array", nonZh: "removed" }).slice(start, start + length).join(" ");
    if (!syllables || syllables.split(/\s+/u).length !== length) return;
    bestByChar.set(char, { char, word, pinyin: syllables, hint, source: text, rows, kind, rank });
  };
  for (const [char, word] of Object.entries(verified)) {
    if (!uncovered.has(char)) continue;
    const matches = excerpts.filter((item) => item.text.includes(word));
    if (!matches.length || !word.includes(char)) throw new Error(`${book}《${title}》无法核对课文用词：${word}`);
    for (const excerpt of matches) add(char, word, excerpt, true);
  }
  for (const [char, slot] of Object.entries(verifiedExercises[book]?.[title] ?? {})) {
    if (!uncovered.has(char)) continue;
    const source = excerpts.find((item) => item.text.includes(slot) && item.text.includes(char));
    if (!source) throw new Error(`${book}《${title}》无法核对教材选字练习：${char}`);
    const word = slot.replace("（　）", char);
    const pronunciation = pinyin(word);
    for (const target of new Set(word)) {
      if (!uncovered.has(target)) continue;
      bestByChar.set(target, { char: target, word, pinyin: pronunciation, hint: null, source: source.text, rows: source.rows, kind: "教材选字练习", rank: 250 });
    }
  }
  for (const excerpt of excerpts) {
    const listed = excerpt.kind === "教材片段" ? excerpt.text.split(/[、　]+/u) : [];
    for (const word of listed) {
      if (!/^\p{Script=Han}{2,4}$/u.test(word)) continue;
      for (const char of new Set(word)) if (uncovered.has(char)) add(char, word, excerpt);
    }
    for (const { segment } of segmenter.segment(excerpt.text)) {
      if (!/^\p{Script=Han}{2,4}$/u.test(segment)) continue;
      for (const char of new Set(segment)) if (uncovered.has(char)) add(char, segment, excerpt);
    }
    for (const char of new Set(hanChars(excerpt.text))) if (uncovered.has(char)) add(char, char, excerpt);
  }
  return [...bestByChar.values()];
};
