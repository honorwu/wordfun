import assert from "node:assert/strict";
import test from "node:test";
import { charReviewKey } from "../shared/domain/characters.ts";
import { generateScreeningPractice } from "../shared/domain/practice.ts";
import { isMasteredChar } from "../shared/domain/reviewPolicy.ts";
import { addMissedWrongChars, applyReviewResult } from "../shared/domain/reviews.ts";
import { createDefaultState } from "../shared/domain/state.ts";

const progress = { grade: 3, lessonId: "current" };
const word = (id, text, chars) => ({ id, text, chars, pinyin: "", grade: 3, lessonId: "previous", lessonTitle: "前课", category: "一类" });
const items = [word("mountains", "山河", ["山"]), word("green", "青山", ["山"])].map((word) => ({ word, score: 1, reasons: [] }));
const context = { practiceMode: "lesson", lessons: [{ id: "previous", title: "前课" }] };

test("同场重复生字只累计一次，任一词写错则本场计错，保留逐题计分快照", () => {
  const initial = createDefaultState(progress);
  const next = applyReviewResult(initial, items, new Set([charReviewKey("mountains", "山")]), undefined, context);
  assert.equal(next.charStats["山"].attempts, 1);
  assert.equal(next.charStats["山"].mistakes, 1);
  assert.deepEqual(next.charStats["山"].correctWordTexts, ["青山"]);
  assert.deepEqual(next.charStats["山"].wrongWordTexts, ["山河"]);
  assert.equal(next.wordStats.green.mistakes, 0);
  assert.deepEqual(next.logs[0].wrongChars, [{ wordId: "mountains", char: "山" }]);
  assert.deepEqual(next.logs[0].reviewedItems, [
    { wordId: "mountains", wordText: "山河", reviewedChars: ["山"] },
    { wordId: "green", wordText: "青山", reviewedChars: ["山"] },
  ]);
  assert.deepEqual(initial, createDefaultState(progress));
});

test("显式计分范围区分提示字与独立默写字", () => {
  const reviewed = new Map([["mountains", ["山"]], ["green", ["青", "山"]]]);
  const next = applyReviewResult(createDefaultState(progress), items, new Set(), reviewed, context);
  assert.equal(next.charStats["河"], undefined);
  assert.equal(next.charStats["青"].attempts, 1);
  assert.equal(next.charStats["山"].attempts, 1);
  assert.equal(isMasteredChar(next.charStats["山"]), true);
});

test("补记修改原场次且不增加作答次数，重复提交不会重复累计错误", () => {
  const state = applyReviewResult(createDefaultState(progress), items, new Set(), undefined, context);
  const id = state.logs[0].id;
  const corrections = [{ wordId: "mountains", char: "山" }, { wordId: "green", char: "山" }];
  const words = new Map(items.map((item) => [item.word.id, item.word]));
  const next = addMissedWrongChars(state, id, corrections, words);
  assert.equal(next.logs.length, 1);
  assert.equal(next.logs[0].id, id);
  assert.equal(next.charStats["山"].attempts, 1);
  assert.equal(next.charStats["山"].mistakes, 1);
  assert.equal(next.wordStats.mountains.attempts, 1);
  assert.equal(next.wordStats.mountains.mistakes, 1);
  assert.deepEqual(next.logs[0].wrongWordIds, ["mountains", "green"]);
  assert.equal(addMissedWrongChars(next, id, corrections, words), next);
  assert.equal(state.charStats["山"].mistakes, 0);
});

test("历史错字满七个本地自然日后再练，已掌握字退出历史题目", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 17, 12).getTime() });
  const lessons = [
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", directDictation: true, words: [word("mountains", "山河", ["山", "河"])] },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ];
  const state = createDefaultState(progress);
  state.charStats["山"] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date(2026, 10, 11, 23).toISOString() };
  state.charStats["河"] = { attempts: 1, mistakes: 0, streak: 1 };
  assert.deepEqual(generateScreeningPractice(lessons, state), []);
  state.charStats["山"].lastReviewedAt = new Date(2026, 10, 10, 23).toISOString();
  assert.deepEqual(generateScreeningPractice(lessons, state).map((item) => item.word.chars), [["山"]]);
});
