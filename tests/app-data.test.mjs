import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCatalogService } from "../server/catalog.mjs";
import { createAppServer } from "../server/index.mjs";
import { defaultCatalogDatabasePath, getLessons, getState, learningSchemaSql, openLearningDatabase, saveState } from "../server/db.mjs";
import { charReviewKey } from "../shared/domain/characters.ts";
import { generateCurrentLessonPractice, generatePoetryPractice, generateScreeningPractice, getScreeningQuestions } from "../shared/domain/practice.ts";
import { isMasteredQuestion, isPendingQuestionMistake, isQuestionCoolingDown } from "../shared/domain/reviewPolicy.ts";
import { addMissedWrongChars, applyReviewResult } from "../shared/domain/reviews.ts";

test("服务端出题保持所有课次原有的题词、拼音、目标字及顺序", () => {
  const db = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  try {
    const lessons = getLessons(db);
    const catalog = createCatalogService(db);
    for (const lesson of lessons) {
      const progress = { grade: lesson.grade, lessonId: lesson.id };
      const state = { progress, charStats: {}, wordStats: {}, logs: [], wordIssues: [] };
      const expected = lesson.lessonKind === "classical_poetry" ? generatePoetryPractice(lesson) : generateCurrentLessonPractice(lessons, state);
      assert.deepEqual(catalog.practice(progress, {}).items, expected, lesson.id);
    }
    for (const lesson of [lessons[0], lessons[Math.floor(lessons.length / 2)], lessons.at(-1)]) {
      const progress = { grade: lesson.grade, lessonId: lesson.id };
      const questions = getScreeningQuestions(lessons, progress);
      const wordStats = Object.fromEntries(questions.map(({ id }, index) => {
        const attempts = index % 4 ? 1 : 0;
        const mistakes = attempts && index % 3 === 0 ? 1 : 0;
        const lastReviewedAt = index % 8 === 0 ? undefined : index % 2 ? new Date().toISOString() : "2020-01-01T00:00:00.000Z";
        return [id, { attempts, mistakes, streak: attempts - mistakes, lastReviewedAt }];
      }));
      const state = { progress, charStats: {}, wordStats, logs: [], wordIssues: [] };
      const actual = catalog.practice(progress, wordStats, "history");
      assert.deepEqual(actual.items, generateScreeningPractice(lessons, state, 20));
      assert.deepEqual(actual.stats, {
        historyTotal: questions.length,
        historyReviewed: questions.filter(({ id }) => isMasteredQuestion(wordStats[id])).length,
        historyUnreviewed: questions.filter(({ id }) => !wordStats[id].attempts).length,
        pendingMistakes: questions.filter(({ id }) => isPendingQuestionMistake(wordStats[id])).length,
        waitingReview: questions.filter(({ id }) => isQuestionCoolingDown(wordStats[id])).length,
      });
    }
  } finally { db.close(); }
});

test("词库缓存复用查询结果，外部更新词库后失效", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ziqu-catalog-cache-"));
  const filename = path.join(directory, "catalog.sqlite");
  copyFileSync(defaultCatalogDatabasePath, filename);
  const db = new DatabaseSync(filename);
  const writer = new DatabaseSync(filename);
  const queries = [];
  const catalog = createCatalogService({ prepare(sql) { queries.push(sql); return db.prepare(sql); } });
  try {
    const first = catalog.summaries();
    queries.length = 0;
    assert.equal(catalog.summaries(), first);
    catalog.practice({ grade: first[0].grade, lessonId: first[0].id }, {});
    assert.ok(queries.every((sql) => sql === "PRAGMA data_version"));
    writer.prepare("UPDATE lessons SET title = ? WHERE id = ?").run("缓存更新测试", first[0].id);
    assert.equal(catalog.summaries()[0].title, "缓存更新测试");
  } finally { writer.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("启动拒绝格式不符的学习库，保留原文件", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ziqu-unsupported-learning-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "learning.sqlite");
  const database = new DatabaseSync(filename);
  try {
    database.exec(learningSchemaSql);
    database.exec(`
      ALTER TABLE char_stats DROP COLUMN streak;
      ALTER TABLE char_stats DROP COLUMN last_mistake_at;
      ALTER TABLE review_logs DROP COLUMN practice_mode;
      ALTER TABLE review_log_words DROP COLUMN prompt_text;
    `);
  } finally {
    database.close();
  }
  const original = readFileSync(filename);
  assert.throws(() => openLearningDatabase(filename), (error) => {
    assert.match(error.message, /学习库格式不符/);
    for (const field of ["char_stats.streak", "char_stats.last_mistake_at", "review_logs.practice_mode", "review_log_words.prompt_text"]) {
      assert.ok(error.message.includes(field), field);
    }
    return true;
  });
  assert.deepEqual(readFileSync(filename), original);
});

