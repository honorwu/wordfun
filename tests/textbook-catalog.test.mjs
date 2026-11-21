import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { defaultCatalogDatabasePath, defaultStudentId, getLessons, getState, openLearningDatabase, saveState } from "../server/db.mjs";
import { createCatalogService } from "../server/services/catalog.mjs";
import { buildBookCharacterIndex, characterMastery, groupCharacterMastery, learnedTextbookChars } from "../shared/domain/characterMastery.ts";
import { getScreeningTargetChars } from "../shared/domain/practice.ts";
import { createTextbookHintMask } from "../src/features/practice/titleMask.ts";

test("新词库仅包含五册材料，课次、册末词和可用提示完整对应", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const books = db.prepare(`SELECT grade, term, COUNT(*) AS count FROM textbook_words words
      JOIN lessons ON lessons.id = words.lesson_id GROUP BY grade, term ORDER BY grade, term`).all();
    assert.deepEqual(books.map((row) => [row.grade, row.term, row.count]), [
      [2, 1, 229], [2, 2, 297], [3, 1, 272], [3, 2, 271], [4, 1, 220],
    ]);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT grade || '-' || term) AS count FROM lessons").get().count, 5);
    const context = db.prepare("SELECT COUNT(*) AS total, COUNT(hint_text) AS ready FROM textbook_word_contexts").get();
    assert.equal(context.total, 1289);
    assert.equal(context.ready, 1249);
    const supplement = db.prepare(`SELECT w.text AS word, w.pinyin, c.hint_text
      FROM lesson_words lw JOIN lessons l ON l.id = lw.lesson_id JOIN words w ON w.id = lw.word_id
      JOIN lesson_word_targets t ON t.lesson_word_id = lw.id
      JOIN lesson_supplement_contexts c ON c.lesson_word_id = lw.id
      WHERE l.title = ? AND t.char = ?`);
    const fortress = supplement.get("长城", "垒");
    assert.equal(fortress.word, "堡垒");
    assert.equal(fortress.pinyin, "bǎo lěi");
    assert.match(fortress.hint_text, /是屯兵的〔　〕/u);
    const screen = supplement.get("夜间飞行的秘密", "屏");
    assert.equal(screen.word, "荧光屏");
    assert.equal(screen.pinyin, "yíng guāng píng");
    assert.match(screen.hint_text, /雷达.*〔　〕上/u);
    const mix = supplement.get("肥皂泡", "和");
    assert.equal(mix.word, "和弄");
    assert.equal(mix.pinyin, "huò nòng");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lesson_word_targets").get().n, 1617);
    assert.equal(db.prepare("SELECT unit_index FROM lessons WHERE title = ?").get("一匹出色的马").unit_index, 2);
    assert.ok(db.prepare("SELECT 1 FROM lessons WHERE title = ?").get("曹冲称象"));
    assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
    const catalog = createCatalogService(db);
    const lesson = catalog.summaries().find((row) => row.title === "小蝌蚪找妈妈");
    const items = catalog.practice({ grade: lesson.grade, lessonId: lesson.id }, {}).items;
    assert.equal(items[0].word.text, "看见");
    assert.match(items[0].word.textbookHint, /〔　〕/u);
    assert.equal(catalog.practice({ grade: 2, lessonId: catalog.summaries().find((row) => row.title === "田家四季歌").id }, {})
      .items.find((item) => item.word.text === "四季").word.textbookHint, undefined);
    assert.ok(catalog.characterBooks().find((book) => book.grade === 2 && book.term === 1).characters.见.includes("看见"));
  } finally { db.close(); }
});

test("教材句子保留本题空位，其他目标字用带声调拼音；多音字优先使用匹配词语的读音", () => {
  const words = [
    { text: "漆", pinyin: "qī" },
    { text: "栏杆", pinyin: "lán gān" },
    { text: "银行", pinyin: "yín háng" },
    { text: "行走", pinyin: "xíng zǒu" },
  ];
  const mask = createTextbookHintMask(words, new Set(["漆", "栏", "杆", "行"]));
  assert.equal(mask("绿漆的〔　〕，红漆的栏杆，一眼望不到头。"), "绿 qī 的〔　〕，红 qī 的 lán gān，一眼望不到头。");
  assert.equal(mask("从银行前行走，〔　〕。"), "从银 háng 前 xíng 走，〔　〕。");
  assert.equal(mask("〔　〕，行。"), "〔　〕，…。");
});

