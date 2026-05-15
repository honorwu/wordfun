import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const textbookCacheDir = process.env.ZIQU_TEXTBOOK_CACHE_DIR || path.join(projectRoot, ".cache", "textbooks");
const outputDir = process.env.ZIQU_TEXTBOOK_CHAR_DIR || path.join(projectRoot, "textbook", "textbook-character-bank");
const maxGrade = Number(process.env.ZIQU_TEXTBOOK_MAX_GRADE || 6);
const contentsUrl =
  "https://api.github.com/repos/TapXWorld/ChinaTextbook/contents/%E5%B0%8F%E5%AD%A6/%E8%AF%AD%E6%96%87/%E7%BB%9F%E7%BC%96%E7%89%88?ref=master";

const gradeByName = new Map([
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
]);

const termByName = new Map([
  ["上", 1],
  ["下", 2],
]);

const chineseNumerals = new Map([
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["十", 10],
]);
const numberToChineseNumeral = new Map([...chineseNumerals.entries()].map(([key, value]) => [value, key]));

const classicalPoetryTitles = new Set(["江南", "画", "静夜思"]);
const classicalProseTitles = new Set([
  "司马光",
  "守株待兔",
  "精卫填海",
  "王戎不取道旁李",
  "古人谈读书",
  "少年中国说（节选）",
  "自相矛盾",
  "杨氏之子",
]);
const traditionalRhymeTitles = new Set(["对韵歌", "古对今", "人之初"]);

const romanPattern = /[A-Za-zāáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜüÜêńňǹḿ]/gu;
const hanPattern = /\p{Script=Han}/u;
const punctuationPattern = /[，。！？；：“”‘’、（）《》〈〉]/gu;
const hanWordPattern = /^[\p{Script=Han}]{2,8}$/u;

const termName = (term) => (term === 2 ? "下册" : "上册");
const bookFileName = (grade, term) => `${numberToChineseNumeral.get(grade)}年级${termName(term)}.md`;
const hanChars = (value) => Array.from(value).filter((char) => hanPattern.test(char));
const onlyHan = (value) => hanChars(value).join("");
const unique = (values) => [...new Set(values)];
const pad = (value, length = 2) => String(value).padStart(length, "0");
const usefulChinese = (line) => onlyHan(line).length > 0;
const isLessonNumber = (value) => Number.isInteger(value) && value >= 1 && value <= 40;

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { "user-agent": "ziqu-character-bank-extractor" } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const downloadFile = async (url, destination) => {
  if (existsSync(destination)) {
    return;
  }
  const response = await fetch(encodeURI(url), { headers: { "user-agent": "ziqu-character-bank-extractor" } });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
};

const parseBookInfo = (name) => {
  const match = name.match(/语文([一二三四五六])年级([上下])册\.pdf$/u);
  if (!match) {
    return null;
  }
  return { grade: gradeByName.get(match[1]), term: termByName.get(match[2]) };
};

