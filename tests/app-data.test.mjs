import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCatalogService } from "../server/catalog.mjs";
import { createAppServer } from "../server/index.mjs";
import { defaultCatalogDatabasePath, getCompanionWords, getLessons, getState, openLearningDatabase, saveState } from "../server/db.mjs";
import {
  applyReviewResult, charReviewKey, generateCurrentLessonPractice, generatePoetryPractice,
  generateScreeningPractice, getEligibleCharacterWords, getScreeningTargetChars,
  isHistoryCharCoolingDown, isMasteredChar, isPendingScreeningMistakeChar,
} from "../src/lib/scheduler.ts";

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
      const chars = getScreeningTargetChars(lessons, progress);
      const charStats = Object.fromEntries(chars.map((char, index) => [char, {
        attempts: index % 4 ? 1 : 0, mistakes: index % 4 && index % 3 === 0 ? 1 : 0, streak: 0,
        lastReviewedAt: index % 2 ? new Date().toISOString() : "2020-01-01T00:00:00.000Z",
      }]));
      const state = { progress, charStats, wordStats: {}, logs: [], wordIssues: [] };
      const actual = catalog.practice(progress, charStats, "history");
      assert.deepEqual(actual.items, generateScreeningPractice(lessons, state, 20));
      assert.deepEqual(actual.stats, {
        historyTotal: chars.length,
        historyReviewed: chars.filter((char) => isMasteredChar(charStats[char])).length,
        historyUnreviewed: chars.filter((char) => !charStats[char].attempts).length,
        pendingMistakes: chars.filter((char) => isPendingScreeningMistakeChar(charStats[char])).length,
        waitingReview: chars.filter((char) => isHistoryCharCoolingDown(charStats[char])).length,
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
    const practice = catalog.practice(state.progress, state.charStats);
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
    assert.deepEqual(startup.practice.items, catalog.practice(state.progress, state.charStats).items);

    const compressed = await fetch(`${baseUrl}/api/app-data`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.equal(compressed.headers.get("cache-control"), "no-store");
    assert.equal(compressed.headers.get("vary"), "Accept-Encoding");
    assert.ok(Number(compressed.headers.get("content-length")) < Buffer.byteLength(raw) / 2);
    assert.deepEqual(await compressed.json(), startup);
    const uncompressed = await fetch(`${baseUrl}/api/app-data`, { headers: { "accept-encoding": "gzip;q=0" } });
    assert.equal(uncompressed.headers.get("content-encoding"), null);

    const historical = await post("/api/practice", { progress: state.progress, charStats: state.charStats, mode: "history" });
    assert.deepEqual((await historical.json()).items, catalog.practice(state.progress, state.charStats, "history").items);
    const invalid = await post("/api/practice", { progress: { lessonId: "does-not-exist" } });
    assert.equal(invalid.status, 404);
    assert.equal((await post("/api/practice", { progress: state.progress, mode: "invalid" })).status, 400);

    // 未打开家长看板就切课、保存，旧记录必须保留。
    assert.equal((await post("/api/state", { ...startup.state, mergeLogs: true }, "PUT")).status, 200);
    assert.deepEqual(getState(learningDb, catalogDb).logs, savedLogs);
    const nextState = applyReviewResult(startup.state, practice.items, new Set(), undefined, { practiceMode: "lesson", lessons: [] });
    assert.equal((await post("/api/state", { ...nextState, mergeLogs: true }, "PUT")).status, 200);
    assert.equal(getState(learningDb, catalogDb).logs.length, 3);

    const parent = await (await post("/api/parent-data", { progress: state.progress })).json();
    assert.equal(parent.logs.length, 3);
    const lessons = getLessons(catalogDb);
    const companions = getCompanionWords(catalogDb);
    const oldIndex = new Map([
      ...lessons.flatMap((lesson) => lesson.words),
      ...getEligibleCharacterWords(lessons, state.progress, companions),
      ...lessons.flatMap((lesson) => lesson.dictationWords),
    ].map((word) => [word.id, word]));
    const logIds = new Set(parent.logs.flatMap((log) => log.wordIds));
    for (const word of parent.words) { assert.ok(logIds.has(word.id)); assert.deepEqual(word, oldIndex.get(word.id)); }
    assert.ok(parent.words.some((word) => word.id === firstItem.word.id));

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