test("启动仅返回目录与当前题；历史记录延迟读取，增量保存保留已入库的场次", async () => {
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, method = "POST") => fetch(`${baseUrl}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const catalog = createCatalogService(catalogDb);
    const [firstLesson] = catalog.summaries();
    const firstPractice = await post("/api/practice", { progress: { lessonId: firstLesson.id, grade: firstLesson.grade }, mode: "lesson" });
    assert.equal(firstPractice.status, 200);
    assert.equal((await firstPractice.json()).lesson.id, firstLesson.id);
    assert.equal(learningDb.prepare("SELECT COUNT(*) AS count FROM students").get().count, 0);

    let state = getState(learningDb, catalogDb);
    const practice = catalog.practice(state.progress, state.wordStats);
    const firstItem = practice.items[0];
    const wrong = new Set([charReviewKey(firstItem.word.id, firstItem.word.chars[0])]);
    state = applyReviewResult(state, practice.items, wrong, { practiceMode: "lesson", lessons: [{ id: practice.lesson.id, title: practice.lesson.title }] });
    const originalLog = state.logs[0];
    // 当前学习库也可能包含没有完整计分快照的历史场次。
    state.logs.push({ id: "imported-log", date: "2020-01-01T00:00:00.000Z", wordIds: [firstItem.word.id], wrongWordIds: [firstItem.word.id] });
    saveState(learningDb, state);
    const savedLogs = getState(learningDb, catalogDb).logs;

    const plain = await fetch(`${baseUrl}/api/app-data`, { headers: { "accept-encoding": "identity" } });
    const raw = await plain.text();
    const startup = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) < 100_000);
    assert.equal(startup.lessons.length, getLessons(catalogDb).length);
    assert.ok(startup.lessons.every((lesson) => [
      "words", "textbookWords", "textCompanions", "dictationWords",
    ].every((key) => !(key in lesson))));
    assert.ok(!('companionWords' in startup));
    assert.deepEqual(startup.state.logs, []);
    assert.equal(startup.activity.length, 2);
    assert.equal(startup.activity.find((item) => item.id === originalLog.id).count, originalLog.wordIds.length);
    assert.deepEqual(startup.practice.items, catalog.practice(state.progress, state.wordStats).items);

    const compressed = await fetch(`${baseUrl}/api/app-data`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.equal(compressed.headers.get("cache-control"), "no-store");
    assert.equal(compressed.headers.get("vary"), "Accept-Encoding");
    assert.ok(Number(compressed.headers.get("content-length")) < Buffer.byteLength(raw) / 2);
    assert.deepEqual(await compressed.json(), startup);
    const uncompressed = await fetch(`${baseUrl}/api/app-data`, { headers: { "accept-encoding": "gzip;q=0" } });
    assert.equal(uncompressed.headers.get("content-encoding"), null);

    const lessons = getLessons(catalogDb);
    const nextLesson = lessons[lessons.findIndex(({ id }) => id === practice.lesson.id) + 1];
    const nextProgress = { lessonId: nextLesson.id, grade: nextLesson.grade };
    const pastQuestions = getScreeningQuestions(lessons, nextProgress);
    const wordStats = Object.fromEntries(pastQuestions.map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    wordStats[firstItem.word.id] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: "2020-01-01T00:00:00.000Z" };
    saveState(learningDb, { ...state, wordStats });
    const persistedStats = getState(learningDb, catalogDb).wordStats;
    const historical = await post("/api/practice", { progress: nextProgress, mode: "history" });
    const currentHistory = await historical.json();
    assert.deepEqual(currentHistory.items.map(({ word, historyGroup }) => [word.id, historyGroup]), [[firstItem.word.id, "mistake"]]);
    assert.equal(currentHistory.stats.historyReviewed, pastQuestions.length - 1);
    assert.equal(currentHistory.stats.historyUnreviewed, 0);
    assert.equal(currentHistory.stats.pendingMistakes, 1);
    assert.equal(currentHistory.stats.waitingReview, 0);
    assert.deepEqual(getState(learningDb, catalogDb).wordStats, persistedStats);
    const invalid = await post("/api/practice", { progress: { lessonId: "does-not-exist" } });
    assert.equal(invalid.status, 404);
    assert.equal((await post("/api/practice", { progress: state.progress, mode: "invalid" })).status, 400);

    // 未打开家长看板就切课、保存，旧记录必须保留。
    assert.equal((await post("/api/state", startup.state, "PUT")).status, 200);
    assert.deepEqual(getState(learningDb, catalogDb).logs, savedLogs);
    const nextState = applyReviewResult(startup.state, practice.items, new Set(), { practiceMode: "lesson", lessons: [] });
    assert.equal((await post("/api/state", nextState, "PUT")).status, 200);
    assert.equal(getState(learningDb, catalogDb).logs.length, 3);

    const parent = await (await post("/api/parent-data", {})).json();
    assert.equal(parent.logs.length, 3);
    assert.deepEqual(parent.questions, lessons.flatMap((lesson) => lesson.dictationWords));
    const loggedIds = new Set(parent.logs.flatMap((log) => log.wordIds));
    assert.ok(parent.questions.some(({ id }) => !loggedIds.has(id)));

    // 补记是在原记录上更新，不能额外增加一场默写。
    const corrected = { ...originalLog, wrongChars: [{ wordId: firstItem.word.id, char: firstItem.word.chars[0] }] };
    await post("/api/state", { ...nextState, logs: [corrected] }, "PUT");
    const restored = getState(learningDb, catalogDb);
    assert.equal(restored.logs.length, 3);
    assert.deepEqual(restored.logs.find((log) => log.id === originalLog.id).wrongChars, corrected.wrongChars);
    assert.deepEqual(restored.charStats, nextState.charStats);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close(); catalogDb.close();
  }
});

test("超过 120 场仍可查阅最早场次，并补记近期场次", async (t) => {
  const now = Date.UTC(2025, 5, 1, 12);
  const dayMs = 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const directory = mkdtempSync(path.join(os.tmpdir(), "ziqu-review-history-"));
  const filename = path.join(directory, "learning.sqlite");
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  t.after(() => {
    catalogDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const learningDb = openLearningDatabase(filename);
  const server = createAppServer({ catalogDb, learningDb });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method, state, expectedStatus = 200) => {
    const response = await fetch(baseUrl + url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(response.status, expectedStatus);
    return response.json();
  };
  const roundCount = 125;
  let earliestId;
  let latestId;
  let correctedChar;
  let wordId;
  try {
    let state = getState(learningDb, catalogDb);
    const practice = createCatalogService(catalogDb).practice(state.progress, state.wordStats);
    const [item] = practice.items;
    const context = { practiceMode: "lesson", lessons: [{ id: practice.lesson.id, title: practice.lesson.title }] };
    for (let index = 0; index < roundCount; index++) {
      state = applyReviewResult(state, [item], new Set(), context);
      state.logs[0].date = new Date(now - (roundCount - index - 1) * dayMs).toISOString();
    }
    assert.equal(state.logs.length, roundCount);
    const initialLogs = state.logs.slice(-120);
    const newLogs = state.logs.slice(0, roundCount - initialLogs.length);
    const earliest = initialLogs.at(-1);
    const latest = newLogs[0];
    earliestId = earliest.id;
    latestId = latest.id;
    wordId = item.word.id;
    correctedChar = item.word.chars[0];
    saveState(learningDb, { ...state, logs: initialLogs });

    const submission = { ...state, logs: newLogs };
    await request("/api/state", "PUT", submission);
    await request("/api/state", "PUT", submission);
    const startup = await (await fetch(`${baseUrl}/api/app-data`)).json();
    assert.equal(startup.activity.length, roundCount);
    assert.ok(startup.activity.some(({ id, count }) => id === earliestId && count === 1));
    const parent = await request("/api/parent-data", "POST");
    assert.equal(parent.logs.length, roundCount);
    assert.equal(parent.logs[0].id, latestId);
    assert.equal(parent.logs.at(-1).id, earliestId);
    assert.deepEqual(parent.logs.at(-1).reviewedItems, earliest.reviewedItems);

    const expired = { ...earliest, wrongWordIds: [wordId] };
    await request("/api/state", "PUT", { ...state, logs: [expired] }, 409);

    const correction = { wordId, char: correctedChar };
    const corrected = addMissedWrongChars({ ...state, logs: parent.logs }, latestId, [correction], new Map([[wordId, item.word]]));
    assert.equal(corrected.wordStats[wordId].attempts, roundCount);
    assert.equal(corrected.wordStats[wordId].mistakes, 1);
    await request("/api/state", "PUT", { ...corrected, logs: [corrected.logs[0]] });
    await request("/api/state", "PUT", { ...corrected, logs: [earliest, latest] });

    const nextLesson = getLessons(catalogDb).find(({ id }) => id !== state.progress.lessonId);
    await request("/api/state", "PUT", { ...corrected, progress: { grade: nextLesson.grade, lessonId: nextLesson.id }, logs: [] });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close();
  }

  const reopened = openLearningDatabase(filename);
  try {
    const restored = getState(reopened, catalogDb);
    assert.equal(restored.logs.length, roundCount);
    assert.equal(restored.logs[0].id, latestId);
    assert.equal(restored.logs.at(-1).id, earliestId);
    assert.deepEqual(restored.logs.at(-1).wrongWordIds, []);
    assert.deepEqual(restored.logs[0].wrongWordIds, [wordId]);
    assert.deepEqual(restored.logs[0].wrongChars, [{ wordId, char: correctedChar }]);
    assert.equal(restored.wordStats[wordId].attempts, roundCount);
    assert.equal(restored.wordStats[wordId].mistakes, 1);
  } finally {
    reopened.close();
  }
});

test("补记按原场次时间计算 72 小时，过期更正全部回滚", async (t) => {
  const deadline = Date.UTC(2025, 5, 1, 12);
  const correctionWindowMs = 72 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ["Date"], now: deadline - correctionWindowMs });
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const save = (state) => fetch(`http://127.0.0.1:${server.address().port}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  try {
    const initial = getState(learningDb, catalogDb);
    const practice = createCatalogService(catalogDb).practice(initial.progress);
    const item = practice.items.find(({ word }) => word.chars.length >= 2);
    const { id: wordId, chars: [firstChar, secondChar] } = item.word;
    const context = { practiceMode: "lesson", lessons: [{ id: practice.lesson.id, title: practice.lesson.title }] };
    const state = applyReviewResult(initial, [item], new Set(), context);
    const [log] = state.logs;
    saveState(learningDb, state);

    t.mock.timers.setTime(deadline);
    const words = new Map([[wordId, item.word]]);
    const first = addMissedWrongChars(state, log.id, [{ wordId, char: firstChar }], words);
    const second = addMissedWrongChars(first, log.id, [{ wordId, char: secondChar }], words);
    assert.equal(first.wordStats[wordId].mistakes, 1);
    assert.equal(second.charStats[secondChar].mistakes, 1);
    const atDeadline = await save(first);
    assert.equal(atDeadline.status, 200);
    assert.deepEqual(await atDeadline.json(), { ok: true });
    const saved = getState(learningDb, catalogDb);
    assert.deepEqual(saved.logs[0].wrongChars, [{ wordId, char: firstChar }]);

    t.mock.timers.setTime(deadline + 1);
    const retry = await save(first);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true });

    const lateLog = { ...second.logs[0], date: new Date().toISOString() };
    const late = await save({ ...second, logs: [lateLog] });
    assert.equal(late.status, 409);
    assert.match((await late.json()).error, /3 天补记期限/);
    assert.deepEqual(getState(learningDb, catalogDb), saved);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close(); catalogDb.close();
  }
});

