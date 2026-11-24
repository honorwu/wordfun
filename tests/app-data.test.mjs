import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCatalogService } from "../server/catalog.mjs";
import { createAppServer } from "../server/index.mjs";
import { defaultCatalogDatabasePath, getLessons, getState, openLearningDatabase, saveState } from "../server/db.mjs";
import { charReviewKey } from "../shared/domain/characters.ts";
import { generateCurrentLessonPractice, generatePoetryPractice, generateScreeningPractice, getScreeningQuestions } from "../shared/domain/practice.ts";
import { isMasteredQuestion, isPendingQuestionMistake, isQuestionCoolingDown } from "../shared/domain/reviewPolicy.ts";
import { applyReviewResult } from "../shared/domain/reviews.ts";

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
      const wordStats = Object.fromEntries(questions.map(({ id }, index) => [id, {
        attempts: index % 4 ? 1 : 0, mistakes: index % 4 && index % 3 === 0 ? 1 : 0, streak: 0,
        lastReviewedAt: index % 2 ? new Date().toISOString() : "2020-01-01T00:00:00.000Z",
      }]));
      const state = { progress, charStats: {}, wordStats, logs: [], wordIssues: [] };
      const actual = catalog.practice(progress, wordStats, "history");
      assert.deepEqual(actual.items, generateScreeningPractice(lessons, state, 20));
      assert.deepEqual(actual.stats, {
        historyTotal: questions.length,
        historyReviewed: questions.filter(({ id }) => isMasteredQuestion(wordStats[id])).length,
        historyInherited: 0,
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

test("启动仅返回目录与当前题；历史记录延迟读取，合并保存不丢旧记录", async () => {
  const catalogDb = new DatabaseSync(defaultCatalogDatabasePath, { readOnly: true });
  const learningDb = openLearningDatabase(":memory:");
  const server = createAppServer({ catalogDb, learningDb });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, method = "POST") => fetch(`${baseUrl}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const catalog = createCatalogService(catalogDb);
    let state = getState(learningDb, catalogDb);
    const practice = catalog.practice(state.progress, state.wordStats);
    const firstItem = practice.items[0];
    const wrong = new Set([charReviewKey(firstItem.word.id, firstItem.word.chars[0])]);
    state = applyReviewResult(state, practice.items, wrong, undefined, { practiceMode: "lesson", lessons: [{ id: practice.lesson.id, title: practice.lesson.title }] });
    const originalLog = state.logs[0];
    // 同时保留没有题词快照的旧记录，验证延迟索引与旧版一致。
    state.logs.push({ id: "legacy-log", date: "2020-01-01T00:00:00.000Z", wordIds: [firstItem.word.id], wrongWordIds: [firstItem.word.id] });
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
    const historical = await post("/api/practice", { progress: nextProgress, wordStats, mode: "history" });
    const currentHistory = await historical.json();
    assert.deepEqual(currentHistory.items.map(({ word }) => word.id), [firstItem.word.id]);
    assert.equal(currentHistory.stats.historyReviewed, pastQuestions.length - 1);
    assert.equal(currentHistory.stats.pendingMistakes, 1);
    assert.equal(currentHistory.stats.waitingReview, 0);
    assert.deepEqual(getState(learningDb, catalogDb).wordStats, state.wordStats);
    const invalid = await post("/api/practice", { progress: { lessonId: "does-not-exist" } });
    assert.equal(invalid.status, 404);
    assert.equal((await post("/api/practice", { progress: state.progress, mode: "invalid" })).status, 400);

    // 未打开家长看板就切课、保存，旧记录必须保留。
    assert.equal((await post("/api/state", { ...startup.state, mergeLogs: true }, "PUT")).status, 200);
    assert.deepEqual(getState(learningDb, catalogDb).logs, savedLogs);
    const nextState = applyReviewResult(startup.state, practice.items, new Set(), undefined, { practiceMode: "lesson", lessons: [] });
    assert.equal((await post("/api/state", { ...nextState, mergeLogs: true }, "PUT")).status, 200);
    assert.equal(getState(learningDb, catalogDb).logs.length, 3);

    const parent = await (await post("/api/parent-data", {})).json();
    assert.equal(parent.logs.length, 3);
    assert.deepEqual(parent.questions, lessons.flatMap((lesson) => lesson.dictationWords));
    const loggedIds = new Set(parent.logs.flatMap((log) => log.wordIds));
    assert.ok(parent.questions.some(({ id }) => !loggedIds.has(id)));

    // 补记是在原记录上更新，不能额外增加一场默写。
    const corrected = { ...originalLog, wrongChars: [{ wordId: firstItem.word.id, char: firstItem.word.chars[0] }] };
    await post("/api/state", { ...nextState, logs: [corrected], mergeLogs: true }, "PUT");
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

test("承接题和未落盘答题统计保持一致，复练前后都保留原成绩", async () => {
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
    const wordStats = Object.fromEntries(pastQuestions.map(({ id }) => [id, { attempts: 1, mistakes: 0, streak: 1 }]));
    saveState(learningDb, { ...initial, progress, wordStats });
    const persistedStats = getState(learningDb, catalogDb).wordStats;
    const insert = learningDb.prepare("INSERT INTO review_carryover (student_id, word_id, baseline_attempts, available_at) SELECT id, ?, ?, ? FROM students");
    insert.run(due.id, 1, null);
    insert.run(waiting.id, 1, "2999-01-01T00:00:00.000Z");

    const parent = await post("/api/parent-data", {});
    assert.deepEqual(parent.reviewCarryover[due.id], { baselineAttempts: 1, availableAt: null });
    const historical = await post("/api/practice", { progress, wordStats, mode: "history" });
    assert.deepEqual(historical.items.map(({ word }) => word.id), [due.id]);
    assert.equal(historical.stats.pendingMistakes, 2);
    assert.equal(historical.stats.waitingReview, 1);
    assert.equal(historical.stats.historyReviewed, pastQuestions.length - 2);

    const next = { ...wordStats, [due.id]: { attempts: 2, mistakes: 0, streak: 2 } };
    const afterAttempt = await post("/api/practice", { progress, wordStats: next, mode: "history" });
    assert.deepEqual(afterAttempt.items, []);
    assert.equal(afterAttempt.stats.pendingMistakes, 1);
    assert.equal(afterAttempt.stats.historyReviewed, pastQuestions.length - 1);
    assert.deepEqual(getState(learningDb, catalogDb).wordStats, persistedStats);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close(); catalogDb.close();
  }
});

test("旧掌握字跨词继承，但整题成绩、待巩固和课次练习独立", async () => {
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
    const fullLesson = lessons.find(({ title }) => title === "曹冲称象");
    const partialLesson = lessons.find(({ title }) => title === "难忘的泼水节");
    const inherited = fullLesson.dictationWords.find(({ text }) => text === "船身");
    const partial = partialLesson.dictationWords.find(({ text }) => text === "龙船");
    const nextLesson = lessons[lessons.indexOf(partialLesson) + 1];
    const progress = { lessonId: nextLesson.id, grade: nextLesson.grade };
    const pastQuestions = getScreeningQuestions(lessons, progress);
    const mastered = { attempts: 1, mistakes: 0, streak: 1 };
    const missed = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: "2020-01-01T00:00:00.000Z" };
    const wordStats = Object.fromEntries(pastQuestions.filter(({ id }) => id !== inherited.id && id !== partial.id).map(({ id }) => [id, mastered]));
    // 模拟龙字后来学会，但只把旧库明确继承的船、身用于历史排题。
    const charStats = { 船: mastered, 身: mastered, 龙: mastered };
    saveState(learningDb, { ...initial, progress, charStats, wordStats });
    const insert = learningDb.prepare("INSERT INTO inherited_char_mastery (student_id, char) SELECT id, ? FROM students");
    insert.run("船");
    insert.run("身");
    assert.deepEqual((await post("/api/parent-data", {})).inheritedMasteredChars, ["船", "身"]);

    const history = await post("/api/practice", { progress, wordStats, mode: "history" });
    assert.deepEqual(history.items.map(({ word }) => word.id), [partial.id]);
    assert.equal(history.stats.historyInherited, 1);
    assert.equal(history.stats.historyReviewed, pastQuestions.length - 2);

    const current = await post("/api/practice", { progress: { lessonId: fullLesson.id, grade: fullLesson.grade }, wordStats, mode: "lesson" });
    assert.ok(current.items.some(({ word }) => word.id === inherited.id));

    const due = await post("/api/practice", { progress, wordStats: { ...wordStats, [inherited.id]: missed }, mode: "history" });
    assert.deepEqual(due.items.map(({ word }) => word.id), [inherited.id, partial.id]);
    assert.equal(due.stats.historyInherited, 0);
    assert.equal(due.stats.pendingMistakes, 1);

    const carryover = learningDb.prepare("INSERT INTO review_carryover (student_id, word_id, baseline_attempts, available_at) SELECT id, ?, 0, NULL FROM students");
    carryover.run(inherited.id);
    const carried = await post("/api/practice", { progress, wordStats, mode: "history" });
    assert.deepEqual(carried.items.map(({ word }) => word.id), [inherited.id, partial.id]);
    assert.equal(carried.stats.historyInherited, 0);
    assert.equal(carried.stats.pendingMistakes, 1);
    learningDb.prepare("DELETE FROM review_carryover WHERE word_id = ?").run(inherited.id);

    saveState(learningDb, { ...initial, progress, charStats: { ...charStats, 船: missed }, wordStats });
    assert.deepEqual((await post("/api/parent-data", {})).inheritedMasteredChars, ["身"]);
    assert.equal(learningDb.prepare("SELECT COUNT(*) AS count FROM inherited_char_mastery").get().count, 2);
    assert.equal(getState(learningDb, catalogDb).wordStats[inherited.id], undefined);
    const needsReview = await post("/api/practice", { progress, wordStats, mode: "history" });
    assert.ok(needsReview.items.some(({ word }) => word.id === inherited.id));
    assert.equal(needsReview.stats.historyInherited, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    learningDb.close(); catalogDb.close();
  }
});