test("当课和历史复习读取已审阅的补充题，保留教材提示并遵守错字间隔", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const catalog = createCatalogService(db);
    const lessons = catalog.summaries();
    const lesson = lessons.find((entry) => entry.title === "朱德的扁担");
    const current = catalog.practice({ grade: lesson.grade, lessonId: lesson.id }, {});
    const names = current.items.filter(({ word }) => word.text === "朱德");
    assert.equal(names.length, 1);
    assert.deepEqual(new Set(names[0].word.chars), new Set(["朱", "德"]));
    assert.match(names[0].word.textbookHint, /〔　〕同志/u);
    const garden = lessons.find((entry) => entry.grade === 2 && entry.unit === 1 && entry.title === "语文园地八");
    const snake = catalog.practice({ grade: garden.grade, lessonId: garden.id }, {}).items.find(({ word }) => word.text === "蛇");
    assert.match(snake.word.textbookHint, /猩猩.*〔　〕.*白鹤/u);

    const next = lessons[lessons.indexOf(lesson) + 1];
    const progress = { grade: next.grade, lessonId: next.id };
    const learned = getScreeningTargetChars(getLessons(db), progress);
    const mastered = Object.fromEntries(learned.map((char) => [char, { attempts: 1, mistakes: 0, streak: 1 }]));
    const recentlyMissed = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date().toISOString() };
    assert.equal(catalog.practice(progress, { ...mastered, 德: recentlyMissed }, "history").items.length, 0);
    const due = { ...recentlyMissed, lastReviewedAt: new Date(Date.now() - 6 * 86400000).toISOString() };
    const history = catalog.practice(progress, { ...mastered, 德: due }, "history");
    assert.deepEqual(history.items.map(({ word }) => word.text), ["朱德"]);
    assert.deepEqual(history.items[0].word, names[0].word);
    assert.match(history.items[0].word.textbookHint, /〔　〕同志/u);
  } finally { db.close(); }
});

test("根据原有计分证据区分四类字，不把零次作答算成掌握", () => {
  const outcome = (attempts, mistakes) => characterMastery({ attempts, mistakes, streak: 0 });
  assert.equal(characterMastery(), "unreviewed");
  assert.equal(outcome(0, 0), "unreviewed");
  assert.equal(outcome(1, 0), "mastered");
  assert.equal(outcome(2, 1), "pending");
  assert.equal(outcome(3, 1), "corrected");
});

test("四上语文园地六优先考词语表，再用拉萨、哈尼等教材原词", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const catalog = createCatalogService(db);
    const lessons = catalog.summaries();
    const garden = lessons.find((item) => item.grade === 4 && item.unit === 1 && item.title === "语文园地六");
    const progress = { grade: garden.grade, lessonId: garden.id };
    const current = catalog.practice(progress, {});
    assert.deepEqual(current.items.slice(0, 3).map(({ word }) => word.text), ["陵寝", "景观", "丝绸"]);
    const byText = new Map(current.items.map(({ word }) => [word.text, word]));
    assert.deepEqual(new Set(byText.keys()), new Set(["陵寝", "景观", "丝绸", "拉萨", "大昭寺", "都江堰", "哈尼", "长廊"]));
    assert.equal(byText.get("拉萨").pinyin, "lā sà");
    assert.match(byText.get("拉萨").textbookHint, /〔　〕布达拉宫/u);
    assert.match(byText.get("长廊").textbookHint, /这条〔　〕有七百多米长/u);
    assert.ok(current.items.slice(3).every(({ word }) => word.textbookHint?.includes("〔　〕")));

    const next = lessons[lessons.indexOf(garden) + 1];
    const historyProgress = { grade: next.grade, lessonId: next.id };
    const learned = getScreeningTargetChars(getLessons(db), historyProgress);
    const mastered = Object.fromEntries(learned.filter((char) => char !== "萨").map((char) => [char, { attempts: 1, mistakes: 0, streak: 1 }]));
    const { items } = catalog.practice(historyProgress, mastered, "history");
    assert.deepEqual(items.map(({ word }) => word.text), ["拉萨"]);
    assert.deepEqual(items[0].word, byText.get("拉萨"));
    assert.match(items[0].word.textbookHint, /〔　〕布达拉宫/u);
  } finally { db.close(); }
});

