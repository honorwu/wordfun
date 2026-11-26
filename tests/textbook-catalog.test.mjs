import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { defaultCatalogDatabasePath, getLessons } from "../server/db.mjs";
import { createCatalogService } from "../server/services/catalog.mjs";
import { buildBookCharacterIndex, characterMastery, groupCharacterMastery, learnedTextbookChars } from "../shared/domain/characterMastery.ts";
import { hanChars } from "../shared/domain/characters.ts";
import { generateCurrentLessonPractice, generatePoetryPractice, getScreeningQuestions, getScreeningTargetChars } from "../shared/domain/practice.ts";
import { createRoundTextMask, maskedRoundHints } from "../src/features/practice/hintMask.ts";

test("新词库仅包含五册材料，课次、册末词和可用提示完整对应", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(tables.map(({ name }) => name), ["catalog_meta", "lesson_characters", "lessons", "questions", "source_files"]);
    const books = db.prepare(`SELECT grade, term, COUNT(*) AS count FROM questions q
      JOIN lessons l ON l.id = q.lesson_id WHERE q.kind = 'textbook' GROUP BY grade, term ORDER BY grade, term`).all();
    assert.deepEqual(books.map((row) => [row.grade, row.term, row.count]), [
      [2, 1, 229], [2, 2, 297], [3, 1, 272], [3, 2, 271], [4, 1, 220],
    ]);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT grade || '-' || term) AS count FROM lessons").get().count, 5);
    const context = db.prepare("SELECT COUNT(*) AS total, COUNT(hint_text) AS ready FROM questions WHERE kind = 'textbook'").get();
    assert.equal(context.total, 1289);
    assert.equal(context.ready, 1289);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM questions WHERE kind != 'poem' AND hint_text IS NULL").get().count, 0);
    const supplement = db.prepare(`SELECT q.text AS word, q.pinyin, q.hint_text, q.target_chars, q.source_file, q.source_row, q.source_details
      FROM questions q JOIN lessons l ON l.id = q.lesson_id
      WHERE q.kind = 'supplement' AND l.title = ? AND EXISTS (SELECT 1 FROM json_each(q.target_chars) WHERE value = ?)`);
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
    const health = supplement.get("难忘的泼水节", "健");
    assert.equal(health.word, "健康");
    assert.deepEqual(JSON.parse(health.target_chars), ["健", "康"]);
    assert.match(health.source_file, /难忘的泼水节/);
    assert.equal(health.source_row, JSON.parse(health.source_details).source_rows[0]);
    const targets = db.prepare("SELECT SUM(json_array_length(target_chars)) AS n FROM questions WHERE kind = 'supplement'").get();
    assert.equal(targets.n, 1617);
    assert.equal(db.prepare("SELECT unit_index FROM lessons WHERE title = ?").get("一匹出色的马").unit_index, 2);
    assert.ok(db.prepare("SELECT 1 FROM lessons WHERE title = ?").get("曹冲称象"));
    assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
    const catalog = createCatalogService(db);
    const lesson = catalog.summaries().find((row) => row.title === "小蝌蚪找妈妈");
    const items = catalog.practice({ grade: lesson.grade, lessonId: lesson.id }, {}).items;
    assert.equal(items[0].word.text, "看见");
    assert.match(items[0].word.textbookHint, /〔　〕/u);
    const seasons = catalog.summaries().find((row) => row.title === "田家四季歌");
    const fourSeasons = catalog.practice({ grade: seasons.grade, lessonId: seasons.id }, {}).items.find(({ word }) => word.text === "四季").word;
    assert.equal(fourSeasons.textbookHint, "春、夏、秋、冬是一年的〔　〕。");
    const reviewedContext = db.prepare("SELECT source_details FROM questions WHERE id = ?").get(fourSeasons.id);
    assert.equal(JSON.parse(reviewedContext.source_details).hint_source.kind, "据教材编写");
    const fogLesson = catalog.summaries().find((row) => row.title === "雾在哪里");
    const fogItems = catalog.practice({ grade: fogLesson.grade, lessonId: fogLesson.id }, {}).items;
    assert.ok(fogItems.every(({ word }) => word.text !== "雾把海岸" && word.id !== `${fogLesson.id}-char-雾`));
    const fog = fogItems.find(({ word }) => word.text === "雾").word;
    assert.equal(fog.pinyin, "wù");
    assert.deepEqual(fog.chars, ["雾"]);
    assert.equal(fog.textbookHint, "从前有一片〔　〕，他是个淘气的孩子。");
    const book = buildBookCharacterIndex(getLessons(db)).find((entry) => entry.grade === 2 && entry.term === 1);
    assert.ok(book.characters.见.includes("看见"));
  } finally { db.close(); }
});

