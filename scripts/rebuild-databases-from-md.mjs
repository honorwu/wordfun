import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  catalogSchemaSql,
  defaultCatalogDatabasePath,
  defaultLearningDatabasePath,
  defaultStudentId,
  ensureDefaultStudent,
  learningSchemaSql,
  projectRoot,
} from "../server/db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const mdRoot = path.join(root, "md");
const wordMdDir = path.join(mdRoot, "字词");
const classicalMdDir = path.join(mdRoot, "古诗词");
const catalogDbPath = process.env.ZIQU_CATALOG_DB_PATH ? path.resolve(process.env.ZIQU_CATALOG_DB_PATH) : defaultCatalogDatabasePath;
const learningDbPath = process.env.ZIQU_LEARNING_DB_PATH ? path.resolve(process.env.ZIQU_LEARNING_DB_PATH) : defaultLearningDatabasePath;
const now = new Date().toISOString();
const resetLearning = process.argv.includes("--reset-learning") || process.env.ZIQU_RESET_LEARNING === "1";

const chineseNumbers = new Map([
  ["零", 0],
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

const numberNames = new Map([...chineseNumbers.entries()].map(([key, value]) => [value, key]));
const hanPattern = /\p{Script=Han}/u;
const hanGlobalPattern = /\p{Script=Han}/gu;
const directDictationTitles = new Set([
  "江南",
  "画",
  "静夜思",
  "对韵歌",
  "古对今",
  "人之初",
  "司马光",
  "守株待兔",
  "精卫填海",
  "王戎不取道旁李",
  "古人谈读书",
  "少年中国说（节选）",
  "自相矛盾",
  "杨氏之子",
]);
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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableId = (prefix, parts) => `${prefix}-${sha256(parts.join("\u0000")).slice(0, 18)}`;
const termName = (term) => (term === 2 ? "下册" : "上册");
const toSourcePath = (filePath) => path.relative(root, filePath).split(path.sep).join("/");
const hanChars = (value) => Array.from(value.matchAll(hanGlobalPattern), (match) => match[0]);
const onlyHan = (value) => hanChars(value).join("");
const uniqueBy = (values, keyFn) => [...new Map(values.map((value) => [keyFn(value), value])).values()];

const parseChineseNumber = (value) => {
  if (!value) {
    return null;
  }
  if (chineseNumbers.has(value)) {
    return chineseNumbers.get(value);
  }
  const match = value.match(/^十([一二三四五六七八九])$/u);
  if (match) {
    return 10 + chineseNumbers.get(match[1]);
  }
  const teen = value.match(/^([一二三四五六七八九])十$/u);
  if (teen) {
    return chineseNumbers.get(teen[1]) * 10;
  }
  const compound = value.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/u);
  if (compound) {
    return chineseNumbers.get(compound[1]) * 10 + chineseNumbers.get(compound[2]);
  }
  return null;
};

const bookInfoFromFileName = (fileName) => {
  const match = fileName.match(/^([1-6])([上下])\.md$/u);
  if (!match) {
    return null;
  }
  return { grade: Number(match[1]), term: match[2] === "下" ? 2 : 1 };
};

const splitMarkdownRow = (line) =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());

const readMarkdownTable = (filePath) => {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
  const tableLines = lines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((item) => item.line.startsWith("|"));
  if (tableLines.length < 2) {
    return [];
  }
  const header = splitMarkdownRow(tableLines[0].line);
  return tableLines.slice(2).flatMap((item) => {
    const cells = splitMarkdownRow(item.line);
    if (cells.length !== header.length) {
      throw new Error(`Malformed markdown table row in ${toSourcePath(filePath)}:${item.lineNumber}`);
    }
    return {
      lineNumber: item.lineNumber,
      row: Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])),
    };
  });
};

const sourceFileRow = (filePath, kind, grade, term) => ({
  path: toSourcePath(filePath),
  kind,
  grade,
  term,
  sha256: sha256(readFileSync(filePath)),
});

const parseUnitIndex = (unitName) => {
  const match = unitName.match(/第([一二三四五六七八九十]+)单元/u);
  return match ? parseChineseNumber(match[1]) : unitName === "我上学了" ? 0 : null;
};