test("家长看板跨册去重，按字首次出现的课次区分已学未测和后续生字", () => {
  const lesson = (id, grade, unit, number, chars) => ({
    id, grade, unit, number, title: id, words: chars.map((char) => ({ chars: [char] })),
  });
  const previous = lesson("previous", 2, 1, 1, ["山", "河"]);
  const current = lesson("current", 4, 1, 1, ["湖", "海"]);
  const future = lesson("future", 4, 1, 2, ["山", "峰"]);
  const books = buildBookCharacterIndex([future, previous, current]);
  const charStats = {
    山: { attempts: 1, mistakes: 0, streak: 1 },
    河: { attempts: 1, mistakes: 1, streak: 0 },
    海: { attempts: 3, mistakes: 1, streak: 2 },
    峰: { attempts: 1, mistakes: 1, streak: 0 },
  };
  const all = groupCharacterMastery(books, current, charStats).groups;
  assert.deepEqual(all, { mastered: ["山"], corrected: ["海"], pending: ["河"], unreviewed: ["湖"], future: ["峰"] });
  const fourth = groupCharacterMastery(books, current, charStats, books.find((entry) => entry.grade === 4)).groups;
  assert.deepEqual(fourth, { ...all, pending: [] });
});

test("教材库里的已学字等于当课和历史可考的字词目标之并集，不混入古诗全文", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const catalog = createCatalogService(db);
    const lessons = getLessons(db);
    const books = catalog.characterBooks();
    for (const lesson of [lessons[0], lessons.find((row) => row.title === "颐和园"), lessons.find((row) => row.lessonKind === "classical_poetry")]) {
      const progress = { grade: lesson.grade, lessonId: lesson.id };
      const currentChars = lesson.lessonKind === "classical_poetry" ? [] : catalog.practice(progress, {}).items.flatMap((item) => item.word.chars);
      const historyChars = getScreeningTargetChars(lessons, progress);
      assert.deepEqual(learnedTextbookChars(books, lesson), new Set([...historyChars, ...currentChars]), lesson.title);
    }
  } finally { db.close(); }
});

test("只初始化教材范围内的逐字计分，不带入课外字、旧场次或错题证据", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ziqu-mastery-"));
  const source = path.join(directory, "source.sqlite");
  const destination = path.join(directory, "new.sqlite");
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const catalog = createCatalogService(catalogDb);
    const current = catalog.summaries().find((lesson) => lesson.title === "颐和园");
    const oldDatabase = openLearningDatabase(source);
    try {
      saveState(oldDatabase, {
        progress: { grade: 4, lessonId: "old-lesson" },
        charStats: {
          见: { attempts: 3, mistakes: 1, streak: 2, lastReviewedAt: "2020-01-01", wrongWordTexts: ["看见"] },
          坦: { attempts: 1, mistakes: 1, streak: 0 },
          𰻞: { attempts: 1, mistakes: 0, streak: 1 },
        },
        wordStats: { old: { attempts: 1, mistakes: 1, streak: 0 } },
        logs: [{ id: "old-log", date: "2020-01-01", wordIds: ["old"], wrongWordIds: ["old"] }],
      }, defaultStudentId);
    } finally { oldDatabase.close(); }
    const seed = () => spawnSync(process.execPath, ["scripts/seed-character-mastery.mjs", source, destination, "颐和园"], {
      encoding: "utf8", env: { ...process.env, ZIQU_CATALOG_DB_PATH: defaultCatalogDatabasePath },
    });
    const initialized = seed();
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).imported, 2);
    assert.notEqual(seed().status, 0);
    const learning = openLearningDatabase(destination);
    try {
      const state = getState(learning, catalogDb);
      assert.deepEqual(state.progress, { grade: 4, lessonId: current.id });
      assert.deepEqual(state.logs, []);
      assert.deepEqual(state.wordStats, {});
      assert.deepEqual(state.wordIssues, []);
      assert.equal(characterMastery(state.charStats.见), "corrected");
      assert.equal(characterMastery(state.charStats.坦), "pending");
      assert.equal(state.charStats.𰻞, undefined);
      assert.equal(characterMastery(state.charStats.看), "unreviewed");
      assert.deepEqual(state.charStats.见.wrongWordTexts, []);
      assert.equal(state.charStats.见.lastReviewedAt, undefined);
      assert.ok(catalog.practice(state.progress, state.charStats, "history").items.some((item) => item.word.chars.includes("坦")));
    } finally { learning.close(); }
  } finally { catalogDb.close(); rmSync(directory, { recursive: true, force: true }); }
});