test("承接题以已提交的答题次数为准，排题不修改成绩", async () => {
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(baseUrl + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const initial = getState(learningDb, catalogDb);
    const lessons = getLessons(catalogDb);
    const nextLesson = lessons[lessons.findIndex(({ id }) => id === initial.progress.lessonId) + 1];
    const progress = { lessonId: nextLesson.id, grade: nextLesson.grade };
    const pastQuestions = getScreeningQuestions(lessons, progress);
    const [due, waiting] = pastQuestions;
    const wordStats = Object.fromEntries(pastQuestions.slice(2).map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    saveState(learningDb, { ...initial, progress, wordStats });
    const persistedStats = getState(learningDb, catalogDb).wordStats;
    const insert = learningDb.prepare("INSERT INTO review_carryover (student_id, word_id, baseline_attempts, available_at) SELECT id, ?, ?, ? FROM students");
    insert.run(due.id, 0, null);
    insert.run(waiting.id, 0, "2999-01-01T00:00:00.000Z");

    const parent = await post("/api/parent-data", {});
    assert.deepEqual(parent.reviewCarryover[due.id], { baselineAttempts: 0, availableAt: null });
    const historical = await post("/api/practice", { progress, mode: "history" });
    assert.deepEqual(historical.items.map(({ word, historyGroup, mistakeReview }) => [word.id, historyGroup, mistakeReview]), [
      [due.id, "mistake", "character"],
    ]);
    assert.equal(historical.stats.pendingMistakes, 2);
    assert.equal(historical.stats.waitingReview, 1);
    assert.equal(historical.stats.historyReviewed, pastQuestions.length - 2);

    const next = { ...wordStats, [due.id]: { attempts: 1, mistakes: 0, streak: 1 } };
    assert.deepEqual(await post("/api/practice", { progress, mode: "history", wordStats: next }), historical);
    assert.deepEqual(getState(learningDb, catalogDb).wordStats, persistedStats);

    saveState(learningDb, { ...initial, progress, wordStats: next });
    const afterAttempt = await post("/api/practice", { progress, mode: "history" });
    assert.deepEqual(afterAttempt.items, []);
    assert.equal(afterAttempt.stats.pendingMistakes, 1);
    assert.equal(afterAttempt.stats.historyReviewed, pastQuestions.length - 1);
    assert.equal(getState(learningDb, catalogDb).wordStats[due.id].attempts, 1);

    const allMasteredStats = { ...next, [waiting.id]: { attempts: 1, mistakes: 0, streak: 1 } };
    saveState(learningDb, { ...initial, progress, wordStats: allMasteredStats });
    const allMastered = await post("/api/practice", { progress, mode: "history" });
    assert.deepEqual(allMastered.items, []);
    assert.deepEqual(allMastered.stats, {
      historyTotal: pastQuestions.length,
      historyReviewed: pastQuestions.length,
      historyUnreviewed: 0,
      pendingMistakes: 0,
      waitingReview: 0,
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close(); catalogDb.close();
  }
});

test("船身按本题的已提交成绩安排，龙船的错字只影响本题和逐字统计", async () => {
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(baseUrl + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const initial = getState(learningDb, catalogDb);
    const lessons = getLessons(catalogDb);
    const hullLesson = lessons.find(({ title }) => title === "曹冲称象");
    const dragonBoatLesson = lessons.find(({ title }) => title === "难忘的泼水节");
    const hull = hullLesson.dictationWords.find(({ text }) => text === "船身");
    const dragonBoat = dragonBoatLesson.dictationWords.find(({ text }) => text === "龙船");
    const nextLesson = lessons[lessons.indexOf(dragonBoatLesson) + 1];
    const progress = { lessonId: nextLesson.id, grade: nextLesson.grade };
    const pastQuestions = getScreeningQuestions(lessons, progress);
    const mastered = { attempts: 1, mistakes: 0, streak: 1 };
    const wordStats = Object.fromEntries(pastQuestions.filter(({ id }) => id !== hull.id && id !== dragonBoat.id).map(({ id }) => [id, mastered]));
    wordStats[hull.id] = { attempts: 0, mistakes: 0, streak: 0, lastReviewedAt: "2020-01-01T00:00:00.000Z" };
    const charStats = { 船: mastered, 身: mastered, 龙: mastered };
    const state = { ...initial, progress, charStats, wordStats };
    saveState(learningDb, state);
    const recordInheritedChar = learningDb.prepare("INSERT INTO inherited_char_mastery (student_id, char) SELECT id, ? FROM students");
    recordInheritedChar.run("船");
    recordInheritedChar.run("身");

    const historyRequest = { progress, mode: "history" };
    const firstRound = await post("/api/practice", historyRequest);
    assert.equal(firstRound.items.length, 2);
    assert.deepEqual(new Set(firstRound.items.map(({ word }) => word.id)), new Set([hull.id, dragonBoat.id]));
    assert.ok(firstRound.items.every(({ historyGroup }) => historyGroup === "recent" || historyGroup === "basic"));
    assert.equal(firstRound.stats.historyUnreviewed, 2);
    assert.equal(firstRound.stats.historyReviewed, pastQuestions.length - 2);

    const current = await post("/api/practice", { progress: { lessonId: hullLesson.id, grade: hullLesson.grade }, mode: "lesson" });
    assert.ok(current.items.some(({ word }) => word.id === hull.id));

    const hullMastered = { ...state, wordStats: { ...wordStats, [hull.id]: mastered } };
    saveState(learningDb, hullMastered);
    learningDb.prepare("INSERT INTO review_carryover (student_id, word_id, baseline_attempts, available_at) SELECT id, ?, 1, NULL FROM students").run(hull.id);
    const history = await post("/api/practice", historyRequest);
    assert.deepEqual(history.items.map(({ word }) => word.id), [dragonBoat.id]);
    assert.ok(history.items.every(({ historyGroup }) => historyGroup === "recent" || historyGroup === "basic"));

    const wrong = new Set([charReviewKey(dragonBoat.id, "船")]);
    const graded = applyReviewResult(hullMastered, history.items, wrong, {
      practiceMode: "history",
      lessons: [{ id: dragonBoatLesson.id, title: dragonBoatLesson.title }],
    });
    const beforeSave = await post("/api/practice", { ...historyRequest, wordStats: graded.wordStats });
    assert.deepEqual(beforeSave, history);

    const saved = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(graded),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { ok: true });

    const nextRound = await post("/api/practice", { ...historyRequest, wordStats: hullMastered.wordStats });
    assert.deepEqual(nextRound.items, []);
    assert.equal(nextRound.stats.historyReviewed, pastQuestions.length - 1);
    assert.equal(nextRound.stats.waitingReview, 1);
    assert.equal(nextRound.stats.pendingMistakes, 1);
    const persisted = getState(learningDb, catalogDb);
    assert.equal(persisted.wordStats[hull.id].mistakes, 0);
    assert.equal(persisted.wordStats[dragonBoat.id].mistakes, 1);
    assert.equal(persisted.charStats.船.mistakes, 1);
    assert.equal(learningDb.prepare("SELECT COUNT(*) AS count FROM inherited_char_mastery").get().count, 2);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close(); catalogDb.close();
  }
});

test("整题必须对多于错且按 2/5/10 天阶梯复测才从历史复习退出，错两次后两对仍待巩固", async (t) => {
  const firstReviewTime = Date.UTC(2025, 5, 1, 12);
  const dayMs = 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ["Date"], now: firstReviewTime });

  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close();
    catalogDb.close();
  });

  const lessons = getLessons(catalogDb);
  const [firstLesson, nextLesson] = lessons;
  const progress = { grade: nextLesson.grade, lessonId: nextLesson.id };
  const [word, ...remaining] = getScreeningQuestions(lessons, progress);
  const context = { practiceMode: "history", lessons: [{ id: firstLesson.id, title: firstLesson.title }] };
  const wordStats = Object.fromEntries(remaining.map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
  saveState(learningDb, { ...getState(learningDb, catalogDb), progress, wordStats });

  const request = async (url, method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const round = () => request("/api/practice", "POST", { progress, mode: "history" });
  const grade = async (items, wrong) => {
    const keys = wrong ? new Set([charReviewKey(word.id, word.chars[0])]) : new Set();
    const graded = applyReviewResult(getState(learningDb, catalogDb), items, keys, context);
    assert.deepEqual(await request("/api/state", "PUT", { ...graded, logs: [graded.logs[0]] }), { ok: true });
  };

  // 第 0 天错 -> +2 天再错 -> +2 天写对(streak=1) -> +5 天写对(streak=2)
  let now = firstReviewTime;
  for (const [index, [waitDays, wrong]] of [[0, true], [2, true], [2, false], [5, false]].entries()) {
    now += waitDays * dayMs;
    t.mock.timers.setTime(now);
    const { items } = await round();
    assert.deepEqual(items.map(({ word }) => word.id), [word.id]);
    if (index > 0) assert.equal(items[0].historyGroup, "mistake");
    await grade(items, wrong);
  }
  const atTie = getState(learningDb, catalogDb).wordStats[word.id];
  assert.equal(atTie.attempts - atTie.mistakes, 2);
  assert.equal(atTie.mistakes, 2);
  assert.equal(atTie.streak, 2);

  const pendingStats = {
    historyTotal: remaining.length + 1, historyReviewed: remaining.length,
    historyUnreviewed: 0, pendingMistakes: 1, waitingReview: 1,
  };
  // streak=2 冷却 10 天
  t.mock.timers.setTime(now + 10 * dayMs - 1);
  const waiting = await round();
  assert.deepEqual(waiting.items, []);
  assert.deepEqual(waiting.stats, pendingStats);

  t.mock.timers.setTime(now + 10 * dayMs);
  const due = await round();
  assert.deepEqual(due.items.map(({ word, historyGroup }) => [word.id, historyGroup]), [[word.id, "mistake"]]);
  assert.deepEqual(due.stats, { ...pendingStats, waitingReview: 0 });
  await grade(due.items, false);

  const mastered = getState(learningDb, catalogDb).wordStats[word.id];
  assert.equal(mastered.attempts - mastered.mistakes, 3);
  assert.equal(mastered.mistakes, 2);
  const complete = await round();
  assert.deepEqual(complete.items, []);
  assert.deepEqual(complete.stats, { ...pendingStats, historyReviewed: remaining.length + 1, pendingMistakes: 0, waitingReview: 0 });
});