test("当课和历史用拼音遮住语境中的本轮答案字，保留 SQLite 保存的原提示", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const catalog = createCatalogService(db);
    const lessons = catalog.summaries();
    const lessonIndex = lessons.findIndex((lesson) => lesson.title === "小蝌蚪找妈妈");
    const current = lessons[lessonIndex];
    const next = lessons[lessonIndex + 1];
    const currentItems = catalog.practice({ grade: current.grade, lessonId: current.id }, {}).items;
    const eyes = currentItems.find(({ word }) => word.text === "眼睛").word;
    const head = currentItems.find(({ word }) => word.text === "头顶").word;
    const stored = db.prepare("SELECT hint_text FROM questions WHERE id = ?").get(eyes.id).hint_text;
    const storedHead = db.prepare("SELECT hint_text FROM questions WHERE id = ?").get(head.id).hint_text;
    assert.equal(stored, "你们的妈妈头顶上有两只大〔　〕");
    assert.equal(storedHead, "你们的妈妈〔　〕上有两只大眼睛");

    const maskedCurrent = maskedRoundHints(currentItems);
    assert.equal(maskedCurrent.get(eyes.id), "你们的妈妈 tóu dǐng shàng 有 liǎng 只大〔　〕");
    assert.equal(maskedCurrent.get(head.id), "你们的妈妈〔　〕shàng 有 liǎng 只大 yǎn jing");
    assert.equal(eyes.textbookHint, stored);
    assert.equal(head.textbookHint, storedHead);

    const progress = { grade: next.grade, lessonId: next.id };
    const mastered = Object.fromEntries(getScreeningQuestions(getLessons(db), progress)
      .filter(({ id }) => id !== eyes.id && id !== head.id)
      .map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    const pair = catalog.practice(progress, mastered, "history").items;
    assert.deepEqual(new Map(pair.map(({ word }) => [word.id, word.textbookHint])), new Map([[eyes.id, stored], [head.id, storedHead]]));
    assert.deepEqual(maskedRoundHints(pair), new Map([
      [eyes.id, "你们的妈妈 tóu dǐng 上有两只大〔　〕"],
      [head.id, "你们的妈妈〔　〕上有两只大 yǎn jing"],
    ]));
    assert.ok(pair.every(({ historyGroup }) => historyGroup === "recent" || historyGroup === "basic"));

    const single = catalog.practice(progress, { ...mastered, [head.id]: { attempts: 1, mistakes: 0, streak: 1 } }, "history").items;
    assert.deepEqual(single.map(({ word }) => [word.id, word.textbookHint]), [[eyes.id, stored]]);
    assert.equal(maskedRoundHints(single).size, 0);
    assert.equal(db.prepare("SELECT hint_text FROM questions WHERE id = ?").get(eyes.id).hint_text, stored);
  } finally { db.close(); }
});

test("重叠和反复出现的题词都转成拼音，保留原挖空、标点和空白", () => {
  const item = (text, pinyin, textbookHint, lessonId = "other-lesson") => ({
    word: { id: text, text, pinyin, textbookHint, lessonId },
    score: 0,
    reasons: [],
  });
  const hint = "看山河流向远方，　山河流  经村边。云掠过云彩，𠮷，哈哈哈。山坡和河边。山〔　〕河，另一处〔　〕。";
  const items = [
    item("纸鸢", "zhǐ yuān", hint, "current-lesson"),
    item("山河", "shān hé"),
    item("河流", "hé liú"),
    item("云", "yún", "天上飘着一朵〔　〕。"),
    item("𠮷", "jí"),
    item("哈哈", "hā hā"),
  ];

  assert.deepEqual(maskedRoundHints(items), new Map([
    ["纸鸢", "看 shān hé liú 向远方，　shān hé liú  经村边。yún 掠过 yún 彩，jí，hā hā hā。shān 坡和 hé 边。shān〔　〕hé，另一处〔　〕。"],
  ]));
  assert.equal(items[0].word.textbookHint, hint);
});

