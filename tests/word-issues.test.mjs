import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportWordIssues, findWordIssue, normalizeWordIssues, toggleWordIssue } from "../src/lib/wordIssues.ts";
import { getState, openCatalogDatabase, openLearningDatabase, saveState } from "../server/db.mjs";

const word = {
  id: "lesson-1-char-行",
  text: "银行",
  pinyin: "yín háng",
  chars: ["行"],
  grade: 3,
  lessonId: "lesson-1",
  lessonTitle: "测试课文",
  category: "一类",
};
const lessonLabel = "三年级上册 · 第1课·测试课文";
const flag = (issues = [], kind = "wording", prompt = word) => toggleWordIssue(issues, prompt, lessonLabel, kind);

test("两种问题可同时标记、分别取消，重复题词只保留一条记录", () => {
  const first = flag();
  const both = flag(first, "pronunciation");
  assert.equal(both.length, 1);
  assert.equal(both[0].id, first[0].id);
  assert.deepEqual(both[0].kinds, ["wording", "pronunciation"]);
  assert.deepEqual(first[0].kinds, ["wording"]);
  assert.notEqual(first[0].word.chars, word.chars);
  const remaining = flag(both);
  assert.deepEqual(remaining[0].kinds, ["pronunciation"]);
  assert.deepEqual(flag(remaining, "pronunciation"), []);
  assert.equal(flag(first, "pronunciation", { ...word, id: "another-source-id" }).length, 1);
});

test("生字 ID 相同但组词、拼音或课次不同的问题保留各自快照", () => {
  const changedText = { ...word, text: "行走", pinyin: "xíng zǒu" };
  const changedPinyin = { ...word, pinyin: "yín xíng" };
  const changedLesson = { ...word, lessonId: "lesson-2" };
  let issues = flag();
  for (const prompt of [changedText, changedPinyin, changedLesson]) issues = flag(issues, "pronunciation", prompt);
  assert.equal(issues.length, 4);
  assert.deepEqual(findWordIssue(issues, word).word, word);
  assert.deepEqual(findWordIssue(issues, changedText).word, changedText);
  assert.equal(findWordIssue(issues, changedPinyin).word.pinyin, "yín xíng");
});

test("已处理的问题再次被孩子标记后回到待处理，只保留本次选择的问题", () => {
  const resolved = flag().map((issue) => ({ ...issue, resolvedAt: "2026-11-16T01:00:00.000Z" }));
  const reopened = flag(resolved, "pronunciation");
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].resolvedAt, undefined);
  assert.deepEqual(reopened[0].kinds, ["pronunciation"]);
  assert.equal(resolved[0].resolvedAt, "2026-11-16T01:00:00.000Z");
});

test("归一化兼容旧数据并过滤无效问题，导出保留中文问题和原题定位信息", () => {
  assert.deepEqual(normalizeWordIssues(undefined), []);
  assert.deepEqual(normalizeWordIssues([null, {}, { word }]), []);
  const issue = flag()[0];
  const normalized = normalizeWordIssues([
    { ...issue, kinds: ["wording", "wording", "unknown"] },
    { ...issue, kinds: [] },
    { ...issue, createdAt: "invalid" },
  ]);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0].kinds, ["wording"]);
  const exported = JSON.parse(exportWordIssues(normalized));
  assert.deepEqual(exported.issues[0].word, word);
  assert.equal(exported.issues[0].lessonLabel, lessonLabel);
  assert.deepEqual(exported.issues[0].problems, ["组词不合适"]);
});

test("SQLite 保存、重启、处理和取消标记；兼容旧客户端且不影响学习成绩", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ziqu-word-issues-"));
  const databasePath = path.join(directory, "learning.sqlite");
  const catalog = openCatalogDatabase(":memory:");
  let learning = openLearningDatabase(databasePath);
  try {
    const base = getState(learning, catalog);
    assert.deepEqual(base.wordIssues, []);
    const state = {
      ...base,
      wordStats: { [word.id]: { attempts: 2, mistakes: 1, streak: 1 } },
      charStats: { 行: { attempts: 2, mistakes: 1, streak: 1, correctWordTexts: ["银行"], wrongWordTexts: ["行走"] } },
      wordIssues: flag(flag(), "pronunciation"),
    };
    saveState(learning, state);
    learning.close();
    learning = openLearningDatabase(databasePath);
    const restored = getState(learning, catalog);
    assert.deepEqual(restored.wordIssues, normalizeWordIssues(state.wordIssues));
    assert.equal(restored.wordStats[word.id].attempts, 2);
    assert.equal(restored.charStats.行.mistakes, 1);
    assert.deepEqual(restored.logs, []);
    assert.deepEqual(getState(learning, catalog, "another-student").wordIssues, []);

    const resolvedAt = "2026-11-16T01:00:00.000Z";
    saveState(learning, { ...restored, wordIssues: restored.wordIssues.map((issue) => ({ ...issue, resolvedAt })) });
    const resolved = getState(learning, catalog);
    assert.equal(resolved.wordIssues[0].resolvedAt, resolvedAt);
    const { wordIssues: ignored, ...oldClientState } = resolved;
    saveState(learning, oldClientState);
    assert.equal(getState(learning, catalog).wordIssues.length, 1);

    saveState(learning, { ...resolved, wordIssues: [] });
    const cancelled = getState(learning, catalog);
    assert.deepEqual(cancelled.wordIssues, []);
    assert.deepEqual(cancelled.charStats, restored.charStats);
    assert.deepEqual(cancelled.wordStats, restored.wordStats);
  } finally {
    learning.close();
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
