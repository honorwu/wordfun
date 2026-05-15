import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const textbookCacheDir = process.env.ZIQU_TEXTBOOK_CACHE_DIR || path.join(projectRoot, ".cache", "textbooks");
const outputDir = process.env.ZIQU_GARDEN_DIR || path.join(projectRoot, "textbook", "garden");

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

const romanPattern = /[A-Za-zāáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜüÜêńňǹḿ]/gu;
const romanCharPattern = /[A-Za-zāáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜüÜêńňǹḿ]/u;
const hanPattern = /\p{Script=Han}/u;
const pageHeadingPattern =
  /^(语文园地[一二三四五六七八九十]?|识字加油站|字词句运用|词句段运用|书写提示|日积月累|展示台|我的发现|交流平台|快乐读书吧|和大人一起读|写话|口语交际|习作)$/u;
const instructionPattern =
  /^(读一读|认一认|记一记|连一连|查一查|写一写|说一说|背一背|照样子|选一选|比一比|找一找|猜一猜|试着|用加点|体会|看看|下面|你会|和同学|小组)/u;

const termName = (term) => (term === 2 ? "下册" : "上册");
const hanChars = (value) => Array.from(value).filter((char) => hanPattern.test(char));
const onlyHan = (value) => hanChars(value).join("");
const unique = (values) => [...new Set(values)];
const usefulChinese = (line) => onlyHan(line).length > 0;
const isLessonNumber = (value) => Number.isInteger(value) && value >= 1 && value <= 40;
const markdownPath = (value) => value.split(path.sep).map(encodeURIComponent).join("/");
const gardenTitle = (gardenIndex) => `语文园地${numberToChineseNumeral.get(Number(gardenIndex)) ?? gardenIndex}`;

const verifiedGardenDictation = new Map([
  ["1-2-4", ["眉毛", "鼻子", "嘴巴", "脖子", "手臂", "肚子", "小腿", "脚尖"]],
  ["1-2-6", ["冰棍", "绿豆汤", "蒲扇", "竹椅", "萤火虫", "牵牛", "织女", "北斗"]],
  ["1-2-8", ["卫生间", "牙刷", "刷牙", "毛巾", "擦手", "梳子", "梳头", "香皂", "洗澡", "脸盆"]],
  ["2-2-3", ["甜津津", "酸溜溜", "辣乎乎", "香喷喷", "油腻腻", "软绵绵", "脆生生", "硬邦邦"]],
  ["3-1-4", ["车轴", "基础", "阁楼", "佳节", "盲人", "唐朝"]],
  ["3-1-5", ["蝌蚪", "飞蛾", "鲤鱼", "鲫鱼", "鲨鱼"]],
]);

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