test("跨课题目共用遮字范围，散落字按语境读音，整词沿用题目读音", () => {
  const words = [
    { id: "great-wall", lessonId: "great-wall-lesson", text: "长城", pinyin: "cháng chéng" },
    { id: "schoolbag", lessonId: "another-lesson", text: "书包", pinyin: "shū bāo", textbookHint: "长大后，我背着〔　〕去长城。" },
  ];
  const mask = createRoundTextMask(words);
  assert.match(mask("长大以后的书包", "another-lesson"), /^zhǎng 大以后的 shū bāo$/u);
  assert.equal(maskedRoundHints(words.map((word) => ({ word, score: 0, reasons: [] }))).get("schoolbag"),
    "zhǎng 大后，我背着〔　〕去 cháng chéng。");
  assert.equal(words[1].textbookHint, "长大后，我背着〔　〕去长城。");
});

test("缺少拼音的答案字仍隐藏，原挖空和标点保留", () => {
  const mask = createRoundTextMask([{ id: "rare", lessonId: "lesson", text: "𠮷", pinyin: "" }]);
  const shown = mask("见〔　〕𠮷，未见。", "lesson");
  assert.ok(!shown.includes("𠮷"));
  assert.match(shown, /^见〔　〕.*，未见。$/u);
});

test("牛和鹅的语境遮住所有本轮答案字，保留原挖空", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const lessons = getLessons(db);
    const lesson = lessons.find(({ grade, unit, title }) => grade === 4 && unit === 1 && title === "牛和鹅");
    const items = generateCurrentLessonPractice(lessons, { progress: { lessonId: lesson.id } });
    const words = items.map(({ word }) => word);
    const byText = new Map(words.map((word) => [word.text, word]));
    const hints = maskedRoundHints(items);
    const answerChars = new Set(words.flatMap(({ text }) => hanChars(text)));
    const goose = byText.get("大白鹅");
    assert.deepEqual(goose.chars, ["鹅"]);
    assert.equal(createRoundTextMask(words)(lesson.title, lesson.id), "牛和 é");
    const gooseContexts = words.filter(({ textbookHint }) => textbookHint.includes("鹅"));
    assert.deepEqual(gooseContexts.map(({ text }) => text), ["助威", "纷纷", "竖起", "竟", "胸", "把握住", "酒瓶"]);
    assert.ok(gooseContexts.every(({ id }) => !hints.get(id).includes("鹅")));
    assert.match(hints.get(byText.get("竖起").id), /〔　〕tóu 来/u);
    assert.match(hints.get(byText.get("酒瓶").id), /〔　〕zi 一样/u);
    for (const [question, chars] of [
      ["助威", "鹅大"], ["故意", "子"], ["虽然", "可"], ["竖起", "鹅头到子大"],
    ]) {
      const { id, textbookHint } = byText.get(question);
      for (const char of chars) {
        assert.ok(textbookHint.includes(char), `${question}的原语境应包含${char}`);
        assert.ok(!hints.get(id).includes(char), `${question}的默写提示应遮住${char}`);
      }
    }
    for (const { id, text, textbookHint } of words) {
      const shown = hints.get(id) ?? textbookHint;
      assert.deepEqual(hanChars(shown).filter((char) => answerChars.has(char)), [], text);
      assert.equal(shown.split("〔　〕").length, textbookHint.split("〔　〕").length, text);
    }
  } finally { db.close(); }
});

test("全词库各课的标题和语境不显示本轮答案字，古诗包含诗题、朝代和作者", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const lessons = getLessons(db);
    for (const lesson of lessons) {
      const items = lesson.lessonKind === "classical_poetry"
        ? generatePoetryPractice(lesson)
        : generateCurrentLessonPractice(lessons, { progress: { lessonId: lesson.id } });
      const words = items.map(({ word }) => word);
      const answerChars = new Set(words.flatMap(({ text }) => hanChars(text)));
      const mask = createRoundTextMask(words);
      const assertMasked = (text, description) =>
        assert.deepEqual(hanChars(text).filter((char) => answerChars.has(char)), [], description);
      assertMasked(mask(lesson.title, lesson.id), lesson.title);
      for (const poem of lesson.classicalTexts ?? []) {
        assertMasked(mask(poem.title, lesson.id), poem.title);
        const byline = [poem.dynasty, poem.author].filter(Boolean).join(" · ");
        assert.deepEqual(hanChars(mask(byline, lesson.id)), [], byline);
      }
      for (const { word } of items) {
        if (word.textbookHint) assertMasked(mask(word.textbookHint, word.lessonId), word.text);
      }
    }
  } finally { db.close(); }
});