test("健康检查不泄露本机路径，静态文件服务安全处理目录、非法路径与 HEAD 请求", async (t) => {
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close();
    catalogDb.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), { ok: true });

  const badEncoding = await fetch(`${baseUrl}/%E0%A4%A`);
  assert.equal(badEncoding.status, 400);

  const traversal = await fetch(`${baseUrl}/..%2fpackage.json`);
  assert.equal(traversal.status, 403);

  const dirReq = await fetch(`${baseUrl}/assets`);
  assert.ok(dirReq.status === 200 || dirReq.status === 404);
  await dirReq.text();

  const headReq = await fetch(`${baseUrl}/`, { method: "HEAD" });
  assert.ok(headReq.status === 200 || headReq.status === 404);

  const postStatic = await fetch(`${baseUrl}/`, { method: "POST" });
  assert.equal(postStatic.status, 405);
});

test("增量意图接口按服务端时钟原子写入，互不覆盖并发变更，支持可选访问口令", async (t) => {
  const startTime = Date.UTC(2026, 4, 1, 10, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ["Date"], now: startTime });

  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb, accessToken: "secret-pin" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close();
    catalogDb.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeader = `Basic ${Buffer.from("family:secret-pin").toString("base64")}`;
  const api = async (url, method = "GET", body, expectedStatus = 200) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { authorization: authHeader, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, expectedStatus);
    return response.json();
  };

  // 健康检查免口令，业务接口无口令拒绝
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { ok: true });
  assert.equal((await fetch(`${baseUrl}/api/app-data`)).status, 401);

  const startup = await api("/api/app-data");
  const lessons = startup.lessons;
  const secondLesson = lessons[1];

  // 1. 切课仅更新 progress，不破坏已有统计
  const updatedProgress = await api("/api/progress", "PUT", { progress: { grade: 1, lessonId: secondLesson.id } });
  assert.deepEqual(updatedProgress.progress, { grade: secondLesson.grade, lessonId: secondLesson.id });
  await api("/api/progress", "PUT", { progress: { grade: 3, lessonId: "non-existent" } }, 404);

  // 2. 提交批改由服务端生成权威时间并增量更新 word_stats / char_stats / review_logs
  const practice = await api("/api/practice", "POST", { progress: updatedProgress.progress, mode: "lesson" });
  const [firstItem, secondItem] = practice.items;
  const firstChar = firstItem.word.chars[0];
  const reviewRes = await api("/api/reviews", "POST", {
    practiceMode: "lesson",
    lessons: [{ id: secondLesson.id, title: secondLesson.title }],
    wordIds: [firstItem.word.id, secondItem.word.id],
    wrongChars: [{ wordId: firstItem.word.id, char: firstChar }],
  });
  assert.equal(reviewRes.log.date, new Date(startTime).toISOString());
  assert.equal(reviewRes.wordStats[firstItem.word.id].mistakes, 1);
  assert.equal(reviewRes.wordStats[secondItem.word.id].mistakes, 0);
  assert.equal(reviewRes.charStats[firstChar].mistakes, 1);

  // 3. 另一端并发标记词库问题，不影响刚保存的 word_stats 与 review_logs
  const toggled = await api("/api/word-issues/toggle", "POST", {
    word: firstItem.word,
    lessonLabel: secondLesson.title,
    kind: "pronunciation",
  });
  assert.equal(toggled.wordIssues.length, 1);
  const resolved = await api(`/api/word-issues/${encodeURIComponent(toggled.wordIssues[0].id)}`, "PATCH", { resolved: true });
  assert.ok(resolved.wordIssues[0].resolvedAt);

  // 4. 在 72h 内补记漏标错字，仅增量更新受影响的题与字
  t.mock.timers.setTime(startTime + 2 * dayMs);
  const missedChar = secondItem.word.chars[0];
  const supplemented = await api(`/api/reviews/${encodeURIComponent(reviewRes.log.id)}/corrections`, "POST", {
    corrections: [{ wordId: secondItem.word.id, char: missedChar }],
  });
  assert.equal(supplemented.appliedCount, 1);
  assert.equal(supplemented.wordStats[secondItem.word.id].mistakes, 1);
  assert.equal(supplemented.wordStats[secondItem.word.id].attempts, 1);

  // 5. 超过 72h 后拒绝补记
  t.mock.timers.setTime(startTime + 3 * dayMs + 1);
  await api(`/api/reviews/${encodeURIComponent(reviewRes.log.id)}/corrections`, "POST", {
    corrections: [{ wordId: secondItem.word.id, char: secondItem.word.chars.at(-1) }],
  }, 409);

  // 验证最终数据库完整且无相互覆盖
  const finalState = getState(learningDb, catalogDb);
  assert.equal(finalState.progress.lessonId, secondLesson.id);
  assert.equal(finalState.logs.length, 1);
  assert.equal(finalState.wordStats[firstItem.word.id].mistakes, 1);
  assert.equal(finalState.wordStats[secondItem.word.id].mistakes, 1);
  assert.equal(finalState.wordIssues.length, 1);
  assert.ok(finalState.wordIssues[0].resolvedAt);

  // 验证服务端直接返回遮字表且 GET /api/parent-data 支持省略全量题目
  assert.ok(practice.masks && typeof practice.masks.hints === "object" && typeof practice.masks.lessonTitles === "object");
  const parentLite = await api("/api/parent-data?includeQuestions=0", "GET");
  assert.equal(parentLite.questions, undefined);
  assert.equal(parentLite.logs.length, 1);
  const parentFull = await api("/api/parent-data", "GET");
  assert.ok(Array.isArray(parentFull.questions) && parentFull.questions.length > 0);
});