const extractPdfPages = (pdfPath, extractionMode = "plain") => {
  const code = String.raw`
import json
import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
mode = sys.argv[2]
print(json.dumps([page.extract_text(extraction_mode=mode) or "" for page in reader.pages], ensure_ascii=False))
`;
  const result = spawnSync("python3", ["-c", code, pdfPath, extractionMode], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to extract ${pdfPath}`);
  }
  return JSON.parse(result.stdout);
};

const normalizeLine = (line) =>
  line
    .replace(romanPattern, "")
    .replace(/[\u2000-\u200f\u2028-\u202f\t]/gu, " ")
    .replace(/[^\p{Script=Han}0-9一二三四五六七八九十◎*·（）()《》“”：:，。！？；、. \-—]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const normalizeEntryLine = (line) =>
  line
    .replace(/^([.\s]*)(\d)\s+(\d)(\*?\s*[.、])/u, "$1$2$3")
    .replace(/^([.\s]*)(\d)\s+(\d)(\*?\s+)(?=[\p{Script=Han}])/u, "$1$2$3");

const appendixRegion = (pages, startPattern, endPattern) => {
  const appendixFloor = Math.max(0, Math.floor(pages.length * 0.65));
  const pageHasLine = (page, pattern) => page.split(/\r?\n/u).some((line) => pattern.test(normalizeLine(line)));
  const start = pages.findIndex((page, index) => index >= appendixFloor && pageHasLine(page, startPattern));
  if (start < 0) {
    return [];
  }
  const end = pages.findIndex((page, index) => index > start && pageHasLine(page, endPattern));
  return pages.slice(start, end > start ? end : pages.length);
};

const fallbackSectionOrder = new Map([
  ["识字", 100],
  ["汉语拼音", 200],
  ["课文", 300],
  ["语文园地", 900],
]);

const fallbackLessonSortOrder = (lesson) =>
  (fallbackSectionOrder.get(lesson.section) ?? 800) + Number(lesson.lessonNumber ?? lesson.number ?? lesson.gardenIndex ?? 0);

const makeLessonId = (grade, term, entry) => {
  if (entry.section === "语文园地") {
    return `g${grade}-t${term}-garden-${entry.gardenIndex}`;
  }
  return `g${grade}-t${term}-${entry.section}-${entry.number}`.replace(/[^\p{Script=Han}a-zA-Z0-9-]/gu, "");
};

const tocPageFromLine = (line) => {
  const match = line.match(/(?:\.|\s)(\d{1,3})[.\s]*$/u);
  return match ? Number(match[1]) : undefined;
};

const classifyLesson = (title, section) => {
  if (title.startsWith("语文园地")) {
    return "garden";
  }
  if (section === "汉语拼音") {
    return "pinyin";
  }
  if (title.includes("古诗") || title.includes("古诗词") || classicalPoetryTitles.has(title)) {
    return "classical_poetry";
  }
  if (title.includes("文言文") || classicalProseTitles.has(title)) {
    return "classical_prose";
  }
  if (traditionalRhymeTitles.has(title)) {
    return "traditional_rhyme";
  }
  return "regular";
};

const parseToc = (pages, grade, term, sourcePdf) => {
  const tocText = pages
    .slice(0, 8)
    .join("\n")
    .replace(/(^|\n)\.?\s*(\d)\s*\n\s*(\d\*?[.、]?\s+[\p{Script=Han}《》“”])/gu, "$1$2$3");
  const tocLines = [];
  const rawLines = tocText.split(/\r?\n/u);
  for (let index = 0; index < rawLines.length; index += 1) {
    let line = normalizeLine(rawLines[index]);
    if (!line) {
      continue;
    }
    let nextIndex = index + 1;
    while (nextIndex < rawLines.length && !normalizeLine(rawLines[nextIndex])) {
      nextIndex += 1;
    }
    const nextLine = normalizeLine(rawLines[nextIndex] ?? "");
    const sectionNumberMatch = line.match(/^(识字|课文|汉语拼音)\s+(\d{1,2}\*?)$/u);
    if (sectionNumberMatch && nextLine && usefulChinese(nextLine)) {
      tocLines.push(sectionNumberMatch[1]);
      tocLines.push(`${sectionNumberMatch[2]} ${nextLine}`);
      index = nextIndex;
      continue;
    }
    if (/^\d{1,2}\*?$/u.test(line) && nextLine && usefulChinese(nextLine)) {
      line = `${line} ${nextLine}`;
      index = nextIndex;
    } else if (
      usefulChinese(line) &&
      !/^(识字|课文|汉语拼音)$/u.test(line) &&
      !/\d{1,3}$/u.test(line) &&
      /^[.\s]*\d{1,3}$/u.test(nextLine)
    ) {
      line = `${line} ${nextLine.match(/\d{1,3}/u)?.[0] ?? ""}`;
      index = nextIndex;
    } else if (
      usefulChinese(line) &&
      /^[.\s]*\d{1,2}\*?\s*[.、]?\s*[\p{Script=Han}《》“”]/u.test(line) &&
      !/^(识字|课文|汉语拼音)$/u.test(line) &&
      !line.includes("单元") &&
      !/\d{1,3}[.\s]*$/u.test(line) &&
      usefulChinese(nextLine) &&
      /\d{1,3}[.\s]*$/u.test(nextLine)
    ) {
      line = `${line}${nextLine}`;
      index = nextIndex;
    }
    tocLines.push(line);
  }

  const lessons = new Map();
  let section = "课文";
  let gardenIndex = 0;
  let lastLessonNumber = 0;
  let sortOrder = 0;

  for (let tocLineIndex = 0; tocLineIndex < tocLines.length; tocLineIndex += 1) {
    const rawLine = tocLines[tocLineIndex];
    const line = rawLine.replace(/^(?:\d{1,3}\s+)+(?=\d{1,2}\*?[.、]?\s*[\p{Script=Han}《》“”])/u, "");
    if (!line || line === "目录") {
      continue;
    }
    if (/^识字$/u.test(line)) {
      section = "识字";
      continue;
    }
    if (/^课文$/u.test(line)) {
      section = "课文";
      continue;
    }
    if (/^汉语拼音$/u.test(line)) {
      section = "汉语拼音";
      continue;
    }

    if (section === "汉语拼音") {
      const compactMatch = line.match(/^(\d{1,2})\s+(\d{1,3})$/u);
      const splitMatch = line.match(/^(\d{1,2})$/u);
      let pinyinNumber = compactMatch ? Number(compactMatch[1]) : undefined;
      let tocPage = compactMatch ? Number(compactMatch[2]) : undefined;
      if (!pinyinNumber && splitMatch) {
        const nextLine = tocLines[tocLineIndex + 1]?.trim() ?? "";
        if (/^\d{1,3}$/u.test(nextLine)) {
          pinyinNumber = Number(splitMatch[1]);
          tocPage = Number(nextLine);
          tocLineIndex += 1;
        }
      }
      if (pinyinNumber && pinyinNumber <= 13 && tocPage) {
        const key = `${section}-${pinyinNumber}`;
        if (!lessons.has(key)) {
          const title = `汉语拼音${pinyinNumber}`;
          lessons.set(key, {
            id: makeLessonId(grade, term, { section, number: pinyinNumber }),
            grade,
            term,
            termName: termName(term),
            section,
            lessonNumber: pinyinNumber,
            sortOrder: sortOrder++,
            title,
            sourcePdf,
            tocPage,
            lessonKind: classifyLesson(title, section),
          });
        }
        lastLessonNumber = pinyinNumber;
        continue;
      }
    }

    if (line.includes("语文园地")) {
      gardenIndex += 1;
      const tocPage = tocPageFromLine(line);
      const explicit = line.match(/语文园地([一二三四五六七八九十])?/u)?.[1];
      const number = explicit ? chineseNumerals.get(explicit) ?? gardenIndex : gardenIndex;
      const title = explicit ? `语文园地${explicit}` : "语文园地";
      lessons.set(`语文园地-${number}`, {
        id: makeLessonId(grade, term, { section: "语文园地", gardenIndex: number }),
        grade,
        term,
        termName: termName(term),
        section: "语文园地",
        lessonNumber: lastLessonNumber + 0.5,
        sortOrder: sortOrder++,
        title,
        sourcePdf,
        tocPage,
        gardenIndex: number,
        lessonKind: classifyLesson(title, "语文园地"),
      });
      continue;
    }

    const lessonMatch = line.match(/^[.\s]*(\d{1,2})\*?\s*[.、]?\s*([\p{Script=Han}《》（）()“”·，、\s]+?)(?:\s*\.+|\s+\d{1,3}$|$)/u);
    if (!lessonMatch) {
      continue;
    }
    const number = Number(lessonMatch[1]);
    let title = lessonMatch[2].replace(/^文：/u, "").replace(/[《》]/gu, "").replace(/\s+/gu, "").trim();
    if (!title || ["写字表", "识字表", "词语表", "常用笔画名称表", "常用偏旁名称表"].some((name) => title.includes(name))) {
      continue;
    }
    if (title.length > 20 && /第[一二三四五六七八九十]+单元/u.test(title)) {
      continue;
    }
    const key = `${section}-${number}`;
    if (lessons.has(key)) {
      continue;
    }
    lessons.set(key, {
      id: makeLessonId(grade, term, { section, number }),
      grade,
      term,
      termName: termName(term),
      section,
      lessonNumber: number,
      sortOrder: sortOrder++,
      title,
      sourcePdf,
      tocPage: tocPageFromLine(line),
      lessonKind: classifyLesson(title, section),
    });
    lastLessonNumber = number;
  }

  return lessons;
};

const parseCharEntries = (pages, tableName, category) => {
  const entries = [];
  let section = "课文";
  let gardenIndex = 0;
  let current = null;
  let order = 0;

  const pushCurrent = () => {
    if (current && current.chars.length > 0) {
      current.chars = unique(current.chars);
      entries.push(current);
    }
  };

  const rawLines = pages.flatMap((rawPage) => rawPage.split(/\r?\n/u).map((rawLine) => normalizeEntryLine(normalizeLine(rawLine))));
  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index];
    const splitLessonNumber = line.match(/^(\d)$/u);
    const nextLine = rawLines[index + 1] ?? "";
    if (splitLessonNumber && /^\d\s*[\p{Script=Han}]/u.test(nextLine)) {
      line = normalizeEntryLine(`${splitLessonNumber[1]}${nextLine}`);
      index += 1;
    }
    const compactLine = line.replace(/\s+/gu, "");
    if (
      !line ||
      compactLine.includes(tableName) ||
      compactLine.includes("识字表") ||
      compactLine.includes("写字表") ||
      compactLine.includes("词语表") ||
      compactLine.includes("常用笔画名称表") ||
      compactLine.includes("常用偏旁名称表") ||
      line.includes("蓝色的字") ||
      line.includes("不计入") ||
      line.includes("共")
    ) {
      continue;
    }
    if (/^\d+$/u.test(line)) {
      const number = Number(line);
      if (!isLessonNumber(number)) {
        continue;
      }
      pushCurrent();
      current = {
        section,
        number,
        category,
        sourceTable: tableName,
        chars: [],
        orderBase: order++ * 1000,
      };
      continue;
    }
    if (/^识字$/u.test(line)) {
      pushCurrent();
      current = null;
      section = "识字";
      continue;
    }
    if (/^课文$/u.test(line)) {
      pushCurrent();
      current = null;
      section = "课文";
      continue;
    }
    if (/^汉语拼音$/u.test(line)) {
      pushCurrent();
      current = null;
      section = "汉语拼音";
      continue;
    }
    const gardenMatch = line.match(/^语文园地([一二三四五六七八九十])?/u);
    if (gardenMatch) {
      pushCurrent();
      const explicit = gardenMatch[1] ? chineseNumerals.get(gardenMatch[1]) : undefined;
      gardenIndex = explicit ?? gardenIndex + 1;
      current = {
        section: "语文园地",
        gardenIndex,
        category,
        sourceTable: tableName,
        chars: hanChars(line.replace(/^语文园地[一二三四五六七八九十]?/u, "")),
        orderBase: order++ * 1000,
      };
      continue;
    }
    const entryMatch = line.match(/^[.\s]*(\d{1,2})\s*[.、]?\s*(.*)$/u);
    if (entryMatch) {
      pushCurrent();
      current = {
        section,
        number: Number(entryMatch[1]),
        category,
        sourceTable: tableName,
        chars: hanChars(entryMatch[2]),
        orderBase: order++ * 1000,
      };
      continue;
    }
    if (current && usefulChinese(line)) {
      current.chars.push(...hanChars(line));
    }
  }
  pushCurrent();
  return entries;
};

const printedPageNumber = (pageText) => {
  const lines = pageText
    .split(/\r?\n/u)
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .reverse();
  for (const line of lines.slice(0, 5)) {
    if (/^\d{1,3}$/u.test(line)) {
      return Number(line);
    }
  }
  return undefined;
};

const printedPageMap = (pages) => {
  const map = new Map();
  for (const [index, page] of pages.entries()) {
    const printed = printedPageNumber(page);
    if (printed && !map.has(printed)) {
      map.set(printed, index);
    }
  }
  return map;
};

const pageHasLine = (page, pattern) => page.split(/\r?\n/u).some((line) => pattern.test(normalizeLine(line)));

const appendixStartIndex = (pages) => {
  const floor = Math.max(0, Math.floor(pages.length * 0.6));
  const index = pages.findIndex((page, pageIndex) => pageIndex >= floor && pageHasLine(page, /识\s*字\s*表|写\s*字\s*表/u));
  return index >= 0 ? index : pages.length;
};

const findPageByTitle = (pages, title, startAt = 5) => {
  const compactTitle = onlyHan(title);
  return pages.findIndex((page, index) => index >= startAt && onlyHan(page).includes(compactTitle));
};

const pageRangeForTocLesson = (pages, lessons, pageMap, lesson) => {
  const appendixStart = appendixStartIndex(pages);
  let startIndex = lesson.tocPage ? pageMap.get(lesson.tocPage) : undefined;
  if (startIndex === undefined) {
    startIndex = findPageByTitle(pages, gardenTitle(lesson));
  }
  if (startIndex === undefined || startIndex < 0) {
    return { startIndex: -1, endIndex: -1 };
  }
  const nextLesson = lessons.find((candidate) => candidate.tocPage && lesson.tocPage && candidate.tocPage > lesson.tocPage);
  let endIndex = nextLesson ? pageMap.get(nextLesson.tocPage) : undefined;
  if (endIndex === undefined && nextLesson) {
    endIndex = findPageByTitle(pages, gardenTitle(nextLesson), startIndex + 1);
  }
  if (endIndex === undefined || endIndex < 0 || endIndex <= startIndex) {
    endIndex = appendixStart;
  }
  return { startIndex, endIndex: Math.min(endIndex, appendixStart) };
};

const gardenContentScore = (content, chars) => {
  const target = chars.join("");
  const charHits = chars.filter((char) => content.includes(char)).length;
  const pairHits = chars.slice(0, -1).filter((char, index) => content.includes(`${char}${chars[index + 1]}`)).length;
  const fullHit = target.length > 1 && content.includes(target) ? 1 : 0;
  return {
    charHits,
    score: charHits * 10 + pairHits * 3 + fullHit * 50,
  };
};

const alignGardenEntriesToToc = (entries, lessons, pages, layoutPages) => {
  const gardenLessons = [...lessons.values()]
    .filter((lesson) => lesson.section === "语文园地" && lesson.tocPage)
    .sort((a, b) => (a.tocPage ?? 0) - (b.tocPage ?? 0) || (a.gardenIndex ?? 0) - (b.gardenIndex ?? 0));
  if (gardenLessons.length === 0) {
    return entries;
  }

  const pageMap = printedPageMap(pages);
  const gardenRanges = gardenLessons.map((lesson) => {
    const pageRange = pageRangeForTocLesson(pages, gardenLessons, pageMap, lesson);
    const plainSlice = pageRange.startIndex >= 0 ? pages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    const layoutSlice = pageRange.startIndex >= 0 ? layoutPages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    return {
      lesson,
      content: onlyHan([...plainSlice, ...layoutSlice].join("\n")),
    };
  });

  return entries.map((entry) => {
    if (entry.section !== "语文园地") {
      return entry;
    }
    let best = null;
    for (const range of gardenRanges) {
      const scored = gardenContentScore(range.content, entry.chars);
      if (!best || scored.score > best.score) {
        best = { ...scored, lesson: range.lesson };
      }
    }
    const minHits = entry.chars.length <= 2 ? entry.chars.length : Math.max(2, Math.ceil(entry.chars.length * 0.6));
    if (best && best.charHits >= minHits) {
      return { ...entry, gardenIndex: best.lesson.gardenIndex };
    }
    return entry;
  });
};

const normalizeAppendixEntry = (grade, term, entry) => {
  if (grade === 1 && term === 1 && entry.section === "识字" && entry.number > 10) {
    return { ...entry, section: "汉语拼音" };
  }
  return entry;
};

const ensureLesson = (lessons, grade, term, sourcePdf, rawEntry) => {
  const entry = normalizeAppendixEntry(grade, term, rawEntry);
  const key = entry.section === "语文园地" ? `语文园地-${entry.gardenIndex}` : `${entry.section}-${entry.number}`;
  const existing = lessons.get(key);
  if (existing) {
    return existing;
  }
  const alternateSection = entry.section === "课文" ? "识字" : "";
  const alternateKey = alternateSection && entry.number ? `${alternateSection}-${entry.number}` : "";
  const alternate = alternateKey ? lessons.get(alternateKey) : undefined;
  if (alternate && !alternate.title.startsWith(alternateSection)) {
    lessons.delete(alternateKey);
    alternate.section = entry.section;
    alternate.id = makeLessonId(grade, term, entry);
    lessons.set(key, alternate);
    return alternate;
  }
  const title = entry.section === "语文园地" ? `语文园地${entry.gardenIndex}` : `${entry.section}${entry.number}`;
  const lesson = {
    id: makeLessonId(grade, term, entry),
    grade,
    term,
    termName: termName(term),
    section: entry.section,
    lessonNumber: entry.section === "语文园地" ? entry.gardenIndex + 0.5 : entry.number,
    sortOrder: fallbackLessonSortOrder(entry),
    title,
    sourcePdf,
    tocPage: undefined,
    lessonKind: classifyLesson(title, entry.section),
  };
  lessons.set(key, lesson);
  return lesson;
};

const charRowsForRecord = (rows) =>
  rows.map((row) => ({
    char: row.char,
    source_table: row.sourceTable,
    order: row.charOrder,
  }));

const charsOnly = (rows) => rows.map((row) => row.char).join("");
const wordRowsForRecord = (rows) =>
  rows.map((row) => ({
    text: row.text,
    source_table: row.sourceTable,
    order: row.wordOrder,
  }));
const wordsOnly = (rows) => rows.map((row) => row.text).join("、");
const markdownPath = (value) => value.split(path.sep).map(encodeURIComponent).join("/");

const gardenTitle = (lesson) => {
  if (lesson.section !== "语文园地") {
    return lesson.title;
  }
  const index = lesson.gardenIndex ?? lesson.garden_index;
  if (lesson.title !== "语文园地" || !index) {
    return lesson.title;
  }
  return `语文园地${numberToChineseNumeral.get(Number(index)) ?? index}`;
};

const lessonLabel = (lesson) =>
  lesson.section === "语文园地" ? gardenTitle(lesson) : `第${Math.floor(lesson.lessonNumber ?? lesson.lesson_number)}课 ${lesson.title}`;

const cleanWordToken = (token) => onlyHan(token.replace(/[^\p{Script=Han}]/gu, ""));

const wordSegments = (text) =>
  text
    .replace(punctuationPattern, ".")
    .split(/[.。]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

const tokensFromWordSegment = (segment) => {
  const tokens = segment
    .split(/\s+/u)
    .map(cleanWordToken)
    .filter(Boolean);
  if (tokens.length > 1 && tokens.some((token) => token.length === 1)) {
    const joined = tokens.join("");
    if (hanWordPattern.test(joined)) {
      return [joined];
    }
  }
  return tokens;
};

const parseTextbookWords = (pages) => {
  const entries = [];
  let section = "课文";
  let currentNumber = null;
  let wordOrder = 0;
  let pendingSingle = "";

  const pushWord = (word) => {
    if (hanWordPattern.test(word)) {
      entries.push({ section, number: currentNumber, text: word, wordOrder: wordOrder++ });
    }
  };

  const flushPending = () => {
    if (pendingSingle.length >= 2) {
      pushWord(pendingSingle);
    }
    pendingSingle = "";
  };

  const pushToken = (token) => {
    if (!currentNumber) {
      pendingSingle = "";
      return;
    }
    if (token.length === 1) {
      pendingSingle += token;
      if (pendingSingle.length >= 2) {
        flushPending();
      }
      return;
    }
    flushPending();
    pushWord(token);
  };

  const rawLines = pages.flatMap((rawPage) => rawPage.split(/\r?\n/u).map((rawLine) => normalizeEntryLine(normalizeLine(rawLine))));
  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index];
    const splitLessonNumber = line.match(/^(\d)$/u);
    const nextLine = rawLines[index + 1] ?? "";
    if (splitLessonNumber && /^\d\s*[\p{Script=Han}]/u.test(nextLine)) {
      line = normalizeEntryLine(`${splitLessonNumber[1]}${nextLine}`);
      index += 1;
    }
    if (/后\s*记|义务教育教科书|编写人员|责任编辑|封面设计|出版发行|印刷者|电子邮箱/u.test(line)) {
      break;
    }
    if (!line || line.includes("词语表") || line.includes("后记")) {
      continue;
    }
    if (/^识字$/u.test(line)) {
      flushPending();
      section = "识字";
      currentNumber = null;
      continue;
    }
    if (/^课文$/u.test(line)) {
      flushPending();
      section = "课文";
      currentNumber = null;
      continue;
    }
    if (/^\d+$/u.test(line)) {
      const number = Number(line);
      if (isLessonNumber(number)) {
        flushPending();
        currentNumber = number;
      }
      continue;
    }
    const entryMatch = line.match(/^[.\s]*(\d{1,2})\s*[.、]?\s*(.*)$/u);
    const text = entryMatch ? entryMatch[2] : line;
    if (entryMatch) {
      flushPending();
      currentNumber = Number(entryMatch[1]);
    }
    if (!currentNumber) {
      continue;
    }
    for (const segment of wordSegments(text)) {
      for (const token of tokensFromWordSegment(segment)) {
        pushToken(token);
      }
    }
  }
  flushPending();

  return entries;
};

const buildBookCharacterBank = async (item) => {
  const { grade, term } = item.book;
  const pdfPath = path.join(textbookCacheDir, item.name);
  await downloadFile(item.download_url, pdfPath);
  const pages = extractPdfPages(pdfPath);
  const layoutPages = extractPdfPages(pdfPath, "layout");
  const lessons = parseToc(pages, grade, term, item.name);

  const recognitionPages = appendixRegion(pages, /识\s*字\s*表/u, /写\s*字\s*表/u);
  const writingPages = appendixRegion(pages, /写\s*字\s*表/u, /词\s*语\s*表|常用笔画名称表|常用偏旁名称表|后\s*记/u);
  const wordPages = appendixRegion(layoutPages, /词\s*语\s*表/u, /后\s*记/u);
  const entries = alignGardenEntriesToToc(
    [...parseCharEntries(recognitionPages, "识字表", "二类"), ...parseCharEntries(writingPages, "写字表", "一类")],
    lessons,
    pages,
    layoutPages,
  );

  const charRows = [];
  for (const entry of entries) {
    const normalizedEntry = normalizeAppendixEntry(grade, term, entry);
    const lesson = ensureLesson(lessons, grade, term, item.name, normalizedEntry);
    normalizedEntry.chars.forEach((char, index) => {
      charRows.push({
        lessonId: lesson.id,
        char,
        category: normalizedEntry.category,
        charOrder: normalizedEntry.orderBase + index,
        sourceTable: normalizedEntry.sourceTable,
      });
    });
  }

  const wordRows = [];
  for (const word of parseTextbookWords(wordPages)) {
    const lesson = ensureLesson(lessons, grade, term, item.name, word);
    wordRows.push({
      lessonId: lesson.id,
      text: word.text,
      wordOrder: word.wordOrder,
      sourceTable: "词语表",
    });
  }

  const orderedLessons = [...lessons.values()]
    .filter((lesson) => charRows.some((row) => row.lessonId === lesson.id) || wordRows.some((row) => row.lessonId === lesson.id))
    .sort(
      (a, b) =>
        (a.tocPage ?? Number.POSITIVE_INFINITY) - (b.tocPage ?? Number.POSITIVE_INFINITY) ||
        a.grade - b.grade ||
        a.term - b.term ||
        Number(a.sortOrder ?? fallbackLessonSortOrder(a)) - Number(b.sortOrder ?? fallbackLessonSortOrder(b)) ||
        a.title.localeCompare(b.title, "zh-CN"),
    )
    .map((lesson, index) => ({ ...lesson, outputOrder: index }));

  const lessonRecords = orderedLessons.map((lesson) => {
    const recognitionChars = charRows
      .filter((row) => row.lessonId === lesson.id && row.category === "二类")
      .sort((a, b) => a.charOrder - b.charOrder);
    const writingChars = charRows
      .filter((row) => row.lessonId === lesson.id && row.category === "一类")
      .sort((a, b) => a.charOrder - b.charOrder);
    const wordTable = wordRows.filter((row) => row.lessonId === lesson.id).sort((a, b) => a.wordOrder - b.wordOrder);
    return {
      id: lesson.id,
      grade: lesson.grade,
      term: lesson.term,
      term_name: lesson.termName,
      section: lesson.section,
      garden_index: lesson.gardenIndex ?? "",
      lesson_number: lesson.lessonNumber,
      sort_order: lesson.outputOrder,
      title: gardenTitle(lesson),
      lesson_kind: lesson.lessonKind,
      source_pdf: lesson.sourcePdf,
      recognition_chars: charRowsForRecord(recognitionChars),
      writing_chars: charRowsForRecord(writingChars),
      word_table: wordRowsForRecord(wordTable),
      recognition_text: charsOnly(recognitionChars),
      writing_text: charsOnly(writingChars),
      word_text: wordsOnly(wordTable),
    };
  });

  const bookMarkdown = [
    `# ${grade}年级${termName(term)}课本字词表`,
    "",
    `- PDF：${item.name}`,
    `- 条目：${lessonRecords.length}`,
    `- 二类字：${lessonRecords.reduce((sum, lesson) => sum + lesson.recognition_chars.length, 0)}`,
    `- 一类字：${lessonRecords.reduce((sum, lesson) => sum + lesson.writing_chars.length, 0)}`,
    `- 词语：${lessonRecords.reduce((sum, lesson) => sum + lesson.word_table.length, 0)}`,
    "",
    "| 序 | 板块 | 课题 | 类型 | 认字（识字表） | 写字（写字表） | 词语（词语表） |",
    "|---:|---|---|---|---|---|---|",
    ...lessonRecords.map((lesson, index) => {
      const label = lesson.section === "语文园地" ? lesson.title : `第${Math.floor(lesson.lesson_number)}课 ${lesson.title}`;
      return `| ${index + 1} | ${lesson.section} | ${label} | ${lesson.lesson_kind} | ${lesson.recognition_text || "（无）"} | ${lesson.writing_text || "（无）"} | ${lesson.word_text || "（无）"} |`;
    }),
    "",
  ].join("\n");
  const termFile = bookFileName(grade, term);
  writeFileSync(path.join(outputDir, termFile), bookMarkdown);

  return { grade, term, termName: termName(term), pdf: item.name, termFile, lessons: lessonRecords };
};

