import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { pinyin } from "pinyin-pro";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");
const textbookCacheDir = process.env.ZIQU_TEXTBOOK_CACHE_DIR || path.join(projectRoot, ".cache", "textbooks");
const catalogDbPath = process.env.ZIQU_CATALOG_DB_PATH || path.join(dataDir, "ziqu-catalog.sqlite");
const commonWordCachePath = path.join(projectRoot, ".cache", "xiandaihaiyuchangyongcibiao.txt");
const dictionaryWordCachePath = path.join(projectRoot, ".cache", "jieba-dict-big.txt");
const contentsUrl =
  "https://api.github.com/repos/TapXWorld/ChinaTextbook/contents/%E5%B0%8F%E5%AD%A6/%E8%AF%AD%E6%96%87/%E7%BB%9F%E7%BC%96%E7%89%88?ref=master";
const commonWordUrl =
  "https://raw.githubusercontent.com/liangqi/chinese-frequency-word-list/master/xiandaihaiyuchangyongcibiao.txt";
const dictionaryWordUrl = "https://raw.githubusercontent.com/fxsjy/jieba/master/extra_dict/dict.txt.big";

const maxGrade = Number(process.env.ZIQU_TEXTBOOK_MAX_GRADE || 5);
const companionCount = 1;
const commonWordMaxRank = 30000;

const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  term INTEGER NOT NULL CHECK (term IN (1, 2)),
  term_name TEXT NOT NULL CHECK (term_name IN ('上册', '下册')),
  section TEXT NOT NULL,
  lesson_number REAL NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  lesson_kind TEXT NOT NULL CHECK (lesson_kind IN ('regular', 'garden', 'pinyin', 'classical_poetry', 'classical_prose', 'traditional_rhyme')),
  is_classical INTEGER NOT NULL CHECK (is_classical IN (0, 1)),
  direct_dictation INTEGER NOT NULL CHECK (direct_dictation IN (0, 1)),
  source_pdf TEXT NOT NULL,
  UNIQUE (grade, term, section, lesson_number, title)
);

CREATE TABLE lesson_chars (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('一类', '二类')),
  pinyin TEXT,
  char_order INTEGER NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('识字表', '写字表')),
  PRIMARY KEY (lesson_id, char, category)
);

CREATE TABLE textbook_words (
  id TEXT PRIMARY KEY,
  lesson_id TEXT REFERENCES lessons(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  word_order INTEGER NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('词语表', '课文配词')),
  UNIQUE (lesson_id, text)
);

CREATE TABLE char_companion_words (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  word TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  companion_rank INTEGER NOT NULL CHECK (companion_rank >= 1),
  source TEXT NOT NULL CHECK (source IN ('textbook_same_lesson', 'textbook_other_lesson', 'common_word_list', 'manual_override')),
  source_lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  frequency INTEGER,
  PRIMARY KEY (lesson_id, char, companion_rank),
  UNIQUE (lesson_id, char, word)
);

CREATE TABLE companion_word_overrides (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT NOT NULL,
  companion_rank INTEGER NOT NULL CHECK (companion_rank >= 1),
  word TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (lesson_id, char, companion_rank),
  UNIQUE (lesson_id, char, word)
);