test("历史同卷出现同形异音的题词，语境优先使用本课读音", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const catalog = createCatalogService(db);
    const lessons = catalog.summaries();
    const selected = lessons.find((lesson) => lesson.title === "铺满金色巴掌的水泥道");
    const progress = { grade: selected.grade, lessonId: selected.id };
    const previous = getScreeningQuestions(getLessons(db), progress);
    const mark = previous.find(({ lessonTitle, text }) => lessonTitle === "不懂就要问" && text === "圈");
    const pen = previous.find(({ lessonTitle, text }) => lessonTitle === "寓言二则" && text === "圈");
    const plug = previous.find(({ lessonTitle, text }) => lessonTitle === "寓言二则" && text === "堵上");
    assert.equal(mark.pinyin, "quān");
    assert.equal(pen.pinyin, "juàn");
    const selectedIds = new Set([mark.id, pen.id, plug.id]);
    const mastered = Object.fromEntries(previous
      .filter(({ id }) => !selectedIds.has(id))
      .map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    const { items } = catalog.practice(progress, mastered, "history");
    assert.deepEqual(new Set(items.map(({ word }) => word.id)), selectedIds);

    const expectedHint = "他赶紧〔　〕那个窟窿，把羊 juàn 修得结结实实的。";
    assert.equal(maskedRoundHints(items).get(plug.id), expectedHint);
    assert.equal(maskedRoundHints([...items].reverse()).get(plug.id), expectedHint);
    assert.equal(plug.textbookHint, "他赶紧〔　〕那个窟窿，把羊圈修得结结实实的。");
  } finally { db.close(); }
});

test("当课和历史复习读取同一已审阅的补充题，错题按题等待复习间隔", () => {
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
    const pastQuestions = getScreeningQuestions(getLessons(db), progress);
    const mastered = Object.fromEntries(pastQuestions.map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    const questionId = names[0].word.id;
    const recentlyMissed = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date().toISOString() };
    const cooling = catalog.practice(progress, { ...mastered, [questionId]: recentlyMissed }, "history");
    assert.equal(cooling.stats.waitingReview, 1);
    assert.deepEqual(cooling.items, []);
    const due = { ...recentlyMissed, lastReviewedAt: new Date(Date.now() - 6 * 86400000).toISOString() };
    const history = catalog.practice(progress, { ...mastered, [questionId]: due }, "history");
    assert.equal(history.items.length, 1);
    const [mistake] = history.items;
    assert.equal(mistake.historyGroup, "mistake");
    assert.deepEqual(mistake.word, names[0].word);
    assert.match(mistake.word.textbookHint, /〔　〕同志/u);
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
    const questions = getScreeningQuestions(getLessons(db), historyProgress).filter(({ id }) => id !== byText.get("拉萨").id);
    const mastered = Object.fromEntries(questions.map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    const { items } = catalog.practice(historyProgress, mastered, "history");
    assert.deepEqual(items.map(({ word }) => word), [byText.get("拉萨")]);
    assert.match(items[0].word.textbookHint, /〔　〕布达拉宫/u);
    assert.ok(items.every(({ historyGroup }) => historyGroup === "recent" || historyGroup === "basic"));
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
    const books = buildBookCharacterIndex(lessons);
    for (const lesson of [lessons[0], lessons.find((row) => row.title === "颐和园"), lessons.find((row) => row.lessonKind === "classical_poetry")]) {
      const progress = { grade: lesson.grade, lessonId: lesson.id };
      const currentChars = lesson.lessonKind === "classical_poetry" ? [] : catalog.practice(progress, {}).items.flatMap((item) => item.word.chars);
      const historyChars = getScreeningTargetChars(lessons, progress);
      assert.deepEqual(learnedTextbookChars(books, lesson), new Set([...historyChars, ...currentChars]), lesson.title);
    }
  } finally { db.close(); }
});