const extractPdfTextItems = (pdfPath) => {
  const code = String.raw`
import json
import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
pages = []
for page in reader.pages:
    items = []
    def visitor(text, cm, tm, font_dict, font_size):
        if text and text.strip():
            items.append({"x": tm[4], "y": tm[5], "text": text})
    page.extract_text(visitor_text=visitor)
    pages.append(items)
print(json.dumps(pages, ensure_ascii=False))
`;
  const result = spawnSync("python3", ["-c", code, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to extract positioned text from ${pdfPath}`);
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

const tocPageFromLine = (line) => {
  const match = line.match(/(?:\.|\s)(\d{1,3})[.\s]*$/u);
  return match ? Number(match[1]) : undefined;
};

const parseTocLines = (pages) => {
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
      !/^(识字|课文|汉语拼音)$/u.test(line) &&
      !/\d{1,3}[.\s]*$/u.test(line) &&
      usefulChinese(nextLine) &&
      /\d{1,3}[.\s]*$/u.test(nextLine)
    ) {
      line = `${line}${nextLine}`;
      index = nextIndex;
    }
    tocLines.push(line);
  }

  return tocLines;
};

const parseTocItems = (pages, grade, term) => {
  const tocLines = parseTocLines(pages);
  const items = [];
  let section = "课文";
  let gardenIndex = 0;
  let order = 0;

  for (let index = 0; index < tocLines.length; index += 1) {
    const rawLine = tocLines[index];
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

    const tocPage = tocPageFromLine(line);
    if (!tocPage) {
      continue;
    }

    if (line.includes("语文园地")) {
      const explicit = line.match(/语文园地([一二三四五六七八九十])?/u)?.[1];
      gardenIndex = explicit ? chineseNumerals.get(explicit) ?? gardenIndex + 1 : gardenIndex + 1;
      items.push({
        type: "garden",
        grade,
        term,
        section: "语文园地",
        title: gardenTitle(gardenIndex),
        gardenIndex,
        tocPage,
        order: order++,
      });
      continue;
    }

    const lessonMatch = line.match(/^[.\s]*(\d{1,2})\*?\s*[.、]?\s*(.*?)(?:\s*\.+|\s+\d{1,3}$|$)/u);
    if (lessonMatch) {
      const number = Number(lessonMatch[1]);
      const title = lessonMatch[2].replace(/[《》]/gu, "").replace(/\s+/gu, "").trim();
      if (title && !["写字表", "识字表", "词语表", "常用笔画名称表", "常用偏旁名称表"].some((name) => title.includes(name))) {
        items.push({ type: "lesson", grade, term, section, title, number, tocPage, order: order++ });
      }
      continue;
    }

    const title = line
      .replace(/^◎\s*/u, "")
      .replace(/(?:\.|\s)\d{1,3}[.\s]*$/u, "")
      .replace(/\.+/gu, "")
      .replace(/\s+/gu, "")
      .trim();
    if (title && usefulChinese(title)) {
      items.push({ type: "other", grade, term, section, title, tocPage, order: order++ });
    }
  }

  return items.sort((a, b) => a.tocPage - b.tocPage || a.order - b.order);
};

const pageHasLine = (page, pattern) => page.split(/\r?\n/u).some((line) => pattern.test(normalizeLine(line)));

const appendixStartIndex = (pages) => {
  const floor = Math.max(0, Math.floor(pages.length * 0.6));
  const index = pages.findIndex((page, pageIndex) => pageIndex >= floor && pageHasLine(page, /识\s*字\s*表|写\s*字\s*表/u));
  return index >= 0 ? index : pages.length;
};

const appendixRegion = (pages, startPattern, endPattern) => {
  const floor = Math.max(0, Math.floor(pages.length * 0.65));
  const start = pages.findIndex((page, index) => index >= floor && pageHasLine(page, startPattern));
  if (start < 0) {
    return [];
  }
  const end = pages.findIndex((page, index) => index > start && pageHasLine(page, endPattern));
  return pages.slice(start, end > start ? end : pages.length);
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
      current = { section, number, category, sourceTable: tableName, chars: [], orderBase: order++ * 1000 };
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
      current = { section, number: Number(entryMatch[1]), category, sourceTable: tableName, chars: hanChars(entryMatch[2]), orderBase: order++ * 1000 };
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

const normalizeContentLine = (line) =>
  line
    .replace(romanPattern, "")
    .replace(/[\u2000-\u200f\u2028-\u202f\t]/gu, " ")
    .replace(/[0-9]{1,3}/gu, " ")
    .replace(/[◎*·•]+/gu, " ")
    .replace(/[^\p{Script=Han}，。！？；：“”‘’、（）()《》〈〉 \-—]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const cleanToken = (value) => onlyHan(value).trim();
const estimatedHanWidth = 16;

const shouldSkipLine = (line) => {
  const compact = onlyHan(line);
  if (!compact) {
    return true;
  }
  if (pageHeadingPattern.test(compact)) {
    return true;
  }
  return instructionPattern.test(compact);
};

const positionedTokensFromItem = (item, sourceId) => {
  const tokens = [];
  let cursor = 0;
  let token = "";
  let tokenStart = 0;
  const hasDash = /[—-]/u.test(item.text);

  const pushToken = () => {
    const cleaned = cleanToken(token);
    if (cleaned) {
      tokens.push({ text: cleaned, x: Number(item.x) + tokenStart, sourceId, hasDash });
    }
    token = "";
  };

  for (const char of item.text) {
    if (hanPattern.test(char)) {
      if (!token) {
        tokenStart = cursor;
      }
      token += char;
      cursor += estimatedHanWidth;
      continue;
    }
    pushToken();
    if (/\t/u.test(char)) {
      cursor += 24;
    } else if (/[\u2003\u3000]/u.test(char)) {
      cursor += 40;
    } else if (/\s/u.test(char)) {
      cursor += 12;
    } else if (romanCharPattern.test(char)) {
      cursor += 0;
    } else {
      cursor += 10;
    }
  }
  pushToken();

  return tokens;
};

const positionedLines = (pageItems) => {
  const lines = [];
  const sorted = pageItems
    .filter((item) => cleanToken(item.text))
    .sort((a, b) => Number(b.y) - Number(a.y) || Number(a.x) - Number(b.x));

  for (const [sourceId, item] of sorted.entries()) {
    let line = lines.find((candidate) => Math.abs(candidate.y - Number(item.y)) <= 3);
    if (!line) {
      line = { y: Number(item.y), tokens: [] };
      lines.push(line);
    }
    line.tokens.push(...positionedTokensFromItem(item, sourceId));
  }

  return lines
    .map((line) => ({
      ...line,
      tokens: line.tokens.sort((a, b) => a.x - b.x),
    }))
    .filter((line) => line.tokens.length > 0);
};

const contentCandidatesFromLine = (line) => {
  if (shouldSkipLine(line)) {
    return [];
  }
  const candidates = [];
  for (const segment of line.split(/[，。！？；：“”‘’、（）()《》〈〉]+/u)) {
    const trimmed = segment.trim();
    if (!trimmed || shouldSkipLine(trimmed)) {
      continue;
    }
    if (/[—-]/u.test(trimmed)) {
      continue;
    }
    const tokens = trimmed.split(/\s+/u).map(cleanToken).filter(Boolean);
    if (tokens.length > 1 && tokens.every((token) => token.length === 1)) {
      const joined = tokens.join("");
      if (joined.length >= 2 && joined.length <= 12) {
        candidates.push(joined);
      }
      continue;
    }
    const tokenCandidates = tokens.filter((token) => token.length >= 2 && token.length <= 16);
    if (tokenCandidates.length > 0) {
      candidates.push(...tokenCandidates);
      continue;
    }
    const compact = cleanToken(trimmed);
    if (compact.length >= 2 && compact.length <= 40) {
      candidates.push(compact);
    }
  }
  return candidates;
};

const layoutPairCandidatesFromLine = (line, targetSet) => {
  if (shouldSkipLine(line)) {
    return [];
  }
  const candidates = [];
  for (const segment of line.split(/[，。！？；：“”‘’、（）()《》〈〉]+/u)) {
    const trimmed = segment.trim();
    if (!trimmed || shouldSkipLine(trimmed) || /[—-]/u.test(trimmed)) {
      continue;
    }
    const tokens = trimmed.split(/\s+/u).map(cleanToken).filter(Boolean);
    let run = [];
    const flushRun = () => {
      if (run.length >= 2) {
        const targetHits = run.filter((token) => targetSet.has(token)).length;
        if (!(run.length >= 4 && targetHits / run.length >= 0.8)) {
          for (let index = 0; index < run.length - 1; index += 2) {
            candidates.push(`${run[index]}${run[index + 1]}`);
          }
        }
      }
      run = [];
    };
    for (const token of tokens) {
      if (token.length === 1) {
        run.push(token);
      } else {
        flushRun();
      }
    }
    flushRun();
  }
  return candidates;
};

const contentCandidatesFromPositionedLine = (line, targetSet) => {
  const lineText = line.tokens.map((token) => token.text).join(" ");
  if (shouldSkipLine(lineText)) {
    return [];
  }
  const lineChars = line.tokens.flatMap((token) => hanChars(token.text));
  const targetHits = lineChars.filter((char) => targetSet.has(char)).length;
  if (line.tokens.length >= 4 && line.tokens.every((token) => token.text.length === 1) && targetHits / lineChars.length >= 0.8) {
    return [];
  }

  const candidates = [];
  for (const token of line.tokens) {
    if (token.text.length >= 2 && token.text.length <= 16 && !shouldSkipLine(token.text)) {
      candidates.push({ text: token.text, source: "positioned-direct" });
    }
  }

  for (let index = 0; index < line.tokens.length - 1; index += 1) {
    const current = line.tokens[index];
    const next = line.tokens[index + 1];
    if (current.hasDash || next.hasDash) {
      continue;
    }
    const combined = `${current.text}${next.text}`;
    if (combined.length > 4) {
      continue;
    }
    const gap = next.x - (current.x + estimatedHanWidth);
    const currentTarget = current.text.length === 1 && targetSet.has(current.text);
    const nextTarget = next.text.length === 1 && targetSet.has(next.text);
    const bothTarget = currentTarget && nextTarget;
    const maxGap = bothTarget && current.sourceId !== next.sourceId ? 6 : 34;
    if (gap >= -4 && gap <= maxGap) {
      candidates.push({ text: combined, source: "positioned-adjacent" });
    }
  }

  return candidates;
};

const expandedCandidates = (candidate, targetSet) => {
  const chars = hanChars(candidate);
  if (chars.length >= 4 && chars.length <= 12 && chars.length % 2 === 0) {
    const pairs = [];
    for (let index = 0; index < chars.length; index += 2) {
      pairs.push(chars.slice(index, index + 2).join(""));
    }
    const repeatedSuffix = pairs.length >= 2 && pairs.every((pair) => pair[1] === pairs[0][1]);
    const eachPairHasTarget = pairs.every((pair) => hanChars(pair).some((char) => targetSet.has(char)));
    if (repeatedSuffix && eachPairHasTarget) {
      return pairs;
    }
  }
  return [candidate];
};

const canSegmentByShorterItems = (text, candidates) => {
  const shorter = candidates.filter((candidate) => candidate !== text && candidate.length >= 2 && candidate.length < text.length);
  if (shorter.length < 2) {
    return false;
  }
  const reachable = new Array(text.length + 1).fill(false);
  reachable[0] = true;
  for (let index = 0; index < text.length; index += 1) {
    if (!reachable[index]) {
      continue;
    }
    for (const candidate of shorter) {
      if (text.startsWith(candidate, index)) {
        reachable[index + candidate.length] = true;
      }
    }
  }
  return reachable[text.length];
};

const isLikelyBadContainingCandidate = (longer, shorter) => {
  const index = longer.text.indexOf(shorter.text);
  if (index < 0 || longer.matchedChars.length !== shorter.matchedChars.length) {
    return false;
  }
  if (index === 0 && longer.text.length === shorter.text.length + 1) {
    return longer.text.at(-1) !== shorter.text.at(-1);
  }
  return index === 1 && longer.text.endsWith("子");
};

const isDenseTargetItem = (item, targetCompact) => {
  if (item.text.length >= 4 && targetCompact.includes(item.text)) {
    return true;
  }
  const chars = hanChars(item.text);
  const targetPositions = chars.flatMap((char, index) => (item.matchedChars.includes(char) ? [index] : []));
  if (chars.length === 3 && targetPositions.some((position, index) => index > 0 && position === targetPositions[index - 1] + 1)) {
    return true;
  }
  return item.text.length >= 3 && item.matchedChars.length >= 3 && item.matchedChars.length / hanChars(item.text).length > 0.7;
};

const filterDictationItems = (items, targetChars) => {
  const targetCompact = targetChars.join("");
  const candidateTexts = unique(items.map((item) => item.text));
  const segmentedTexts = new Set(candidateTexts.filter((text) => text.length >= 5 && canSegmentByShorterItems(text, candidateTexts)));
  const layoutMatchedChars = new Set(
    items
      .filter((item) => item.source === "layout")
      .flatMap((item) => item.matchedChars),
  );

  return items.filter((item) => {
    if (segmentedTexts.has(item.text)) {
      return false;
    }
    if (isDenseTargetItem(item, targetCompact)) {
      return false;
    }
    if (
      (item.source === "positioned-adjacent" || item.source === "layout-pair") &&
      item.matchedChars.every((char) =>
        items.some(
          (other) =>
            other.text !== item.text &&
            !segmentedTexts.has(other.text) &&
            !isDenseTargetItem(other, targetCompact) &&
            !isLikelyBadContainingCandidate(other, item) &&
            other.matchedChars.includes(char) &&
            (other.source !== "positioned-adjacent" || other.text.startsWith(char) || other.text.endsWith(char)),
        ),
      )
    ) {
      return false;
    }
    const containingItems = items.filter(
      (other) =>
        other.text !== item.text &&
        other.text.length > item.text.length &&
        other.text.includes(item.text) &&
        !segmentedTexts.has(other.text) &&
        !isDenseTargetItem(other, targetCompact),
    );
    if (
      containingItems.some(
        (other) =>
          item.matchedChars.every((char) => other.matchedChars.includes(char)) &&
          (other.matchedChars.length > item.matchedChars.length ||
            (item.source !== "layout" && other.source === "layout" && !isLikelyBadContainingCandidate(other, item))),
      )
    ) {
      return false;
    }
    if (
      items.some(
        (other) =>
          other.text !== item.text &&
          item.text.length > other.text.length &&
          item.text.includes(other.text) &&
          item.matchedChars.every((char) => other.matchedChars.includes(char)) &&
          other.matchedChars.every((char) => item.matchedChars.includes(char)) &&
          isLikelyBadContainingCandidate(item, other),
      )
    ) {
      return false;
    }
    if (item.source === "plain" && item.text.length === 2 && item.matchedChars.length === 1 && layoutMatchedChars.has(item.matchedChars[0])) {
      return false;
    }
    if (item.source === "layout" && item.text.length >= 6 && item.matchedChars.length <= 1) {
      return false;
    }
    return true;
  });
};

const extractDictationItems = ({ layoutPages, positionedPages, targetChars }) => {
  const targetSet = new Set(targetChars);
  const items = [];
  const seen = new Set();

  for (const [pageOffset, pageItems] of positionedPages.entries()) {
    for (const line of positionedLines(pageItems)) {
      for (const candidate of contentCandidatesFromPositionedLine(line, targetSet)) {
        const matchedChars = unique(hanChars(candidate.text).filter((char) => targetSet.has(char)));
        if (matchedChars.length === 0) {
          continue;
        }
        const key = candidate.text;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push({ text: candidate.text, matchedChars, pageOffset, source: candidate.source });
      }
    }
  }

  for (const [pageOffset, page] of layoutPages.entries()) {
    for (const rawLine of page.split(/\r?\n/u)) {
      const line = normalizeContentLine(rawLine);
      const candidates = [
        ...contentCandidatesFromLine(line).map((text) => ({ text, source: "layout" })),
        ...layoutPairCandidatesFromLine(line, targetSet).map((text) => ({ text, source: "layout-pair" })),
      ];
      for (const candidate of candidates) {
        for (const expanded of expandedCandidates(candidate.text, targetSet)) {
          const matchedChars = unique(hanChars(expanded).filter((char) => targetSet.has(char)));
          if (matchedChars.length === 0) {
            continue;
          }
          const key = expanded;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          items.push({ text: expanded, matchedChars, pageOffset, source: candidate.source });
        }
      }
    }
  }

  return filterDictationItems(items, targetChars).map(({ source, ...item }) => item);
};

const findPageByTitle = (pages, title, startAt = 5) => {
  const compactTitle = onlyHan(title);
  return pages.findIndex((page, index) => index >= startAt && onlyHan(page).includes(compactTitle));
};

const pageRangeForGarden = (pages, tocItems, pageMap, garden) => {
  const appendixStart = appendixStartIndex(pages);
  let startIndex = pageMap.get(garden.tocPage);
  if (startIndex === undefined) {
    startIndex = findPageByTitle(pages, garden.title);
  }
  if (startIndex < 0 || startIndex === undefined) {
    return { startIndex: -1, endIndex: -1, printedStart: garden.tocPage, printedEnd: "" };
  }
  const nextItem = tocItems.find((item) => item.tocPage > garden.tocPage);
  let endIndex = nextItem ? pageMap.get(nextItem.tocPage) : undefined;
  if (endIndex === undefined && nextItem) {
    endIndex = findPageByTitle(pages, nextItem.title, startIndex + 1);
  }
  if (endIndex === undefined || endIndex < 0 || endIndex <= startIndex) {
    endIndex = appendixStart;
  }
  return {
    startIndex,
    endIndex: Math.min(endIndex, appendixStart),
    printedStart: garden.tocPage,
    printedEnd: nextItem ? Math.max(garden.tocPage, nextItem.tocPage - 1) : "",
  };
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

const mapGardenCharEntries = ({ entries, gardens, plainPages, layoutPages, tocItems, pageMap }) => {
  const gardenRanges = gardens.map((garden) => {
    const pageRange = pageRangeForGarden(plainPages, tocItems, pageMap, garden);
    const plainSlice = pageRange.startIndex >= 0 ? plainPages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    const layoutSlice = pageRange.startIndex >= 0 ? layoutPages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    return {
      garden,
      content: onlyHan([...plainSlice, ...layoutSlice].join("\n")),
    };
  });

  return entries.map((entry) => {
    let best = null;
    for (const range of gardenRanges) {
      const scored = gardenContentScore(range.content, entry.chars);
      if (!best || scored.score > best.score) {
        best = { ...scored, garden: range.garden };
      }
    }
    const minHits = entry.chars.length <= 2 ? entry.chars.length : Math.max(2, Math.ceil(entry.chars.length * 0.6));
    if (best && best.charHits >= minHits) {
      return { ...entry, gardenIndex: best.garden.gardenIndex };
    }
    return entry;
  });
};

const writeGardenMarkdown = (book, garden, pageRange, chars, dictationItems) => {
  const charsWithMatches = new Map(chars.map((char) => [char, []]));
  for (const item of dictationItems) {
    for (const char of item.matchedChars) {
      if (charsWithMatches.has(char)) {
        charsWithMatches.get(char).push(item.text);
      }
    }
  }

  const unmatched = chars.filter((char) => charsWithMatches.get(char).length === 0);
  const fileName = `g${book.grade}-t${book.term}-garden-${String(garden.gardenIndex).padStart(2, "0")}-${garden.title}.md`;
  const filePath = path.join(outputDir, fileName);
  const pageText =
    pageRange.printedEnd && pageRange.printedEnd !== pageRange.printedStart
      ? `${pageRange.printedStart}-${pageRange.printedEnd}`
      : `${pageRange.printedStart || "未定位"}`;

  const markdown = [
    `# ${book.grade}年级${termName(book.term)} ${garden.title}`,
    "",
    `- PDF：${book.pdf}`,
    `- 页码：${pageText}`,
    `- 园地生字：${chars.join("") || "（无）"}`,
    `- 抽取原则：只从本语文园地对应 PDF 页中匹配；未找到就留空，不外部补词。`,
    "",
    "## 默写内容",
    "",
    dictationItems.length > 0 ? dictationItems.map((item) => `- ${item.text}`).join("\n") : "（空）",
    "",
    "## 按字匹配",
    "",
    "| 字 | 教材中匹配到的默写内容 |",
    "|---|---|",
    ...chars.map((char) => `| ${char} | ${unique(charsWithMatches.get(char)).join("、") || ""} |`),
    "",
    "## 未匹配字",
    "",
    unmatched.length > 0 ? unmatched.join("") : "（无）",
    "",
  ].join("\n");

  writeFileSync(filePath, markdown);
  return { ...garden, fileName, chars, itemCount: dictationItems.length, unmatched };
};

const verifiedItemsForGarden = ({ book, garden, chars, pageText }) => {
  const key = `${book.grade}-${book.term}-${garden.gardenIndex}`;
  const verified = verifiedGardenDictation.get(key) ?? [];
  if (verified.length === 0) {
    return [];
  }
  const targetSet = new Set(chars);
  const compactPageText = onlyHan(pageText);
  return verified
    .filter((text) => compactPageText.includes(text))
    .map((text) => ({
      text,
      matchedChars: unique(hanChars(text).filter((char) => targetSet.has(char))),
      pageOffset: 0,
    }))
    .filter((item) => item.matchedChars.length > 0);
};

const buildBookGardens = (pdfPath) => {
  const pdf = path.basename(pdfPath);
  const bookInfo = parseBookInfo(pdf);
  if (!bookInfo) {
    return [];
  }
  const plainPages = extractPdfPages(pdfPath, "plain");
  const layoutPages = extractPdfPages(pdfPath, "layout");
  const positionedPages = extractPdfTextItems(pdfPath);
  const tocItems = parseTocItems(plainPages, bookInfo.grade, bookInfo.term);
  const pageMap = printedPageMap(plainPages);

  const recognitionPages = appendixRegion(plainPages, /识\s*字\s*表/u, /写\s*字\s*表/u);
  const writingPages = appendixRegion(plainPages, /写\s*字\s*表/u, /词\s*语\s*表|常用笔画名称表|常用偏旁名称表|后\s*记/u);
  const gardenCharEntries = [...parseCharEntries(recognitionPages, "识字表", "二类"), ...parseCharEntries(writingPages, "写字表", "一类")]
    .filter((entry) => entry.section === "语文园地")
    .map((entry) => ({ ...entry, chars: unique(entry.chars) }));
  const allGardens = tocItems.filter((item) => item.type === "garden");
  const mappedGardenEntries = mapGardenCharEntries({
    entries: gardenCharEntries,
    gardens: allGardens,
    plainPages,
    layoutPages,
    tocItems,
    pageMap,
  });
  const charsByGarden = new Map();
  for (const entry of mappedGardenEntries) {
    const existing = charsByGarden.get(entry.gardenIndex) ?? [];
    charsByGarden.set(entry.gardenIndex, unique([...existing, ...entry.chars]));
  }

  const gardens = allGardens;
  const book = { ...bookInfo, pdf };
  const summaries = [];
  for (const garden of gardens) {
    const chars = charsByGarden.get(garden.gardenIndex) ?? [];
    const pageRange = pageRangeForGarden(plainPages, tocItems, pageMap, garden);
    const plainSlice = pageRange.startIndex >= 0 ? plainPages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    const layoutSlice = pageRange.startIndex >= 0 ? layoutPages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    const positionedSlice = pageRange.startIndex >= 0 ? positionedPages.slice(pageRange.startIndex, pageRange.endIndex) : [];
    let dictationItems =
      chars.length > 0
        ? extractDictationItems({
            layoutPages: layoutSlice,
            positionedPages: positionedSlice,
            targetChars: chars,
          })
        : [];
    const verifiedItems = verifiedItemsForGarden({
      book,
      garden,
      chars,
      pageText: [...plainSlice, ...layoutSlice].join("\n"),
    });
    if (verifiedItems.length > 0) {
      dictationItems = verifiedItems;
    }
    summaries.push(writeGardenMarkdown(book, garden, pageRange, chars, dictationItems));
  }
  return summaries;
};

const writeIndex = (summaries) => {
  const markdown = [
    "# 语文园地默写内容",
    "",
    "本目录由 `npm run extract:garden` 从教材 PDF 自动抽取，只匹配语文园地生字在对应语文园地页面中出现的词语、成语或句子；没有匹配到的字保持空白。",
    "",
    "| 年级 | 册别 | 语文园地 | 生字数 | 默写内容数 | 未匹配字 | 文件 |",
    "|---:|---|---|---:|---:|---|---|",
    ...summaries.map((item) => {
      return `| ${item.grade} | ${termName(item.term)} | ${item.title} | ${item.chars.length} | ${item.itemCount} | ${item.unmatched.join("") || "（无）"} | [打开](${markdownPath(item.fileName)}) |`;
    }),
    "",
  ].join("\n");
  writeFileSync(path.join(outputDir, "README.md"), markdown);
};

const main = () => {
  if (!existsSync(textbookCacheDir)) {
    throw new Error(`Missing textbook cache: ${textbookCacheDir}`);
  }
  rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(outputDir, { recursive: true });

  const pdfs = readdirSync(textbookCacheDir)
    .filter((name) => parseBookInfo(name))
    .sort((a, b) => {
      const bookA = parseBookInfo(a);
      const bookB = parseBookInfo(b);
      return bookA.grade - bookB.grade || bookA.term - bookB.term;
    })
    .map((name) => path.join(textbookCacheDir, name));

  const summaries = [];
  for (const pdf of pdfs) {
    console.log(`Extracting gardens from ${path.basename(pdf)}`);
    summaries.push(...buildBookGardens(pdf));
  }
  writeIndex(summaries);
  console.log(
    JSON.stringify(
      {
        outputDir,
        gardens: summaries.length,
        dictationItems: summaries.reduce((sum, item) => sum + item.itemCount, 0),
        unmatchedChars: summaries.reduce((sum, item) => sum + item.unmatched.length, 0),
      },
      null,
      2,
    ),
  );
};

main();
