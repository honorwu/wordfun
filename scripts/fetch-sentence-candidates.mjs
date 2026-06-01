import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCompanionWords, getLessons, requireCatalogDatabase } from "../server/db.mjs";
import { sentenceHintForWord } from "../src/lib/sentenceHints.ts";

const sourceName = "zaojv.com";
const sourceBaseUrl = "https://zaojv.com";
const defaultOutPath = path.join("data", "sentence-candidates.json");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith("--")) {
    args.set(key, value && !value.startsWith("--") ? value : "true");
    if (value && !value.startsWith("--")) {
      index += 1;
    }
  }
}

const limit = Number(args.get("--limit") ?? 50);
const offset = Number(args.get("--offset") ?? 0);
const delayMs = Number(args.get("--delay-ms") ?? 450);
const outPath = args.get("--out") ?? defaultOutPath;
const includeExact = args.has("--all");
const force = args.has("--force");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeHtml = (value) =>
  value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

const normalizeSentence = (html) =>
  decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s*\d+\s*[,.、，.]\s*/, "")
    .replace(/【造句网[^】]*】/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/zaojv\s*\.?\s*com/gi, "")
    .replace(/\s+/g, "")
    .trim();

const hanLength = (text) => Array.from(text).filter((char) => /\p{Script=Han}/u.test(char)).length;

const blockedPatterns = [
  /打架|斗殴|贩毒|公安|法盲|抓获|蛀牙|交配|同性恋|血盆大口|杀|尸|死亡|仇恨|暴力/,
  /广告|短信|朋友，|幽默|笑话|反胃|目标是/,
  /[A-Za-z]{3,}/,
];

const scoreSentence = (word, sentence, section) => {
  let score = section === "student" ? 100 : 40;
  const length = hanLength(sentence);
  score -= Math.abs(length - 18);
  if (sentence.startsWith(word.text)) {
    score += 8;
  }
  if (/同学|老师|学校|教室|动物园|公园|妈妈|爸爸|孩子|小朋友/.test(sentence)) {
    score += 8;
  }
  if (/，/.test(sentence)) {
    score -= 2;
  }
  return score;
};

const isSuitableSentence = (word, sentence) => {
  if (!sentence.includes(word.text)) {
    return false;
  }
  const length = hanLength(sentence);
  if (length < Math.max(4, hanLength(word.text) + 2) || length > 34) {
    return false;
  }
  return !blockedPatterns.some((pattern) => pattern.test(sentence));
};

const extractSection = (html, id) => {
  const pattern = new RegExp(`<div id="${id}"[^>]*>([\\s\\S]*?)<\\/div><!--${id}\\u7ed3\\u675f-->`);
  return html.match(pattern)?.[1] ?? "";
};

const extractSentences = (word, html, responseUrl) => {
  const sections = [
    ["student", extractSection(html, "student")],
    ["all", extractSection(html, "all")],
  ];
  const candidates = [];
  const seen = new Set();

  for (const [section, sectionHtml] of sections) {
    for (const match of sectionHtml.matchAll(/<div>([\s\S]*?)<\/div>/g)) {
      const sentence = normalizeSentence(match[1]);
      if (!isSuitableSentence(word, sentence) || seen.has(sentence)) {
        continue;
      }
      seen.add(sentence);
      candidates.push({
        sentence,
        source: sourceName,
        url: responseUrl,
        section,
        score: scoreSentence(word, sentence, section),
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
};

const fetchCandidates = async (word) => {
  const body = new URLSearchParams({
    wo: word.text,
    directGo: "1",
    noToSimple: "1",
  });
  const response = await fetch(`${sourceBaseUrl}/wordQueryDo.php`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "Mozilla/5.0",
    },
    body,
  });
  const html = await response.text();
  return extractSentences(word, html, response.url);
};

const collectWords = () => {
  const catalogDb = requireCatalogDatabase();
  const lessons = getLessons(catalogDb);
  const companionWords = getCompanionWords(catalogDb);
  const byText = new Map();

  for (const lesson of lessons) {
    for (const word of lesson.words) {
      byText.set(word.text, word);
    }
  }

  for (const [char, words] of Object.entries(companionWords)) {
    for (const word of words) {
      if (!byText.has(word.text)) {
        byText.set(word.text, {
          ...word,
          id: `companion-${char}-${word.text}`,
          grade: 1,
          lessonId: "",
          lessonTitle: "配词",
          category: "二类",
        });
      }
    }
  }

  return [...byText.values()].sort((a, b) => a.text.localeCompare(b.text, "zh-Hans-CN"));
};

const readExisting = () => {
  try {
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    return new Map((parsed.words ?? []).map((item) => [item.text, item]));
  } catch {
    return new Map();
  }
};

const existing = readExisting();
const words = collectWords()
  .filter((word) => includeExact || sentenceHintForWord(word).source === "missing")
  .filter((word) => force || !existing.has(word.text))
  .slice(offset, offset + limit);

const fetchedAt = new Date().toISOString();
for (const [index, word] of words.entries()) {
  try {
    const candidates = await fetchCandidates(word);
    existing.set(word.text, {
      text: word.text,
      pinyin: word.pinyin,
      fetchedAt,
      candidates,
    });
    console.log(`${offset + index + 1}/${offset + words.length}: ${word.text} ${candidates.length}`);
  } catch (error) {
    existing.set(word.text, {
      text: word.text,
      pinyin: word.pinyin,
      fetchedAt,
      error: error instanceof Error ? error.message : String(error),
      candidates: [],
    });
    console.log(`${offset + index + 1}/${offset + words.length}: ${word.text} error`);
  }
  await sleep(delayMs);
}

const output = {
  generatedAt: new Date().toISOString(),
  source: sourceName,
  sourceUrl: sourceBaseUrl,
  note: "候选句只用于审核，不会自动进入默写卷。通过人工筛选后再复制到 src/lib/sentenceHints.ts。",
  words: [...existing.values()].sort((a, b) => a.text.localeCompare(b.text, "zh-Hans-CN")),
};

writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