const inferSection = (unitName, title) => {
  if (title.startsWith("语文园地")) {
    return "语文园地";
  }
  const section = unitName.split("·")[1];
  if (section) {
    return section;
  }
  if (unitName.includes("汉语拼音")) {
    return "汉语拼音";
  }
  if (unitName.includes("识字")) {
    return "识字";
  }
  if (unitName.includes("阅读")) {
    return "阅读";
  }
  if (unitName === "我上学了") {
    return "入学准备";
  }
  return "课文";
};

const normalizeLessonTitle = (title, unitIndex) => {
  if (title === "语文园地" && unitIndex) {
    return `语文园地${numberNames.get(unitIndex) ?? unitIndex}`;
  }
  return title;
};

const classifyLesson = (title, lessonType, section) => {
  if (title.startsWith("语文园地")) {
    return { lessonKind: "garden", isClassical: false, directDictation: false };
  }
  if (traditionalRhymeTitles.has(title)) {
    return { lessonKind: "traditional_rhyme", isClassical: true, directDictation: true };
  }
  if (lessonType === "古诗词" || title.includes("古诗") || title.includes("古诗词") || ["江南", "画", "静夜思"].includes(title)) {
    return { lessonKind: "classical_poetry", isClassical: true, directDictation: true };
  }
  if (title.includes("文言文") || classicalProseTitles.has(title)) {
    return { lessonKind: "classical_prose", isClassical: true, directDictation: true };
  }
  if (section === "汉语拼音") {
    return { lessonKind: "pinyin", isClassical: false, directDictation: false };
  }
  return { lessonKind: "regular", isClassical: false, directDictation: directDictationTitles.has(title) };
};

const parseCharColumn = (charsText, pinyinText, filePath, lineNumber, columnName) => {
  const chars = hanChars(charsText);
  const pinyins = pinyinText.split(/\s+/u).filter(Boolean);
  if (chars.length > 0 && pinyins.length > 0 && chars.length !== pinyins.length) {
    throw new Error(`${toSourcePath(filePath)}:${lineNumber} ${columnName} has ${chars.length} chars but ${pinyins.length} pinyin entries`);
  }
  return chars.map((char, index) => ({ char, pinyin: pinyins[index] ?? "" }));
};

const splitWordList = (value) => value.split("、").map((item) => item.trim()).filter(Boolean);

const parseTextbookWords = (wordsText, pinyinText, filePath, lineNumber) => {
  const words = splitWordList(wordsText);
  const pinyins = splitWordList(pinyinText);
  if (words.length > 0 && pinyins.length > 0 && words.length !== pinyins.length) {
    throw new Error(`${toSourcePath(filePath)}:${lineNumber} 词语表 has ${words.length} words but ${pinyins.length} pinyin entries`);
  }
  return words.map((text, index) => ({ text, pinyin: pinyins[index] ?? "" }));
};

const parseUncoveredChars = (value) => {
  const rows = [];
  for (const match of value.matchAll(/(\p{Script=Han})\(([^)]+)\)/gu)) {
    rows.push({ char: match[1], pinyin: match[2] });
  }
  return rows;
};

const parseSupplementWords = (value, filePath, lineNumber) => {
  return value
    .split("；")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(\p{Script=Han})：(.+?)\(([^)]+)\)$/u);
      if (!match) {
        throw new Error(`${toSourcePath(filePath)}:${lineNumber} cannot parse supplement word: ${part}`);
      }
      return { targetChar: match[1], text: match[2], pinyin: match[3] };
    });
};