CREATE TABLE companion_word_blocks (
  lesson_id TEXT REFERENCES lessons(id) ON DELETE CASCADE,
  char TEXT,
  word TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_lessons_scope ON lessons(grade, term, sort_order);
CREATE INDEX idx_lesson_chars_char ON lesson_chars(char, category);
CREATE INDEX idx_textbook_words_text ON textbook_words(text);
CREATE INDEX idx_companions_char ON char_companion_words(char, source);
CREATE INDEX idx_companion_overrides_scope ON companion_word_overrides(lesson_id, char);
CREATE INDEX idx_companion_blocks_word ON companion_word_blocks(word);
`;

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
const hanWordPattern = /^[\p{Script=Han}]{2,6}$/u;
const punctuationPattern = /[，。！？；：“”‘’、（）《》〈〉]/gu;
const traditionalOnlyPattern = /[盪歷並況為與學國體會來對時長後無過還進開關門見臺灣歐鳳龍龔]/u;
const unsuitableCommonWordPattern =
  /毒品|贩毒|赌博|香烟|卷烟|烟瘾|烤烟|该死|逮捕|阶级|主席|政府|政治|县委|党史|巴黎|欧元|新加坡|美国|阴谋|赚钱|挣钱|截至|鸳鸯楼|霓裳|前赵|后赵|拔赵易汉|魔爪|爪牙|你死我活|我见|小我|有你的|握瑜怀玉|三下|吧台|迪吧|酒吧|网吧|氧吧|会风|会长|会见|会同|花会|笔会|人地|聊以|示威|弹药|导弹|炸弹|子弹|论坛|体坛|文坛|足坛|苟且|扳机|哔叽|芥蒂|孟加拉|壮锦|抢掠|抱病|方舟|贤惠|戎装|矢志|倭寇|猩红|碳酸|谁人|丽人|迪斯科|榨菜|娶亲|地堡|做贼|冷轧|泰斗|殃及|窝点|够呛|自找|蓬莱|煞白|讳言|饶有|饶恕|乙方|未遂|淋巴|备战|烟草|赌气|斩首|玩忽|剥削|鸣放|血浆|战斗|袭击|恶化|拦网|迷信|北上|一二|狗屁|串通|艾滋病|耶稣|霓虹灯|翔实|蝉联|瓶颈|蹊跷|婀娜|谁个|弯子|挂果|好找|抱不平|织机|削平|粘连|湿淋淋|榨取|热轧|贤良|泰然|船坞|撩拨|擂台|窃贼|商贾|通胀|吨位|蚕食|入寇|鱼水|看穿|斗士|分水岭|捉拿|闯荡|绝伦|沦落|拦腰|哄笑|死人|战乱|洗钱|炮弹|杀害|赚取|糖尿病|死亡|抹杀|屠杀|赌场|枪毙|手榴弹|廉政|战略|战俘|枪声|炮火|哄抬|坑害|卵子|垫付|捧场|说开|赚取|闯红灯|省区/u;
const curatedLessonTextWords = ["赵县", "安济桥"];

const termName = (term) => (term === 2 ? "下册" : "上册");
const hanChars = (value) => Array.from(value).filter((char) => hanPattern.test(char));
const unique = (values) => [...new Set(values)];
const onlyHan = (value) => hanChars(value).join("");
const pinyinFor = (text) => pinyin(text, { toneType: "symbol", type: "array" }).join(" ");
const fallbackSectionOrder = new Map([
  ["识字", 100],
  ["汉语拼音", 200],
  ["课文", 300],
  ["语文园地", 900],
]);
const fallbackLessonSortOrder = (lesson) =>
  (fallbackSectionOrder.get(lesson.section) ?? 800) + Number(lesson.lessonNumber ?? lesson.number ?? lesson.gardenIndex ?? 0);
const lessonOrder = (lesson) => lesson.grade * 10000 + lesson.term * 1000 + Number(lesson.sortOrder ?? fallbackLessonSortOrder(lesson));

const classifyLesson = (title, section) => {
  if (title.startsWith("语文园地")) {
    return { lessonKind: "garden", isClassical: false, directDictation: false };
  }
  if (section === "汉语拼音") {
    return { lessonKind: "pinyin", isClassical: false, directDictation: false };
  }
  if (title.includes("古诗") || title.includes("古诗词") || classicalPoetryTitles.has(title)) {
    return { lessonKind: "classical_poetry", isClassical: true, directDictation: true };
  }
  if (title.includes("文言文") || classicalProseTitles.has(title)) {
    return { lessonKind: "classical_prose", isClassical: true, directDictation: true };
  }
  if (traditionalRhymeTitles.has(title)) {
    return { lessonKind: "traditional_rhyme", isClassical: true, directDictation: true };
  }
  return { lessonKind: "regular", isClassical: false, directDictation: false };
};

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { "user-agent": "ziqu-catalog-rebuilder" } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const downloadFile = async (url, destination) => {
  if (existsSync(destination)) {
    return;
  }
  const response = await fetch(encodeURI(url), { headers: { "user-agent": "ziqu-catalog-rebuilder" } });
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

const extractPdfPages = (pdfPath) => {
  const code = String.raw`
import json
import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
print(json.dumps([page.extract_text() or "" for page in reader.pages], ensure_ascii=False))
`;
  const result = spawnSync("python3", ["-c", code, pdfPath], {
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
    .replace(/[^\p{Script=Han}0-9一二三四五六七八九十◎*·（）()《》“”：:，。、. \-—]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const normalizeEntryLine = (line) =>
  line
    .replace(/^([.\s]*)(\d)\s+(\d)(\*?\s*[.、])/u, "$1$2$3$4")
    .replace(/^([.\s]*)(\d)\s+(\d)(\*?\s+)(?=[\p{Script=Han}])/u, "$1$2$3$4");

const usefulChinese = (line) => onlyHan(line).length > 0;

const appendixRegion = (pages, startPattern, endPattern) => {
  const appendixFloor = Math.max(0, Math.floor(pages.length * 0.65));
  const start = pages.findIndex((page, index) => index >= appendixFloor && startPattern.test(page));
  if (start < 0) {
    return [];
  }
  const end = pages.findIndex((page, index) => index > start && endPattern.test(page));
  return pages.slice(start, end > start ? end : pages.length);
};

const entryId = ({ section, number, gardenIndex }) => {
  if (section === "语文园地") {
    return `garden-${gardenIndex}`;
  }
  return `${section}-${number}`;
};

const makeLessonId = (grade, term, entry) => {
  if (entry.section === "语文园地") {
    return `g${grade}-t${term}-garden-${entry.gardenIndex}`;
  }
  return `g${grade}-t${term}-${entry.section}-${entry.number}`.replace(/[^\p{Script=Han}a-zA-Z0-9-]/gu, "");
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
    if (/^\d{1,2}\*?$/u.test(line) && nextLine && usefulChinese(nextLine)) {
      line = `${line} ${nextLine}`;
      index = nextIndex;
    }
    tocLines.push(line);
  }
  const lessons = new Map();
  let section = "课文";
  let gardenIndex = 0;
  let lastLessonNumber = 0;
  let sortOrder = 0;

  for (const rawLine of tocLines) {
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

    if (line.includes("语文园地")) {
      gardenIndex += 1;
      const explicit = line.match(/语文园地([一二三四五六七八九十])?/u)?.[1];
      const number = explicit ? chineseNumerals.get(explicit) ?? gardenIndex : gardenIndex;
      const id = makeLessonId(grade, term, { section: "语文园地", gardenIndex: number });
      const title = explicit ? `语文园地${explicit}` : "语文园地";
      const classification = classifyLesson(title, "语文园地");
      lessons.set(`语文园地-${number}`, {
        id,
        grade,
        term,
        termName: termName(term),
        section: "语文园地",
        lessonNumber: lastLessonNumber + 0.5,
        sortOrder: sortOrder++,
        title,
        sourcePdf,
        gardenIndex: number,
        ...classification,
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
    const id = makeLessonId(grade, term, { section, number });
    const classification = classifyLesson(title, section);
    lessons.set(key, {
      id,
      grade,
      term,
      termName: termName(term),
      section,
      lessonNumber: number,
      sortOrder: sortOrder++,
      title,
      sourcePdf,
      ...classification,
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

  for (const rawPage of pages) {
    for (const rawLine of rawPage.split(/\r?\n/u)) {
      const line = normalizeEntryLine(normalizeLine(rawLine));
      if (
        !line ||
        /^\d+$/u.test(line) ||
        line.includes(tableName) ||
        line.includes("蓝色的字") ||
        line.includes("不计入") ||
        line.includes("共") ||
        line.includes("常用")
      ) {
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
  }
  pushCurrent();
  return entries;
};

const cleanWordToken = (token) => onlyHan(token.replace(/[^\p{Script=Han}]/gu, ""));

const hasSentencePunctuation = (line) => /[，。！？；：]/u.test(line);

const isSpacedCharListLine = (line) => {
  const text = onlyHan(line);
  return text.length > 0 && text.length <= 14 && /[\p{Script=Han}]\s+[\p{Script=Han}]/u.test(line) && !hasSentencePunctuation(line);
};

const pageHanText = (page) => {
  const lines = [];
  let inCharList = false;
  for (const line of page.split(/\r?\n/u).map(normalizeLine)) {
    if (!line || /^\d+$/u.test(line) || line.startsWith("本文选自")) {
      continue;
    }
    if (isSpacedCharListLine(line)) {
      inCharList = true;
      continue;
    }
    if (inCharList && !hasSentencePunctuation(line) && onlyHan(line).length <= 8) {
      continue;
    }
    lines.push(onlyHan(line));
  }
  return lines.join("");
};

const parseTextbookWords = (pages) => {
  const entries = [];
  let currentNumber = null;
  let wordOrder = 0;

  for (const rawPage of pages) {
    for (const rawLine of rawPage.split(/\r?\n/u)) {
      const line = normalizeEntryLine(normalizeLine(rawLine));
      if (!line || /^\d+$/u.test(line) || line.includes("词语表") || line.includes("后记")) {
        continue;
      }
      const entryMatch = line.match(/^[.\s]*(\d{1,2})\s*[.、]?\s*(.*)$/u);
      const text = entryMatch ? entryMatch[2] : line;
      if (entryMatch) {
        currentNumber = Number(entryMatch[1]);
      }
      if (!currentNumber) {
        continue;
      }
      const words = text
        .replace(punctuationPattern, " ")
        .split(/[.\s]+/u)
        .map(cleanWordToken)
        .filter((word) => hanWordPattern.test(word));
      for (const word of words) {
        entries.push({ section: "课文", number: currentNumber, text: word, wordOrder: wordOrder++ });
      }
    }
  }

  return entries;
};

const parseLessonTextWords = (pages, lessons, lessonChars, fallbackWords) => {
  const appendixFloor = Math.max(0, Math.floor(pages.length * 0.65));
  const bodyPages = pages.slice(0, appendixFloor).map(pageHanText);
  const dictionary = new Set(fallbackWords.map((word) => word.text).filter((word) => hanWordPattern.test(word)));
  const lessonCharsById = new Map();
  for (const row of lessonChars) {
    lessonCharsById.set(row.lessonId, new Set([...(lessonCharsById.get(row.lessonId) ?? []), row.char]));
  }
  const candidates = [...lessons.values()]
    .filter((lesson) => lesson.section !== "语文园地" && onlyHan(lesson.title).length >= 2)
    .map((lesson) => {
      const title = onlyHan(lesson.title);
      const startPage = bodyPages.findIndex((text, index) => index >= 5 && text.includes(title));
      return { lesson, startPage };
    })
    .filter((item) => item.startPage >= 0)
    .sort((a, b) => a.startPage - b.startPage || a.lesson.lessonNumber - b.lesson.lessonNumber);

  const words = [];
  let wordOrder = 0;
  for (const [index, item] of candidates.entries()) {
    const endPage = candidates[index + 1]?.startPage ?? appendixFloor;
    const text = bodyPages.slice(item.startPage, Math.max(item.startPage + 1, endPage)).join("");
    const lessonCharsForLesson = lessonCharsById.get(item.lesson.id) ?? new Set();
    const seen = new Set();
    const add = (word) => {
      if (seen.has(word) || !hanWordPattern.test(word)) {
        return;
      }
      seen.add(word);
      words.push({
        section: item.lesson.section,
        number: item.lesson.lessonNumber,
        text: word,
        wordOrder: 10000 + wordOrder++,
      });
    };

    let occupiedUntil = 0;
    for (let start = 0; start < text.length; start += 1) {
      if (start < occupiedUntil) {
        continue;
      }
      let matched = "";
      for (let length = 6; length >= 2; length -= 1) {
        const word = text.slice(start, start + length);
        if (dictionary.has(word)) {
          matched = word;
          break;
        }
      }
      if (matched) {
        add(matched);
        occupiedUntil = start + matched.length;
      }
    }

    for (let start = 0; start < text.length - 1; start += 1) {
      const word = text.slice(start, start + 2);
      if (/县$/u.test(word) && hanChars(word).some((char) => lessonCharsForLesson.has(char))) {
        add(word);
      }
    }
    for (const word of curatedLessonTextWords) {
      if (text.includes(word)) {
        add(word);
      }
    }
  }

  return words;
};

const fallbackTitle = (entry) => {
  if (entry.section === "语文园地") {
    return `语文园地${[...chineseNumerals.entries()].find(([, value]) => value === entry.gardenIndex)?.[0] ?? entry.gardenIndex}`;
  }
  return entry.section === "课文" ? `第${entry.number}课` : `${entry.section}${entry.number}`;
};

const ensureLesson = (lessons, grade, term, sourcePdf, entry) => {
  const key = entry.section === "语文园地" ? `语文园地-${entry.gardenIndex}` : `${entry.section}-${entry.number}`;
  const existing = lessons.get(key);
  if (existing) {
    return existing;
  }
  const title = fallbackTitle(entry);
  const id = makeLessonId(grade, term, entry);
  const classification = classifyLesson(title, entry.section);
  const lesson = {
    id,
    grade,
    term,
    termName: termName(term),
    section: entry.section,
    lessonNumber: entry.section === "语文园地" ? entry.gardenIndex + 0.5 : entry.number,
    sortOrder: fallbackLessonSortOrder(entry),
    title,
    sourcePdf,
    ...classification,
  };
  lessons.set(key, lesson);
  return lesson;
};

const textbookWordScore = (sourceLesson, candidateLesson, word) => {
  const sameLesson = sourceLesson.id === candidateLesson?.id;
  const length = hanChars(word.text).length;
  return (sameLesson ? 100000 : 0) + Math.max(0, 50000 - Math.abs(lessonOrder(sourceLesson) - lessonOrder(candidateLesson ?? sourceLesson))) + (6 - length) * 100 - word.wordOrder;
};

const commonWordScore = (char, word) => {
  const length = hanChars(word.text).length;
  const positionBonus = word.text.startsWith(char) ? -10000 : word.text.endsWith(char) ? -2000 : 0;
  return word.sourcePriority * 1_000_000 + word.rank + Math.max(0, length - 2) * 5000 + positionBonus;
};

const isAllowedCommonFallback = (word) =>
  word.curated ||
  (word.sourcePriority === 0 &&
    word.rank <= commonWordMaxRank &&
    hanChars(word.text).length <= 3 &&
    !word.blocksCommonFallback &&
    !traditionalOnlyPattern.test(word.text) &&
    !unsuitableCommonWordPattern.test(word.text));

const isFullyLearnedWord = (word, learnedChars) => hanChars(word).every((char) => learnedChars.has(char));

const loadCommonWords = async () => {
  mkdirSync(path.dirname(commonWordCachePath), { recursive: true });
  if (!existsSync(commonWordCachePath)) {
    await downloadFile(commonWordUrl, commonWordCachePath);
  }
  const raw = readFileSync(commonWordCachePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line, index) => {
      const [word, , rankText] = line.trim().split(/\t/u);
      const rank = Number(rankText) || index + 1;
      return { text: cleanWordToken(word || ""), frequency: rank, rank, blocksCommonFallback: false };
    })
    .filter((item) => item.text && hanWordPattern.test(item.text))
    .sort((a, b) => a.rank - b.rank || hanChars(a.text).length - hanChars(b.text).length || a.text.localeCompare(b.text, "zh-CN"))
    .map((item) => ({ ...item, sourcePriority: 0 }));
};

const loadDictionaryWords = async () => {
  mkdirSync(path.dirname(dictionaryWordCachePath), { recursive: true });
  if (!existsSync(dictionaryWordCachePath)) {
    await downloadFile(dictionaryWordUrl, dictionaryWordCachePath);
  }
  const raw = readFileSync(dictionaryWordCachePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line, index) => {
      const [word, frequencyText, partOfSpeech = ""] = line.trim().split(/\s+/u);
      const frequency = Number(frequencyText) || 0;
      const isProperNoun = ["nr", "nrfg", "ns", "nt", "nz"].some((prefix) => partOfSpeech.startsWith(prefix));
      const blocksCommonFallback = ["ns", "nt", "nz"].some((prefix) => partOfSpeech.startsWith(prefix));
      return {
        text: word || "",
        frequency,
        partOfSpeech,
        blocksCommonFallback,
        rank: Math.max(0, 1_000_000 - frequency) + index / 1_000_000,
        sourcePriority: isProperNoun ? 3 : 1,
      };
    })
    .filter((item) => item.text && hanWordPattern.test(item.text))
    .sort(
      (a, b) =>
        b.frequency - a.frequency ||
        hanChars(a.text).length - hanChars(b.text).length ||
        a.rank - b.rank ||
        a.text.localeCompare(b.text, "zh-CN"),
    );
};

const curatedFallbackWords = [
  "叼着",
  "叼走",
  "好呀",
  "来呀",
  "喵喵",
  "喵呜",
  "哞哞",
  "哞叫",
  "龚自珍",
  "和蔼可亲",
  "水浒传",
  "你我",
  "你好",
  "我们",
  "他们",
  "它们",
  "它的",
  "好吗",
  "来吗",
  "三人",
  "三天",
  "好吧",
  "来吧",
  "走吧",
  "大会",
  "开会",
  "毛笔",
  "天地",
  "土地",
  "表示",
  "示范",
  "弹琴",
  "弹力",
  "弹跳",
  "花坛",
  "讲坛",
  "启迪",
  "姓龚",
  "龚姓",
  "姓赵",
  "赵姓",
  "姓吴",
  "吴姓",
  "姓刘",
  "刘姓",
  "姓邓",
  "邓姓",
  "姓蔡",
  "蔡姓",
  "姓彭",
  "彭姓",
  "粽叶",
  "菠萝",
  "泥泞",
  "喇嘛",
  "诲人",
  "芬芳",
  "清芬",
  "大禹",
  "禹王",
  "蘸水",
  "蘸酱",
  "山冈",
  "冈山",
  "吩咐",
  "瑜伽",
  "瑜珈",
  "船艄",
  "窈窕",
  "雯雯",
  "娜娜",
].map((text, index) => ({
  text,
  frequency: 0,
  rank: 100_000 + index,
  sourcePriority: 0,
  blocksCommonFallback: false,
  curated: true,
}));

const loadFallbackWords = async () => {
  const words = [...(await loadCommonWords()), ...(await loadDictionaryWords()), ...curatedFallbackWords];
  const byText = new Map();
  for (const item of words.sort(
    (a, b) =>
      a.sourcePriority - b.sourcePriority ||
      a.rank - b.rank ||
      hanChars(a.text).length - hanChars(b.text).length ||
      b.frequency - a.frequency ||
      a.text.localeCompare(b.text, "zh-CN"),
  )) {
    const existing = byText.get(item.text);
    if (!existing) {
      byText.set(item.text, { ...item });
    } else {
      if (item.curated) {
        existing.curated = true;
        existing.rank = Math.min(existing.rank, item.rank);
        existing.sourcePriority = Math.min(existing.sourcePriority, item.sourcePriority);
        existing.blocksCommonFallback = false;
      } else if (item.blocksCommonFallback && !existing.curated) {
        existing.blocksCommonFallback = true;
      }
    }
  }
  return [...byText.values()];
};

const chooseCompanions = (lessonChars, lessonsById, textbookWords, commonWords) => {
  const lessonCharsByLessonId = new Map();
  for (const row of lessonChars) {
    lessonCharsByLessonId.set(row.lessonId, new Set([...(lessonCharsByLessonId.get(row.lessonId) ?? []), row.char]));
  }
  const learnedCharsByLessonId = new Map();
  const learnedChars = new Set();
  for (const lesson of [...lessonsById.values()].sort((a, b) => lessonOrder(a) - lessonOrder(b))) {
    for (const char of lessonCharsByLessonId.get(lesson.id) ?? []) {
      learnedChars.add(char);
    }
    learnedCharsByLessonId.set(lesson.id, new Set(learnedChars));
  }

  const byChar = new Map();
  for (const word of textbookWords) {
    for (const char of unique(hanChars(word.text))) {
      byChar.set(char, [...(byChar.get(char) ?? []), word]);
    }
  }

  const commonWordsByChar = new Map();
  for (const item of commonWords) {
    for (const char of unique(hanChars(item.text))) {
      commonWordsByChar.set(char, [...(commonWordsByChar.get(char) ?? []), item]);
    }
  }

  const companions = [];
  const distinctLessonChars = [...new Map(lessonChars.map((item) => [`${item.lessonId}\u0000${item.char}`, item])).values()];

  for (const item of distinctLessonChars) {
    const lesson = lessonsById.get(item.lessonId);
    const learnedCharsForLesson = learnedCharsByLessonId.get(item.lessonId) ?? new Set([item.char]);
    const chosen = [];
    const seen = new Set();

    const add = (candidate) => {
      if (chosen.length >= companionCount || seen.has(candidate.word)) {
        return;
      }
      seen.add(candidate.word);
      chosen.push(candidate);
    };

    const currentLessonOrder = lessonOrder(lesson);
    const textbookCandidates = (byChar.get(item.char) ?? [])
      .filter((word) => word.text !== item.char)
      .filter((word) => hanChars(word.text).length <= 3)
      .filter((word) => isFullyLearnedWord(word.text, learnedCharsForLesson))
      .map((word) => ({
        word: word.text,
        pinyin: word.pinyin,
        source: word.lessonId === item.lessonId ? "textbook_same_lesson" : "textbook_other_lesson",
        sourceLessonId: word.lessonId,
        frequency: null,
        score: textbookWordScore(lesson, lessonsById.get(word.lessonId), word),
      }))
      .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word, "zh-CN"));

    for (const candidate of textbookCandidates.filter((candidate) => {
      const sourceLesson = lessonsById.get(candidate.sourceLessonId);
      return sourceLesson && sourceLesson.id === item.lessonId;
    })) {
      add({
        ...candidate,
        source: "textbook_same_lesson",
      });
    }

    for (const candidate of textbookCandidates.filter((candidate) => {
      const sourceLesson = lessonsById.get(candidate.sourceLessonId);
      return sourceLesson && sourceLesson.id !== item.lessonId && lessonOrder(sourceLesson) <= currentLessonOrder;
    })) {
      add({
        ...candidate,
        source: "textbook_other_lesson",
      });
    }

    for (const [index, candidate] of chosen.entries()) {
      companions.push({
        lessonId: item.lessonId,
        char: item.char,
        word: candidate.word,
        pinyin: candidate.pinyin,
        companionRank: index + 1,
        source: candidate.source,
        sourceLessonId: candidate.sourceLessonId,
        frequency: candidate.frequency,
      });
    }
  }

  return companions;
};

const buildBook = async (item, fallbackWords) => {
  const { grade, term } = item.book;
  const pdfPath = path.join(textbookCacheDir, item.name);
  await downloadFile(item.download_url, pdfPath);
  const pages = extractPdfPages(pdfPath);
  const lessons = parseToc(pages, grade, term, item.name);

  const recognitionPages = appendixRegion(pages, /识\s*字\s*表/u, /写\s*字\s*表/u);
  const writingPages = appendixRegion(pages, /写\s*字\s*表/u, /词\s*语\s*表|常用笔画名称表|常用偏旁名称表|后\s*记/u);
  const wordPages = appendixRegion(pages, /词\s*语\s*表/u, /后\s*记/u);

  const charRows = [];
  const entries = [
    ...parseCharEntries(recognitionPages, "识字表", "二类"),
    ...parseCharEntries(writingPages, "写字表", "一类"),
  ];
  for (const entry of entries) {
    const lesson = ensureLesson(lessons, grade, term, item.name, entry);
    entry.chars.forEach((char, index) => {
      charRows.push({
        lessonId: lesson.id,
        char,
        category: entry.category,
        pinyin: pinyinFor(char),
        charOrder: entry.orderBase + index,
        sourceTable: entry.sourceTable,
      });
    });
  }

  const textbookWords = [];
  const textbookWordEntries = [...parseTextbookWords(wordPages), ...parseLessonTextWords(pages, lessons, charRows, fallbackWords)];
  for (const word of textbookWordEntries) {
    const lesson = ensureLesson(lessons, grade, term, item.name, word);
    textbookWords.push({
      id: `${lesson.id}-word-${textbookWords.length + 1}`,
      lessonId: lesson.id,
      text: word.text,
      pinyin: pinyinFor(word.text),
      wordOrder: word.wordOrder,
      sourceTable: word.wordOrder >= 10000 ? "课文配词" : "词语表",
    });
  }

  return { lessons: [...lessons.values()], charRows, textbookWords };
};

const saveCatalog = (db, catalog) => {
  const insertLesson = db.prepare(
    `INSERT OR IGNORE INTO lessons
       (id, grade, term, term_name, section, lesson_number, sort_order, title, lesson_kind, is_classical, direct_dictation, source_pdf)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChar = db.prepare(
    `INSERT OR REPLACE INTO lesson_chars
       (lesson_id, char, category, pinyin, char_order, source_table)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertWord = db.prepare(
    `INSERT OR IGNORE INTO textbook_words
       (id, lesson_id, text, pinyin, word_order, source_table)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertCompanion = db.prepare(
    `INSERT OR REPLACE INTO char_companion_words
       (lesson_id, char, word, pinyin, companion_rank, source, source_lesson_id, frequency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    for (const lesson of catalog.lessons) {
      insertLesson.run(
        lesson.id,
        lesson.grade,
        lesson.term,
        lesson.termName,
        lesson.section,
        lesson.lessonNumber,
        lesson.sortOrder,
        lesson.title,
        lesson.lessonKind,
        lesson.isClassical ? 1 : 0,
        lesson.directDictation ? 1 : 0,
        lesson.sourcePdf,
      );
    }
    for (const row of catalog.lessonChars) {
      insertChar.run(row.lessonId, row.char, row.category, row.pinyin, row.charOrder, row.sourceTable);
    }
    for (const word of catalog.textbookWords) {
      insertWord.run(word.id, word.lessonId, word.text, word.pinyin, word.wordOrder, word.sourceTable);
    }
    for (const companion of catalog.companions) {
      insertCompanion.run(
        companion.lessonId,
        companion.char,
        companion.word,
        companion.pinyin,
        companion.companionRank,
        companion.source,
        companion.sourceLessonId,
        companion.frequency,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const tableExists = (db, tableName) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));

const loadExistingCuration = () => {
  if (!existsSync(catalogDbPath)) {
    return { overrides: [], blocks: [] };
  }
  const db = new DatabaseSync(catalogDbPath);
  try {
    return {
      overrides: tableExists(db, "companion_word_overrides")
        ? db
            .prepare(
              `SELECT lesson_id, char, companion_rank, word, pinyin, note, updated_at
               FROM companion_word_overrides
               ORDER BY lesson_id, char, companion_rank`,
            )
            .all()
        : [],
      blocks: tableExists(db, "companion_word_blocks")
        ? db
            .prepare(
              `SELECT lesson_id, char, word, reason, updated_at
               FROM companion_word_blocks
               ORDER BY COALESCE(lesson_id, ''), COALESCE(char, ''), word`,
            )
            .all()
        : [],
    };
  } finally {
    db.close();
  }
};

const saveCuration = (db, curation) => {
  const lessonExists = db.prepare("SELECT 1 FROM lessons WHERE id = ?");
  const lessonCharExists = db.prepare("SELECT 1 FROM lesson_chars WHERE lesson_id = ? AND char = ?");
  const textbookWordExists = db.prepare("SELECT 1 FROM textbook_words WHERE text = ? AND instr(text, ?) > 0");
  const insertOverride = db.prepare(
    `INSERT OR REPLACE INTO companion_word_overrides
       (lesson_id, char, companion_rank, word, pinyin, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO companion_word_blocks
       (lesson_id, char, word, reason, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const row of curation.overrides) {
    if (
      row.companion_rank <= companionCount &&
      lessonExists.get(row.lesson_id) &&
      lessonCharExists.get(row.lesson_id, row.char) &&
      textbookWordExists.get(row.word, row.char)
    ) {
      insertOverride.run(row.lesson_id, row.char, row.companion_rank, row.word, row.pinyin || pinyinFor(row.word), row.note ?? null, row.updated_at ?? new Date().toISOString());
    }
  }
  for (const row of curation.blocks) {
    if (!row.lesson_id || lessonExists.get(row.lesson_id)) {
      insertBlock.run(row.lesson_id ?? null, row.char ?? null, row.word, row.reason ?? null, row.updated_at ?? new Date().toISOString());
    }
  }
};

const applyCuration = (db) => {
  db.prepare(
    `DELETE FROM char_companion_words
     WHERE EXISTS (
       SELECT 1
       FROM companion_word_blocks block
       WHERE block.word = char_companion_words.word
         AND (block.lesson_id IS NULL OR block.lesson_id = char_companion_words.lesson_id)
         AND (block.char IS NULL OR block.char = char_companion_words.char)
     )`,
  ).run();

  const overrideGroups = db.prepare("SELECT DISTINCT lesson_id, char FROM companion_word_overrides ORDER BY lesson_id, char").all();
  const lessonCharExists = db.prepare("SELECT 1 FROM lesson_chars WHERE lesson_id = ? AND char = ?");
  const textbookWordExists = db.prepare("SELECT 1 FROM textbook_words WHERE text = ? AND instr(text, ?) > 0");
  const deleteCompanions = db.prepare("DELETE FROM char_companion_words WHERE lesson_id = ? AND char = ?");
  const overrideRows = db.prepare(
    `SELECT lesson_id, char, companion_rank, word, pinyin
     FROM companion_word_overrides
     WHERE lesson_id = ? AND char = ?
       AND companion_rank <= ?
     ORDER BY companion_rank`,
  );
  const insertCompanion = db.prepare(
    `INSERT INTO char_companion_words
       (lesson_id, char, word, pinyin, companion_rank, source, source_lesson_id, frequency)
     VALUES (?, ?, ?, ?, ?, 'manual_override', NULL, NULL)`,
  );

  for (const group of overrideGroups) {
    if (!lessonCharExists.get(group.lesson_id, group.char)) {
      continue;
    }
    deleteCompanions.run(group.lesson_id, group.char);
    for (const row of overrideRows.all(group.lesson_id, group.char, companionCount).filter((row) => textbookWordExists.get(row.word, row.char))) {
      insertCompanion.run(row.lesson_id, row.char, row.word, row.pinyin || pinyinFor(row.word), row.companion_rank);
    }
  }
};

const dedupeBy = (rows, keyFn) => [...new Map(rows.map((row) => [keyFn(row), row])).values()];

const main = async () => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(textbookCacheDir, { recursive: true });
  const existingCuration = loadExistingCuration();
  if (existsSync(catalogDbPath)) {
    rmSync(catalogDbPath);
  }

  const contents = await fetchJson(contentsUrl);
  const books = contents
    .map((item) => ({ ...item, book: parseBookInfo(item.name) }))
    .filter((item) => item.book && item.book.grade <= maxGrade)
    .sort((a, b) => a.book.grade - b.book.grade || a.book.term - b.book.term);

  console.log("Loading common word list");
  const commonWords = await loadFallbackWords();

  const bookCatalogs = [];
  for (const book of books) {
    console.log(`Reading ${book.name}`);
    bookCatalogs.push(await buildBook(book, commonWords));
  }

  const lessons = dedupeBy(bookCatalogs.flatMap((book) => book.lessons), (lesson) => lesson.id).sort(
    (a, b) => lessonOrder(a) - lessonOrder(b) || a.title.localeCompare(b.title, "zh-CN"),
  );
  const lessonChars = dedupeBy(bookCatalogs.flatMap((book) => book.charRows), (row) => `${row.lessonId}\u0000${row.char}\u0000${row.category}`);
  const textbookWords = dedupeBy(bookCatalogs.flatMap((book) => book.textbookWords), (word) => `${word.lessonId}\u0000${word.text}`);

  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const companions = chooseCompanions(lessonChars, lessonsById, textbookWords, commonWords);

  const db = new DatabaseSync(catalogDbPath);
  db.exec(schemaSql);
  saveCatalog(db, { lessons, lessonChars, textbookWords, companions });
  saveCuration(db, existingCuration);
  applyCuration(db);

  const summary = {
    database: catalogDbPath,
    lessons: db.prepare("SELECT COUNT(*) AS count FROM lessons").get().count,
    lessonChars: db.prepare("SELECT COUNT(*) AS count FROM lesson_chars").get().count,
    distinctLessonChars: db.prepare("SELECT COUNT(*) AS count FROM (SELECT DISTINCT lesson_id, char FROM lesson_chars)").get().count,
    classOne: db.prepare("SELECT COUNT(*) AS count FROM lesson_chars WHERE category = '一类'").get().count,
    classTwo: db.prepare("SELECT COUNT(*) AS count FROM lesson_chars WHERE category = '二类'").get().count,
    textbookWords: db.prepare("SELECT COUNT(*) AS count FROM textbook_words").get().count,
    companions: db.prepare("SELECT COUNT(*) AS count FROM char_companion_words").get().count,
    charsWithCompanion: db.prepare("SELECT COUNT(*) AS count FROM (SELECT lesson_id, char FROM char_companion_words GROUP BY lesson_id, char HAVING COUNT(*) >= 1)")
      .get().count,
    commonWordCompanions: db.prepare("SELECT COUNT(*) AS count FROM char_companion_words WHERE source = 'common_word_list'").get().count,
    manualOverrideCompanions: db.prepare("SELECT COUNT(*) AS count FROM char_companion_words WHERE source = 'manual_override'").get().count,
    manualOverrideRules: db.prepare("SELECT COUNT(*) AS count FROM companion_word_overrides").get().count,
    blockedCompanionRules: db.prepare("SELECT COUNT(*) AS count FROM companion_word_blocks").get().count,
  };
  const missingCompanions = db
    .prepare(
      `SELECT l.grade, l.term_name, l.title, lc.char, COUNT(cw.word) AS companion_count
       FROM (SELECT DISTINCT lesson_id, char FROM lesson_chars) lc
       JOIN lessons l ON l.id = lc.lesson_id
       LEFT JOIN char_companion_words cw ON cw.lesson_id = lc.lesson_id AND cw.char = lc.char
       GROUP BY lc.lesson_id, lc.char
       HAVING companion_count < ?
       ORDER BY l.grade, l.term, l.sort_order, lc.char
       LIMIT 20`,
    )
    .all(companionCount);
  db.close();

  console.log(JSON.stringify(summary, null, 2));
  if (summary.charsWithCompanion !== summary.distinctLessonChars) {
    throw new Error(`Companion generation is incomplete. First missing rows: ${JSON.stringify(missingCompanions)}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