const writeRootFiles = (summaries) => {
  const allLessons = summaries.flatMap((book) => book.lessons);
  const rootReadme = [
    "# 统编版小学语文生字字库",
    "",
    "本目录由 `npm run extract:chars` 从课本 PDF 的附录抽取生成：认字来自 `识字表`，写字来自 `写字表`，词语来自 `词语表`。脚本不再解析课文正文。",
    "",
    "| 年级 | 册别 | PDF | 条目 | 二类字 | 一类字 | 词语 | 学期文档 |",
    "|---:|---|---|---:|---:|---:|---:|---|",
    ...summaries.map((book) => {
      const recognitionCount = book.lessons.reduce((sum, lesson) => sum + lesson.recognition_chars.length, 0);
      const writingCount = book.lessons.reduce((sum, lesson) => sum + lesson.writing_chars.length, 0);
      const wordCount = book.lessons.reduce((sum, lesson) => sum + lesson.word_table.length, 0);
      return `| ${book.grade} | ${book.termName} | ${book.pdf} | ${book.lessons.length} | ${recognitionCount} | ${writingCount} | ${wordCount} | [打开](${markdownPath(book.termFile)}) |`;
    }),
    "",
    "## 使用原则",
    "",
    "- `recognition_chars` 来自课本附录 `识字表`，即二类字。",
    "- `writing_chars` 来自课本附录 `写字表`，即一类字。",
    "- `word_table` 来自课本附录 `词语表`。",
    "- 本目录只保留 Markdown 文档，人工校对和后续建库都以每学期 Markdown 为准。",
    "- 后续组词、默写词可以基于这个字库，再参考 `../baidu_lesson/` 或人工校对词库。",
    "",
  ].join("\n");
  writeFileSync(path.join(outputDir, "说明.md"), rootReadme);

  const anomalies = allLessons.filter((lesson) => lesson.recognition_chars.length === 0 && lesson.writing_chars.length === 0);
  const duplicateWithinLesson = [];
  for (const lesson of allLessons) {
    const seen = new Set();
    const duplicates = [];
    for (const row of [...lesson.recognition_chars, ...lesson.writing_chars]) {
      const key = `${row.char}-${row.source_table}`;
      if (seen.has(key)) {
        duplicates.push(row.char);
      }
      seen.add(key);
    }
    if (duplicates.length > 0) {
      duplicateWithinLesson.push({ lesson, duplicates: unique(duplicates) });
    }
  }

  const report = [
    "# 生字字库抽取报告",
    "",
    `- 册数：${summaries.length}`,
    `- 字库条目：${allLessons.length}`,
    `- 二类字总数：${allLessons.reduce((sum, lesson) => sum + lesson.recognition_chars.length, 0)}`,
    `- 一类字总数：${allLessons.reduce((sum, lesson) => sum + lesson.writing_chars.length, 0)}`,
    `- 词语总数：${allLessons.reduce((sum, lesson) => sum + lesson.word_table.length, 0)}`,
    `- 空条目：${anomalies.length}`,
    `- 单课同表重复字：${duplicateWithinLesson.length}`,
    "",
    "## 各册统计",
    "",
    "| 年级 | 册别 | 条目 | 二类字 | 一类字 | 词语 |",
    "|---:|---|---:|---:|---:|---:|",
    ...summaries.map((book) => {
      const recognitionCount = book.lessons.reduce((sum, lesson) => sum + lesson.recognition_chars.length, 0);
      const writingCount = book.lessons.reduce((sum, lesson) => sum + lesson.writing_chars.length, 0);
      const wordCount = book.lessons.reduce((sum, lesson) => sum + lesson.word_table.length, 0);
      return `| ${book.grade} | ${book.termName} | ${book.lessons.length} | ${recognitionCount} | ${writingCount} | ${wordCount} |`;
    }),
    "",
    "## 空条目",
    "",
    anomalies.length > 0
      ? anomalies.map((lesson) => `- ${lesson.grade}年级${lesson.term_name} ${lessonLabel(lesson)}`).join("\n")
      : "（无）",
    "",
  ].join("\n");
  writeFileSync(path.join(outputDir, "抽取报告.md"), report);
};