const buildWordCatalog = () => {
  const sourceFiles = [];
  const lessons = [];
  const lessonCharacters = [];
  const lessonUncoveredCharacters = [];
  const words = [];
  const wordCharacters = [];
  const lessonWords = [];

  const addWord = ({ lessonId, text, pinyin, kind, sourceFile, sourceRow, sourceColumn, targetChar, wordOrder }) => {
    const wordId = stableId("word", [kind, sourceFile, sourceRow, text, pinyin, targetChar ?? ""]);
    if (!words.some((word) => word.id === wordId)) {
      words.push({ id: wordId, text, pinyin, wordKind: kind, sourceFile, sourceRow });
      hanChars(text).forEach((char, index) => {
        wordCharacters.push({ wordId, char, charOrder: index });
      });
    }
    lessonWords.push({
      id: stableId("lesson-word", [lessonId, wordId, sourceColumn, targetChar ?? "", wordOrder]),
      lessonId,
      wordId,
      wordOrder,
      sourceColumn,
      targetChar: targetChar ?? null,
    });
    return { wordId, text, pinyin, sourceColumn, targetChar: targetChar ?? null, lessonId, wordOrder };
  };

  for (const fileName of readdirSync(wordMdDir).filter((name) => name.endsWith(".md")).sort()) {
    const book = bookInfoFromFileName(fileName);
    if (!book) {
      continue;
    }
    const filePath = path.join(wordMdDir, fileName);
    const sourceFile = toSourcePath(filePath);
    sourceFiles.push(sourceFileRow(filePath, "word_table", book.grade, book.term));

    let teachingLessonNumber = 0;
    for (const { row, lineNumber } of readMarkdownTable(filePath)) {
      const sourceRow = lineNumber;
      const rawTitle = row["标题"];
      const unitName = row["单元"];
      const unitIndex = parseUnitIndex(unitName);
      const title = normalizeLessonTitle(rawTitle, unitIndex);
      const section = inferSection(unitName, title);
      const lessonType = row["类型"];
      const rowSequence = Number(row["序号"]);
      const isGarden = title.startsWith("语文园地");
      const isTeachingText = lessonType !== "其他" && !isGarden;
      if (isTeachingText) {
        teachingLessonNumber += 1;
      }
      const lessonNumber = isGarden ? teachingLessonNumber + 0.5 : isTeachingText ? teachingLessonNumber : rowSequence;
      const classification = classifyLesson(title, lessonType, section);
      const lessonId = `g${book.grade}-t${book.term}-r${String(rowSequence).padStart(3, "0")}`;

      lessons.push({
        id: lessonId,
        grade: book.grade,
        term: book.term,
        termName: termName(book.term),
        unitName,
        unitIndex,
        section,
        lessonNumber,
        sortOrder: rowSequence,
        title,
        lessonType,
        sourceFile,
        sourceRow,
        ...classification,
      });

      const recognitionChars = parseCharColumn(row["识字表"], row["识字表拼音"], filePath, lineNumber, "识字表");
      recognitionChars.forEach((item, index) => {
        lessonCharacters.push({
          lessonId,
          char: item.char,
          category: "二类",
          pinyin: item.pinyin,
          charOrder: index,
          sourceColumn: "识字表",
        });
      });

      const writingChars = parseCharColumn(row["写字表"], row["写字表拼音"], filePath, lineNumber, "写字表");
      writingChars.forEach((item, index) => {
        lessonCharacters.push({
          lessonId,
          char: item.char,
          category: "一类",
          pinyin: item.pinyin,
          charOrder: 500 + index,
          sourceColumn: "写字表",
        });
      });

      parseUncoveredChars(row["词语未覆盖生字"]).forEach((item) => {
        lessonUncoveredCharacters.push({ lessonId, char: item.char, pinyin: item.pinyin, sourceFile, sourceRow });
      });

      parseTextbookWords(row["词语表"], row["词语表拼音"], filePath, lineNumber).forEach((item, index) => {
        addWord({
          lessonId,
          text: item.text,
          pinyin: item.pinyin,
          kind: "textbook",
          sourceFile,
          sourceRow,
          sourceColumn: "词语表",
          wordOrder: index,
        });
      });

      parseSupplementWords(row["未覆盖生字组词"], filePath, lineNumber).forEach((item, index) => {
        addWord({
          lessonId,
          text: item.text,
          pinyin: item.pinyin,
          kind: "supplement",
          sourceFile,
          sourceRow,
          sourceColumn: "未覆盖生字组词",
          targetChar: item.targetChar,
          wordOrder: 1000 + index,
        });
      });
    }
  }

  return {
    sourceFiles,
    lessons,
    lessonCharacters: uniqueBy(lessonCharacters, (row) => `${row.lessonId}\u0000${row.char}\u0000${row.category}`),
    lessonUncoveredCharacters: uniqueBy(lessonUncoveredCharacters, (row) => `${row.lessonId}\u0000${row.char}`),
    words: uniqueBy(words, (row) => row.id),
    wordCharacters: uniqueBy(wordCharacters, (row) => `${row.wordId}\u0000${row.char}\u0000${row.charOrder}`),
    lessonWords: uniqueBy(lessonWords, (row) => row.id),
  };
};

const parseClassicalTexts = (lessons) => {
  const sourceFiles = [];
  const classicalTexts = [];
  const classicalLines = [];
  const words = [];
  const wordCharacters = [];
  const lessonWords = [];
  const lessonsByScope = new Map();
  for (const lesson of lessons) {
    const key = `${lesson.grade}\u0000${lesson.term}`;
    lessonsByScope.set(key, [...(lessonsByScope.get(key) ?? []), lesson]);
  }

  const addClassicalWord = ({ lessonId, text, pinyin, kind, sourceFile, sourceRow, sourceColumn, wordOrder }) => {
    if (!lessonId) {
      return;
    }
    const wordId = stableId("word", [kind, sourceFile, sourceRow, text, pinyin]);
    if (!words.some((word) => word.id === wordId)) {
      words.push({ id: wordId, text, pinyin, wordKind: kind, sourceFile, sourceRow });
      hanChars(text).forEach((char, index) => {
        wordCharacters.push({ wordId, char, charOrder: index });
      });
    }
    lessonWords.push({
      id: stableId("lesson-word", [lessonId, wordId, sourceColumn, wordOrder]),
      lessonId,
      wordId,
      wordOrder,
      sourceColumn,
      targetChar: null,
    });
  };

  const findLesson = ({ grade, term, unitIndex, title }) => {
    const scoped = lessonsByScope.get(`${grade}\u0000${term}`) ?? [];
    const exact = scoped.find((lesson) => lesson.title === title);
    if (exact) {
      return exact;
    }
    return scoped.find((lesson) => lesson.unitIndex === unitIndex && lesson.isClassical) ?? null;
  };

  for (const fileName of readdirSync(classicalMdDir).filter((name) => name.endsWith(".md")).sort()) {
    const book = bookInfoFromFileName(fileName);
    if (!book) {
      continue;
    }
    const filePath = path.join(classicalMdDir, fileName);
    const sourceFile = toSourcePath(filePath);
    sourceFiles.push(sourceFileRow(filePath, "classical_text", book.grade, book.term));
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
    let unitIndex = null;
    let textOrder = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const unitMatch = lines[index].match(/^##\s+第([一二三四五六七八九十]+)单元/u);
      if (unitMatch) {
        unitIndex = parseChineseNumber(unitMatch[1]);
        continue;
      }
      const titleMatch = lines[index].match(/^###\s+(.+)$/u);
      if (!titleMatch) {
        continue;
      }

      const title = titleMatch[1].trim();
      const startLine = index + 1;
      const nextHeadingIndex = lines.findIndex((line, lineIndex) => lineIndex > index && /^##\s|^###\s/u.test(line));
      const endIndex = nextHeadingIndex >= 0 ? nextHeadingIndex : lines.length;
      const block = lines.slice(index + 1, endIndex);
      const pinyinIndex = block.findIndex((line) => line.trim() === "拼音：");
      if (pinyinIndex < 0) {
        throw new Error(`${sourceFile}:${startLine} missing classical pinyin block for ${title}`);
      }

      const titlePinyin = block.find((line) => line.startsWith("题目拼音："))?.replace(/^题目拼音：/u, "").trim() ?? "";
      const authorRaw = block.find((line) => line.startsWith("作者："))?.replace(/^作者：/u, "").trim() ?? null;
      const authorMatch = authorRaw?.match(/^(.+?)（(.+?)）$/u);
      const author = authorMatch ? authorMatch[1] : authorRaw;
      const dynasty = authorMatch ? authorMatch[2] : null;
      const sourceLabel = block.find((line) => line.startsWith("选自"))?.trim() ?? null;
      const pinyinLines = block.slice(pinyinIndex + 1).map((line) => line.trim()).filter(Boolean);
      const bodyCandidates = block
        .slice(0, pinyinIndex)
        .map((line, offset) => ({ text: line.trim().replace(/\s+$/u, ""), lineNumber: startLine + offset + 1 }))
        .filter((line) => hanPattern.test(line.text) && !line.text.startsWith("题目拼音") && !line.text.startsWith("作者：") && !line.text.startsWith("选自"));
      const bodyLines = bodyCandidates.slice(-pinyinLines.length);
      if (bodyLines.length !== pinyinLines.length) {
        throw new Error(`${sourceFile}:${startLine} classical line count mismatch for ${title}`);
      }

      const lesson = findLesson({ grade: book.grade, term: book.term, unitIndex, title });
      const textId = stableId("classical", [sourceFile, title, textOrder]);
      classicalTexts.push({
        id: textId,
        lessonId: lesson?.id ?? null,
        grade: book.grade,
        term: book.term,
        unitIndex,
        title,
        titlePinyin,
        author,
        dynasty,
        sourceLabel,
        sourceFile,
        textOrder,
      });
      addClassicalWord({
        lessonId: lesson?.id,
        text: title,
        pinyin: titlePinyin,
        kind: "classical_title",
        sourceFile,
        sourceRow: startLine,
        sourceColumn: "古诗词标题",
        wordOrder: 2000 + textOrder * 100,
      });

      bodyLines.forEach((line, lineIndex) => {
        classicalLines.push({
          textId,
          lineOrder: lineIndex,
          text: line.text,
          pinyin: pinyinLines[lineIndex],
        });
        addClassicalWord({
          lessonId: lesson?.id,
          text: line.text,
          pinyin: pinyinLines[lineIndex],
          kind: "classical_line",
          sourceFile,
          sourceRow: line.lineNumber,
          sourceColumn: "古诗词正文",
          wordOrder: 2001 + textOrder * 100 + lineIndex,
        });
      });

      textOrder += 1;
      index = endIndex - 1;
    }
  }

  return {
    sourceFiles,
    classicalTexts,
    classicalLines,
    words: uniqueBy(words, (row) => row.id),
    wordCharacters: uniqueBy(wordCharacters, (row) => `${row.wordId}\u0000${row.char}\u0000${row.charOrder}`),
    lessonWords: uniqueBy(lessonWords, (row) => row.id),
  };
};

const chooseCompanions = (lessonCharacters, lessonWords, wordsById) => {
  const textbookByLesson = new Map();
  const supplementByLessonChar = new Map();

  for (const lessonWord of lessonWords) {
    const word = wordsById.get(lessonWord.wordId);
    if (!word) {
      continue;
    }
    if (lessonWord.sourceColumn === "词语表") {
      textbookByLesson.set(lessonWord.lessonId, [...(textbookByLesson.get(lessonWord.lessonId) ?? []), { ...word, lessonWord }]);
    }
    if (lessonWord.sourceColumn === "未覆盖生字组词" && lessonWord.targetChar) {
      supplementByLessonChar.set(`${lessonWord.lessonId}\u0000${lessonWord.targetChar}`, { ...word, lessonWord });
    }
  }

  const distinctLessonChars = uniqueBy(lessonCharacters, (row) => `${row.lessonId}\u0000${row.char}`);
  return distinctLessonChars.flatMap((row) => {
    const textbookCandidate = (textbookByLesson.get(row.lessonId) ?? []).find((word) => hanChars(word.text).includes(row.char));
    const supplementCandidate = supplementByLessonChar.get(`${row.lessonId}\u0000${row.char}`);
    const chosen = textbookCandidate ?? supplementCandidate;
    if (!chosen) {
      return [];
    }
    return {
      lessonId: row.lessonId,
      char: row.char,
      wordId: chosen.id,
      word: chosen.text,
      pinyin: chosen.pinyin,
      companionRank: 1,
      source: textbookCandidate ? "textbook_word" : "supplement_word",
      sourceLessonId: row.lessonId,
    };
  });
};

const saveCatalog = (db, catalog) => {
  const insertMeta = db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)");
  const insertSource = db.prepare(
    `INSERT OR REPLACE INTO source_files (path, kind, grade, term, sha256, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertLesson = db.prepare(
    `INSERT INTO lessons
       (id, grade, term, term_name, unit_name, unit_index, section, lesson_number, sort_order, title, lesson_type, lesson_kind, is_classical, direct_dictation, source_file, source_row)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCharacter = db.prepare(
    `INSERT OR IGNORE INTO characters (char, first_pinyin, first_lesson_id, first_grade, first_term)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLessonCharacter = db.prepare(
    `INSERT INTO lesson_characters (lesson_id, char, category, pinyin, char_order, source_column)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertWord = db.prepare(
    `INSERT INTO words (id, text, pinyin, word_kind, source_file, source_row)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertWordCharacter = db.prepare("INSERT INTO word_characters (word_id, char, char_order) VALUES (?, ?, ?)");
  const insertLessonWord = db.prepare(
    `INSERT INTO lesson_words (id, lesson_id, word_id, word_order, source_column, target_char)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertUncovered = db.prepare(
    `INSERT INTO lesson_uncovered_characters (lesson_id, char, pinyin, source_file, source_row)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertCompanion = db.prepare(
    `INSERT INTO char_companion_words (lesson_id, char, word_id, word, pinyin, companion_rank, source, source_lesson_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClassicalText = db.prepare(
    `INSERT INTO classical_texts
       (id, lesson_id, grade, term, unit_index, title, title_pinyin, author, dynasty, source_label, source_file, text_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClassicalLine = db.prepare("INSERT INTO classical_lines (text_id, line_order, text, pinyin) VALUES (?, ?, ?, ?)");

  db.exec("BEGIN");
  try {
    insertMeta.run("schema_version", "2");
    insertMeta.run("source", "md");
    insertMeta.run("rebuilt_at", now);
    for (const source of catalog.sourceFiles) {
      insertSource.run(source.path, source.kind, source.grade, source.term, source.sha256, now);
    }
    for (const lesson of catalog.lessons) {
      insertLesson.run(
        lesson.id,
        lesson.grade,
        lesson.term,
        lesson.termName,
        lesson.unitName,
        lesson.unitIndex,
        lesson.section,
        lesson.lessonNumber,
        lesson.sortOrder,
        lesson.title,
        lesson.lessonType,
        lesson.lessonKind,
        lesson.isClassical ? 1 : 0,
        lesson.directDictation ? 1 : 0,
        lesson.sourceFile,
        lesson.sourceRow,
      );
    }
    for (const row of catalog.lessonCharacters.sort((a, b) => a.lessonId.localeCompare(b.lessonId) || a.charOrder - b.charOrder)) {
      const lesson = catalog.lessonsById.get(row.lessonId);
      insertCharacter.run(row.char, row.pinyin, row.lessonId, lesson?.grade ?? null, lesson?.term ?? null);
      insertLessonCharacter.run(row.lessonId, row.char, row.category, row.pinyin, row.charOrder, row.sourceColumn);
    }
    for (const word of catalog.words) {
      insertWord.run(word.id, word.text, word.pinyin, word.wordKind, word.sourceFile, word.sourceRow);
    }
    for (const row of catalog.wordCharacters) {
      insertWordCharacter.run(row.wordId, row.char, row.charOrder);
    }
    for (const row of catalog.lessonWords) {
      insertLessonWord.run(row.id, row.lessonId, row.wordId, row.wordOrder, row.sourceColumn, row.targetChar);
    }
    for (const row of catalog.lessonUncoveredCharacters) {
      insertUncovered.run(row.lessonId, row.char, row.pinyin, row.sourceFile, row.sourceRow);
    }
    for (const row of catalog.companions) {
      insertCompanion.run(row.lessonId, row.char, row.wordId, row.word, row.pinyin, row.companionRank, row.source, row.sourceLessonId);
    }
    for (const row of catalog.classicalTexts) {
      insertClassicalText.run(
        row.id,
        row.lessonId,
        row.grade,
        row.term,
        row.unitIndex,
        row.title,
        row.titlePinyin,
        row.author,
        row.dynasty,
        row.sourceLabel,
        row.sourceFile,
        row.textOrder,
      );
    }
    for (const row of catalog.classicalLines) {
      insertClassicalLine.run(row.textId, row.lineOrder, row.text, row.pinyin);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const rebuild = () => {
  if (projectRoot !== root) {
    throw new Error(`Project root mismatch: ${projectRoot} !== ${root}`);
  }
  mkdirSync(path.dirname(catalogDbPath), { recursive: true });
  mkdirSync(path.dirname(learningDbPath), { recursive: true });
  if (existsSync(catalogDbPath)) {
    rmSync(catalogDbPath);
  }
  if (resetLearning && existsSync(learningDbPath)) {
    rmSync(learningDbPath);
  }

  const wordCatalog = buildWordCatalog();
  const classicalCatalog = parseClassicalTexts(wordCatalog.lessons);
  const allSourceFiles = uniqueBy([...wordCatalog.sourceFiles, ...classicalCatalog.sourceFiles], (row) => row.path);
  const allWords = uniqueBy([...wordCatalog.words, ...classicalCatalog.words], (row) => row.id);
  const allWordCharacters = uniqueBy([...wordCatalog.wordCharacters, ...classicalCatalog.wordCharacters], (row) => `${row.wordId}\u0000${row.char}\u0000${row.charOrder}`);
  const allLessonWords = uniqueBy([...wordCatalog.lessonWords, ...classicalCatalog.lessonWords], (row) => row.id);
  const wordsById = new Map(allWords.map((word) => [word.id, word]));
  const companions = chooseCompanions(wordCatalog.lessonCharacters, allLessonWords, wordsById);

  const lessonsById = new Map(wordCatalog.lessons.map((lesson) => [lesson.id, lesson]));
  const catalog = {
    sourceFiles: allSourceFiles,
    lessons: wordCatalog.lessons,
    lessonsById,
    lessonCharacters: wordCatalog.lessonCharacters,
    lessonUncoveredCharacters: wordCatalog.lessonUncoveredCharacters,
    words: allWords,
    wordCharacters: allWordCharacters,
    lessonWords: allLessonWords,
    companions,
    classicalTexts: classicalCatalog.classicalTexts,
    classicalLines: classicalCatalog.classicalLines,
  };

  const catalogDb = new DatabaseSync(catalogDbPath);
  catalogDb.exec(catalogSchemaSql);
  saveCatalog(catalogDb, catalog);

  const learningDb = new DatabaseSync(learningDbPath);
  learningDb.exec(learningSchemaSql);
  ensureDefaultStudent(learningDb, catalogDb, defaultStudentId);
  if (!resetLearning) {
    learningDb.prepare("DELETE FROM unsuitable_words").run();
  }

  const summary = {
    catalogDb: catalogDbPath,
    learningDb: learningDbPath,
    learningReset: resetLearning,
    unsuitableWordsCleared: true,
    sourceFiles: catalogDb.prepare("SELECT COUNT(*) AS count FROM source_files").get().count,
    lessons: catalogDb.prepare("SELECT COUNT(*) AS count FROM lessons").get().count,
    lessonsWithChars: catalogDb.prepare("SELECT COUNT(*) AS count FROM (SELECT DISTINCT lesson_id FROM lesson_characters)").get().count,
    lessonCharacters: catalogDb.prepare("SELECT COUNT(*) AS count FROM lesson_characters").get().count,
    distinctLessonCharacters: catalogDb.prepare("SELECT COUNT(*) AS count FROM (SELECT DISTINCT lesson_id, char FROM lesson_characters)").get().count,
    characters: catalogDb.prepare("SELECT COUNT(*) AS count FROM characters").get().count,
    words: catalogDb.prepare("SELECT COUNT(*) AS count FROM words").get().count,
    textbookWords: catalogDb.prepare("SELECT COUNT(*) AS count FROM lesson_words WHERE source_column = '词语表'").get().count,
    supplementWords: catalogDb.prepare("SELECT COUNT(*) AS count FROM lesson_words WHERE source_column = '未覆盖生字组词'").get().count,
    companions: catalogDb.prepare("SELECT COUNT(*) AS count FROM char_companion_words").get().count,
    uncoveredCharacters: catalogDb.prepare("SELECT COUNT(*) AS count FROM lesson_uncovered_characters").get().count,
    classicalTexts: catalogDb.prepare("SELECT COUNT(*) AS count FROM classical_texts").get().count,
    classicalLines: catalogDb.prepare("SELECT COUNT(*) AS count FROM classical_lines").get().count,
    learningStudents: learningDb.prepare("SELECT COUNT(*) AS count FROM students").get().count,
  };
  catalogDb.close();
  learningDb.close();
  console.log(JSON.stringify(summary, null, 2));
};

try {
  rebuild();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