const main = async () => {
  mkdirSync(textbookCacheDir, { recursive: true });
  rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(outputDir, { recursive: true });

  const contents = await fetchJson(contentsUrl);
  const books = contents
    .map((item) => ({ ...item, book: parseBookInfo(item.name) }))
    .filter((item) => item.book && item.book.grade <= maxGrade)
    .sort((a, b) => a.book.grade - b.book.grade || a.book.term - b.book.term);

  const summaries = [];
  for (const book of books) {
    console.log(`Extracting characters from ${book.name}`);
    summaries.push(await buildBookCharacterBank(book));
  }
  writeRootFiles(summaries);

  const summary = {
    outputDir,
    books: summaries.length,
    lessons: summaries.reduce((sum, book) => sum + book.lessons.length, 0),
    recognitionChars: summaries.reduce((sum, book) => sum + book.lessons.reduce((bookSum, lesson) => bookSum + lesson.recognition_chars.length, 0), 0),
    writingChars: summaries.reduce((sum, book) => sum + book.lessons.reduce((bookSum, lesson) => bookSum + lesson.writing_chars.length, 0), 0),
    words: summaries.reduce((sum, book) => sum + book.lessons.reduce((bookSum, lesson) => bookSum + lesson.word_table.length, 0), 0),
  };
  console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
