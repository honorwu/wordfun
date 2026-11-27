import assert from "node:assert/strict";
import test from "node:test";
import { lessonOrder, progressOrder } from "../shared/domain/catalog.ts";
import { charReviewKey } from "../shared/domain/characters.ts";
import { generatePoetryPractice, generateScreeningPractice, getScreeningTargetChars, summarizeCoverage } from "../shared/domain/practice.ts";
import { hasQuestionAttempt, isMasteredChar, isMasteredQuestion } from "../shared/domain/reviewPolicy.ts";
import { addMissedWrongChars, applyReviewResult } from "../shared/domain/reviews.ts";
import { createDefaultState } from "../shared/domain/state.ts";

const progress = { grade: 3, lessonId: "current" };
const word = (id, text, chars) => ({ id, text, chars, pinyin: "", grade: 3, lessonId: "previous", lessonTitle: "前课", category: "一类" });
const withStoredQuestions = (lessons) => lessons.map((lesson) => ({
  ...lesson, dictationWords: lesson.dictationWords ?? [...(lesson.textbookWords ?? []), ...lesson.words],
}));
const items = [word("mountains", "山河", ["山"]), word("green", "青山", ["山"])].map((word) => ({ word, score: 1, reasons: [] }));
const context = { practiceMode: "lesson", lessons: [{ id: "previous", title: "前课" }] };

test("同场重复生字只累计一次，任一词写错则本场计错，保留逐题计分快照", () => {
  const initial = createDefaultState(progress);
  const next = applyReviewResult(initial, items, new Set([charReviewKey("mountains", "山")]), context);
  assert.equal(next.charStats["山"].attempts, 1);
  assert.equal(next.charStats["山"].mistakes, 1);
  assert.deepEqual(next.charStats["山"].correctWordTexts, ["青山"]);
  assert.deepEqual(next.charStats["山"].wrongWordTexts, ["山河"]);
  assert.equal(next.wordStats.green.mistakes, 0);
  assert.deepEqual(next.logs[0].wrongChars, [{ wordId: "mountains", char: "山" }]);
  assert.deepEqual(next.logs[0].reviewedItems, [
    { wordId: "mountains", wordText: "山河", reviewedChars: ["山", "河"] },
    { wordId: "green", wordText: "青山", reviewedChars: ["青", "山"] },
  ]);
  assert.deepEqual(initial, createDefaultState(progress));
});

test("当课所有题词汉字参加计分，整题全对累计一次", () => {
  const next = applyReviewResult(createDefaultState(progress), items, new Set(), context);
  assert.equal(next.charStats["河"].attempts, 1);
  assert.equal(next.charStats["青"].attempts, 1);
  assert.equal(next.charStats["山"].attempts, 1);
  assert.equal(isMasteredChar(next.charStats["山"]), true);
  assert.equal(hasQuestionAttempt(next.wordStats.mountains), true);
  assert.equal(next.wordStats.mountains.attempts, 1);
  assert.equal(next.wordStats.mountains.streak, 1);
  assert.equal(isMasteredQuestion(next.wordStats.mountains), true);
  assert.equal(isMasteredQuestion(next.wordStats.green), true);
  const questions = items.map(({ word }) => word);
  assert.deepEqual(summarizeCoverage([...questions, word("health", "健康", ["健", "康"])], next), {
    totalWords: 3, totalChars: 3, reviewedChars: 1, wrongWords: 0, masteredWords: 2,
  });
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: questions },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ]);
  assert.deepEqual(generateScreeningPractice(lessons, next), []);
});

test("同题的两个考察字都错或单独搭配字写错，均只计一道错题", () => {
  const health = { word: word("health", "健康", ["健", "康"]), score: 1, reasons: [] };
  const wrong = new Set([charReviewKey("health", "健"), charReviewKey("health", "康"), charReviewKey("mountains", "河")]);
  const next = applyReviewResult(createDefaultState(progress), [health, items[0], health], wrong, context);
  assert.equal(next.wordStats.health.attempts, 1);
  assert.equal(next.wordStats.health.mistakes, 1);
  assert.equal(next.wordStats.mountains.attempts, 1);
  assert.equal(next.wordStats.mountains.mistakes, 1);
  assert.deepEqual(next.logs[0].wrongWordIds, ["health", "mountains"]);
  assert.deepEqual(next.logs[0].wrongChars, [
    { wordId: "health", char: "健" }, { wordId: "health", char: "康" }, { wordId: "mountains", char: "河" },
  ]);
});

test("历史复习整词计分，即使同词中的字已掌握也能重新判错", () => {
  const initial = createDefaultState(progress);
  initial.charStats.河 = { attempts: 1, mistakes: 0, streak: 1 };
  const wrong = new Set([charReviewKey("mountains", "河")]);
  const next = applyReviewResult(initial, items.slice(0, 1), wrong, { ...context, practiceMode: "history" });
  assert.equal(next.charStats.河.attempts, 2);
  assert.equal(next.charStats.河.mistakes, 1);
  assert.equal(isMasteredChar(next.charStats.河), false);
  assert.equal(next.charStats.山.attempts, 1);
  assert.deepEqual(next.logs[0].wrongChars, [{ wordId: "mountains", char: "河" }]);
  assert.deepEqual(next.logs[0].reviewedItems[0].reviewedChars, ["山", "河"]);
});

test("补记修改原场次且不增加作答次数，重复提交不会重复累计错误", () => {
  const state = applyReviewResult(createDefaultState(progress), items, new Set(), context);
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

test("补记已有部分计分场次只接收当时的计分字，整题错误只累计一次", () => {
  const id = "partial-review";
  const date = "2026-11-03T12:00:00.000Z";
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const initial = createDefaultState(progress);
  initial.wordStats.mountains = { attempts: 0, mistakes: 0, streak: 0, lastReviewedAt: date };
  initial.charStats.山 = { attempts: 1, mistakes: 0, streak: 1, lastReviewedAt: date, correctWordTexts: ["山河"] };
  initial.logs = [{
    ...context, id, date, wordIds: ["mountains"], wrongWordIds: [], wrongChars: [],
    reviewedItems: [{ wordId: "mountains", wordText: "山河", reviewedChars: ["山"] }],
  }];
  const words = new Map([["mountains", items[0].word]]);
  assert.equal(addMissedWrongChars(initial, id, [{ wordId: "mountains", char: "河" }], words, now), initial);
  const corrections = [{ wordId: "mountains", char: "山" }];
  const next = addMissedWrongChars(initial, id, corrections, words, now);
  assert.equal(next.wordStats.mountains.attempts, 1);
  assert.equal(next.wordStats.mountains.mistakes, 1);
  assert.equal(next.charStats.山.attempts, 1);
  assert.equal(next.charStats.山.mistakes, 1);
  assert.equal(next.logs.length, 1);
  assert.equal(addMissedWrongChars(next, id, corrections, words, now), next);
});

test("补记窗口包含完成后的第 72 小时，之后保持原记录", () => {
  const state = applyReviewResult(createDefaultState(progress), items, new Set(), context);
  const log = state.logs[0];
  const words = new Map(items.map(({ word }) => [word.id, word]));
  const corrections = [{ wordId: "mountains", char: "山" }];
  const deadline = Date.parse(log.date) + 72 * 60 * 60 * 1000;
  assert.equal(addMissedWrongChars(state, log.id, corrections, words, deadline).wordStats.mountains.mistakes, 1);
  assert.equal(addMissedWrongChars(state, log.id, corrections, words, deadline + 1), state);
});

test("补记按更正后的累计对错判定掌握，补记最近一场后仍可掌握", (t) => {
  const firstTime = Date.UTC(2026, 10, 10, 12);
  t.mock.timers.enable({ apis: ["Date"], now: firstTime });
  const question = items[0];
  let state = createDefaultState(progress);
  for (let hour = 0; hour < 4; hour++) {
    t.mock.timers.setTime(firstTime + hour * 60 * 60 * 1000);
    state = applyReviewResult(state, [question], new Set(), context);
  }
  const latest = state.logs[0];
  const earliest = state.logs.at(-1);
  const corrections = [{ wordId: question.word.id, char: "山" }];
  const words = new Map([[question.word.id, question.word]]);

  const latestCorrected = addMissedWrongChars(state, latest.id, corrections, words);
  assert.equal(latestCorrected.wordStats.mountains.attempts, 4);
  assert.equal(latestCorrected.wordStats.mountains.mistakes, 1);
  assert.equal(isMasteredQuestion(latestCorrected.wordStats.mountains), true);

  const bothCorrected = addMissedWrongChars(latestCorrected, earliest.id, corrections, words);
  assert.equal(bothCorrected.wordStats.mountains.attempts, 4);
  assert.equal(bothCorrected.wordStats.mountains.mistakes, 2);
  assert.equal(isMasteredQuestion(bothCorrected.wordStats.mountains), false);
  assert.equal(bothCorrected.wordStats.mountains.lastMistakeAt, latest.date);
  assert.equal(bothCorrected.logs.length, 4);
});

test("历史错题每次复测间隔五天，错两次后累计对三次才掌握", (t) => {
  const fiveDays = 5 * 24 * 60 * 60 * 1000;
  const lastMistake = Date.UTC(2026, 10, 10, 15);
  t.mock.timers.enable({ apis: ["Date"], now: lastMistake });
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", directDictation: true, words: [word("mountains", "山河", ["山", "河"])] },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ]);
  let state = createDefaultState(progress);
  state.wordStats.mountains = { attempts: 2, mistakes: 2, streak: 0, lastMistakeAt: new Date(lastMistake).toISOString() };
  const historyContext = { ...context, practiceMode: "history" };
  for (const correctCount of [1, 2, 3]) {
    const dueAt = lastMistake + correctCount * fiveDays;
    t.mock.timers.setTime(dueAt - 1);
    assert.deepEqual(generateScreeningPractice(lessons, state), []);
    t.mock.timers.setTime(dueAt);
    const restudy = generateScreeningPractice(lessons, state);
    assert.deepEqual(restudy.map(({ word, historyGroup }) => [word.id, historyGroup]), [["mountains", "mistake"]]);
    state = applyReviewResult(state, restudy, new Set(), historyContext);
    assert.equal(state.wordStats.mountains.attempts, 2 + correctCount);
    assert.equal(state.wordStats.mountains.mistakes, 2);
    assert.equal(isMasteredQuestion(state.wordStats.mountains), correctCount === 3);
  }

  const againAt = lastMistake + 4 * fiveDays;
  t.mock.timers.setTime(againAt);
  assert.deepEqual(generateScreeningPractice(lessons, state), []);

  const lessonItems = [items[0]];
  const wrong = new Set([charReviewKey("mountains", "山")]);
  const tied = applyReviewResult(state, lessonItems, wrong, context);
  assert.equal(tied.wordStats.mountains.attempts, 6);
  assert.equal(tied.wordStats.mountains.mistakes, 3);
  assert.equal(isMasteredQuestion(tied.wordStats.mountains), false);

  const extraCorrect = applyReviewResult(state, lessonItems, new Set(), context);
  const stillMastered = applyReviewResult(extraCorrect, lessonItems, wrong, context);
  assert.equal(stillMastered.wordStats.mountains.attempts, 7);
  assert.equal(stillMastered.wordStats.mountains.mistakes, 3);
  assert.equal(isMasteredQuestion(stillMastered.wordStats.mountains), true);

  t.mock.timers.setTime(againAt + fiveDays - 1);
  assert.deepEqual(generateScreeningPractice(lessons, tied), []);
  t.mock.timers.setTime(againAt + fiveDays);
  assert.deepEqual(generateScreeningPractice(lessons, tied).map(({ word, historyGroup }) => [word.id, historyGroup]), [["mountains", "mistake"]]);
  assert.deepEqual(generateScreeningPractice(lessons, stillMastered), []);
});

test("旧错字按新题到期复练，承接和题级错题共用配额", (t) => {
  const available = new Date(2026, 10, 19, 12).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: available - 1 });
  const dueIds = Array.from("甲乙丙");
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课",
      words: [word("mountains", "山河", ["山"]), ...dueIds.map((char) => word(char, char, [char])), word("older", "荻花", ["荻"]), word("fresh", "新题", ["新"])] },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [{ ...word("current-question", "本课", ["本"]), lessonId: "current" }] },
  ]);
  const state = createDefaultState(progress);
  for (const id of dueIds) state.wordStats[id] = { attempts: 1, mistakes: 1, streak: 0 };
  const carryover = {
    mountains: { baselineAttempts: 0, availableAt: new Date(available).toISOString() },
    older: { baselineAttempts: 0, availableAt: null },
    甲: { baselineAttempts: 1, availableAt: null },
    "current-question": { baselineAttempts: 0, availableAt: null },
  };
  const getItems = (current) => generateScreeningPractice(lessons, current, 20, { carryover });
  assert.deepEqual(getItems(state).map(({ word }) => word.id), [...dueIds, "older", "fresh"]);
  t.mock.timers.setTime(available);
  const atDue = getItems(state);
  assert.deepEqual(atDue.map(({ word }) => word.id), [...dueIds, "older", "mountains", "fresh"]);
  assert.equal(atDue.filter(({ historyGroup }) => historyGroup === "mistake").length, 5);
  assert.deepEqual(atDue.map(({ mistakeReview }) => mistakeReview), ["word", "word", "word", "character", "character", undefined]);

  const historyContext = { ...context, practiceMode: "history" };
  const carried = atDue.find(({ word }) => word.id === "mountains");
  const finished = applyReviewResult(state, [carried], new Set(), historyContext);
  assert.equal(finished.wordStats.mountains.attempts, 1);
  assert.ok(!getItems(finished).some(({ word }) => word.id === "mountains"));
  assert.ok(!generateScreeningPractice(lessons, finished, 20, {
    carryover: { ...carryover, mountains: { ...carryover.mountains, baselineAttempts: 1 } },
  }).some(({ word }) => word.id === "mountains"));

  const missed = applyReviewResult(state, [carried], new Set([charReviewKey("mountains", "河")]), historyContext);
  assert.equal(missed.wordStats.mountains.mistakes, 1);
  assert.ok(!getItems(missed).some(({ word }) => word.id === "mountains"));
  t.mock.timers.setTime(available + 120 * 60 * 60 * 1000);
  assert.equal(getItems(missed).find(({ word }) => word.id === "mountains").mistakeReview, "word");
});

test("一轮最多五道错词，新题不足不拿错词凑数，混合词也遵守间隔与配额", (t) => {
  const now = new Date(2026, 10, 19, 12).getTime();
  t.mock.timers.enable({ apis: ["Date"], now });
  const oldChars = Array.from("甲乙丙丁戊己庚");
  const newChars = Array.from("子丑寅卯辰巳午未申酉戌亥清河田禾木玉水火");
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课",
      words: [
        ...[...oldChars, ...newChars].map((char) => word(char, char, [char])),
        word("cooling-mixed", "迟花", ["迟", "花"]), word("due-mixed", "庚果", ["庚", "果"]),
      ] },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ]);
  const state = createDefaultState(progress);
  for (const id of [...oldChars, "due-mixed"]) state.wordStats[id] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: "2026-11-01T00:00:00.000Z" };
  state.wordStats["cooling-mixed"] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date(now).toISOString() };
  const items = generateScreeningPractice(lessons, state);
  assert.deepEqual(items.slice(0, 5).map(({ word }) => word.text), oldChars.slice(0, 5));
  assert.equal(items.length, 20);
  assert.ok(items.slice(5).every(({ word, historyGroup }) => (historyGroup === "recent" || historyGroup === "basic")
    && Array.from(word.text).every((char) => !oldChars.includes(char) && char !== "迟")));

  for (const id of newChars.slice(2)) state.wordStats[id] = { attempts: 1, mistakes: 0, streak: 1 };
  const after = generateScreeningPractice(lessons, state);
  assert.deepEqual(after.filter(({ historyGroup }) => historyGroup === "mistake").map(({ word }) => word.text), oldChars.slice(0, 5));
  assert.deepEqual(after.filter(({ historyGroup }) => historyGroup !== "mistake").map(({ word }) => word.text), newChars.slice(0, 2));
});

test("古诗题保留题目、朝代、作者和正文，不提供历史复习字或组词", () => {
  const poetry = {
    id: "poetry", grade: 3, unit: 1, number: 2, title: "登山", lessonKind: "classical_poetry",
    words: [{ ...word("poetry-word", "青峰", ["青", "峰"]), lessonId: "poetry", pinyin: "qīng fēng" }],
    dictationWords: [{ ...word("poem-poem", "登山\n唐\n诗人\n青峰。", ["登", "山", "唐", "诗", "人", "青", "峰"]), lessonId: "poetry", pinyin: "dēng shān\nqīng fēng" }],
    classicalTexts: [{
      id: "poem", title: "登山", dynasty: "唐", author: "诗人", titlePinyin: "dēng shān",
      lines: [{ text: "青峰。", pinyin: "qīng fēng" }],
    }],
  };
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: [word("green", "青", ["青"])] },
    poetry,
    { id: "current", grade: 3, unit: 1, number: 3, title: "本课", words: [] },
  ]);
  const poemItems = generatePoetryPractice(poetry);
  assert.deepEqual(poemItems.map(({ word }) => word.text), ["登山\n唐\n诗人\n青峰。"]);
  const state = createDefaultState(progress);
  state.wordStats["poem-poem"] = { attempts: 1, mistakes: 1, streak: 0 };
  assert.deepEqual(getScreeningTargetChars(lessons, progress), ["青"]);
  assert.deepEqual(generateScreeningPractice(lessons, state).map(({ word }) => word.text), ["青"]);
});

test("历史复习按原题保留语境，同字或同词的另一课题目独立计分", () => {
  const previous = {
    id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: [],
    textbookWords: [{ ...word("textbook", "水平", ["水", "平"]), pinyin: "shuǐ píng" }],
  };
  const recent = {
    id: "recent", grade: 3, unit: 1, number: 2, title: "近课",
    words: [word("level", "平", ["平"]), word("base", "垒", ["垒"])].map((item) => ({ ...item, lessonId: "recent" })),
    dictationWords: [
      { ...word("textbook-later", "水平", ["水", "平"]), lessonId: "recent", pinyin: "shuǐ píng" },
      { ...word("level", "平地", ["平"]), lessonId: "recent", pinyin: "píng dì" },
      { ...word("base", "堡垒", ["垒"]), lessonId: "recent", pinyin: "bǎo lěi", textbookHint: "这个〔　〕很坚固。" },
    ],
  };
  const current = {
    id: "current", grade: 3, unit: 1, number: 3, title: "本课", words: [],
    textbookWords: [{ ...word("current-word", "堡垒", ["堡", "垒"]), lessonId: "current", pinyin: "bǎo lěi" }],
  };
  const state = createDefaultState(progress);
  state.wordStats = {
    textbook: { attempts: 1, mistakes: 1, streak: 0 }, base: { attempts: 1, mistakes: 1, streak: 0 },
    level: { attempts: 1, mistakes: 0, streak: 1 }, "textbook-later": { attempts: 1, mistakes: 0, streak: 1 },
  };
  const lessons = withStoredQuestions([previous, recent, current]);
  const items = generateScreeningPractice(lessons, state);
  const mistakes = items.filter(({ historyGroup }) => historyGroup === "mistake");
  assert.deepEqual(mistakes.map(({ word, reasons }) => [word.text, word.chars, reasons[1]]), [
    ["水平", ["水", "平"], "词语表"], ["堡垒", ["垒"], "课文取词"],
  ]);
  assert.equal(mistakes[1].word.textbookHint, "这个〔　〕很坚固。");
  assert.equal(mistakes[1].word.lessonId, "recent");
  assert.ok(!items.some(({ word }) => word.id === "textbook-later"));
  delete state.wordStats["textbook-later"];
  const next = generateScreeningPractice(lessons, state);
  assert.deepEqual(next.filter(({ mistakeReview }) => mistakeReview).map(({ word }) => word.id), [
    "textbook", "base",
  ]);
  assert.ok(next.some(({ word, mistakeReview }) => word.id === "textbook-later" && !mistakeReview));
});

test("历史整词不借组词引入教材范围外的字", () => {
  const outsideCompanion = { text: "砌成", pinyin: "qì chéng", chars: ["砌", "成"] };
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: [word("grow", "成", ["成"])],
      textCompanions: { 成: [outsideCompanion] } },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ]);
  const state = createDefaultState(progress);
  state.charStats = { 砌: { attempts: 1, mistakes: 1, streak: 0 }, 成: { attempts: 1, mistakes: 1, streak: 0 } };
  const practice = generateScreeningPractice(lessons, state);
  assert.deepEqual(practice.map(({ word }) => word.text), ["成"]);
  assert.deepEqual(getScreeningTargetChars(lessons, progress), ["成"]);
});

test("历史复习先练到期错题，等待期间继续练新题，再复测直至全部掌握", (t) => {
  const startDay = new Date(2026, 10, 3, 12).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: startDay });
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: [
      word("mountain", "山", ["山"]), word("river", "河", ["河"]), word("green", "青", ["青"]),
    ] },
    { id: "recent", grade: 3, unit: 1, number: 2, title: "近课", words: [
      { ...word("new", "新", ["新"]), lessonId: "recent" },
    ] },
    { id: "current", grade: 3, unit: 1, number: 3, title: "本课", words: [] },
  ]);
  let state = createDefaultState(progress);
  state.wordStats.mountain = { attempts: 1, mistakes: 1, streak: 0 };
  state.wordStats.river = { attempts: 1, mistakes: 0, streak: 1 };
  const nextItems = () => generateScreeningPractice(lessons, state, 1);
  const practice = (expectedChar, wrong = false) => {
    const items = nextItems();
    assert.deepEqual(items.map(({ word }) => word.chars), [[expectedChar]]);
    const wrongKeys = wrong ? [charReviewKey(items[0].word.id, expectedChar)] : [];
    state = applyReviewResult(state, items, new Set(wrongKeys), { ...context, practiceMode: "history" });
  };
  practice("山");
  practice("新", true);
  practice("青");
  assert.deepEqual(nextItems(), []);
  t.mock.timers.setTime(new Date(2026, 10, 8, 12).getTime());
  practice("山");
  practice("新");
  assert.equal(isMasteredQuestion(state.wordStats.new), false);
  assert.deepEqual(nextItems(), []);
  t.mock.timers.setTime(new Date(2026, 10, 13, 12).getTime());
  practice("新");
  assert.ok(Object.values(state.wordStats).every(isMasteredQuestion));
  assert.deepEqual(nextItems(), []);
});

test("历史复习有足够候选时按 5、10、5 出题，完成后推进未练题", (t) => {
  const now = Date.UTC(2026, 10, 20, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const makeWords = (lessonId, characters) => Array.from(characters, (char) => ({
    ...word(`${lessonId}-${char}`, char, [char]), lessonId,
  }));
  const oldest = makeWords("oldest", "木林本末田由电生米禾尘尖").map((item) => ({ ...item, grade: 2 }));
  const middle = makeWords("middle", "日月水火土金石竹泉雨云风");
  const recent = makeWords("recent", "春夏秋冬东西南北山海");
  const due = makeWords("middle", "甲乙丙丁戊己庚辛壬癸");
  const [cooling, mastered] = makeWords("recent", "冰雪");
  const current = makeWords("current", "高低");
  const future = makeWords("future", "远近");
  const lessons = withStoredQuestions([
    { id: "recent", grade: 3, unit: 1, number: 3, title: "近课", words: [cooling, mastered, ...recent] },
    { id: "current", grade: 3, unit: 1, number: 4, title: "本课", words: current },
    { id: "oldest", grade: 2, unit: 1, number: 1, title: "最早课", words: oldest },
    { id: "future", grade: 3, unit: 1, number: 5, title: "后续课", words: future },
    { id: "middle", grade: 3, unit: 1, number: 2, title: "前课", words: [...middle, ...due] },
  ]);
  const ids = (words) => words.map(({ id }) => id);
  const dueIds = new Set(ids(due));
  const middleIds = new Set(ids(middle));
  const excludedIds = new Set(ids([cooling, mastered, ...current, ...future]));
  let state = createDefaultState(progress);
  const pastMistake = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
  for (const { id } of due) state.wordStats[id] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: pastMistake };
  state.wordStats[cooling.id] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date(now).toISOString() };
  state.wordStats[mastered.id] = { attempts: 1, mistakes: 0, streak: 1 };

  const fewerDue = { ...state, wordStats: { ...state.wordStats } };
  for (const { id } of due.slice(3)) fewerDue.wordStats[id] = state.wordStats[cooling.id];
  const filled = generateScreeningPractice(lessons, fewerDue);
  assert.deepEqual(["mistake", "recent", "basic"].map((group) => filled.filter(({ historyGroup }) => historyGroup === group).length), [3, 12, 5]);

  const round = () => {
    const items = generateScreeningPractice(lessons, state);
    const questionIds = items.map(({ word }) => word.id);
    const idsInGroup = (group) => items.filter(({ historyGroup }) => historyGroup === group).map(({ word }) => word.id);
    const mistakes = idsInGroup("mistake");
    const recent = idsInGroup("recent");
    const basic = idsInGroup("basic");
    assert.equal(new Set(questionIds).size, items.length);
    assert.ok(questionIds.every((id) => !excludedIds.has(id)));
    assert.ok(mistakes.every((id) => dueIds.has(id)));
    return { items, mistakes, recent, basic };
  };

  const first = round();
  assert.equal(first.items.length, 20);
  assert.equal(first.mistakes.length, 5);
  assert.deepEqual(new Set(first.recent), new Set(ids(recent)));
  assert.deepEqual(first.basic, ids(oldest).slice(0, 5));
  state = applyReviewResult(state, first.items, new Set());

  const second = round();
  assert.equal(second.items.length, 20);
  assert.equal(second.mistakes.length, 5);
  assert.equal(second.recent.length, 10);
  assert.ok(second.recent.every((id) => middleIds.has(id)));
  assert.deepEqual(second.basic, ids(oldest).slice(5, 10));
  state = applyReviewResult(state, second.items, new Set());

  const practiced = new Set([...first.items, ...second.items].map(({ word }) => word.id));
  assert.equal(practiced.size, first.items.length + second.items.length);
  const remaining = ids([...oldest, ...middle, ...recent]).filter((id) => !practiced.has(id));
  const third = round();
  assert.equal(third.items.length, 4);
  assert.deepEqual(new Set([...third.recent, ...third.basic]), new Set(remaining));
  state = applyReviewResult(state, third.items, new Set());
  assert.deepEqual(round().items, []);
});

test("部分计分且尚无整题成绩的旧题可以安排完整默写", () => {
  const recent = [
    { ...word("partial", "花", ["花"]), lessonId: "recent" },
    { ...word("fresh", "草", ["草"]), lessonId: "recent" },
  ];
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: Array.from("甲乙丙丁戊", (char) => word(char, char, [char])) },
    { id: "recent", grade: 3, unit: 1, number: 2, title: "近课", words: recent },
    { id: "current", grade: 3, unit: 1, number: 3, title: "本课", words: [] },
  ]);
  const state = createDefaultState(progress);
  state.wordStats.partial = { attempts: 0, mistakes: 0, streak: 0, lastReviewedAt: "2026-11-10T12:00:00.000Z" };
  assert.equal(isMasteredQuestion(state.wordStats.partial), false);
  const round = generateScreeningPractice(lessons, state);
  assert.deepEqual(round.filter(({ historyGroup }) => historyGroup === "recent").map(({ word }) => word.id), ["partial", "fresh"]);
  const first = generateScreeningPractice(lessons, state, 1);
  assert.deepEqual(first.map(({ word, historyGroup }) => [word.id, historyGroup]), [["partial", "recent"]]);
  const graded = applyReviewResult(state, first, new Set());
  assert.equal(isMasteredQuestion(graded.wordStats.partial), true);
  assert.ok(!generateScreeningPractice(lessons, graded).some(({ word }) => word.id === "partial"));
});

test("到期错题先按到期时间，再按教材课次和题序选入五个席位", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  const dayMs = 24 * 60 * 60 * 1000;
  const date = (days) => new Date(now + days * dayMs).toISOString();
  const createQuestions = (lessonId, entries) => entries.map(([id, char]) => ({ ...word(id, char, [char]), lessonId }));
  const lessons = withStoredQuestions([
    { id: "recent", grade: 3, unit: 1, number: 2, title: "近课", words: createQuestions("recent", [
      ["near-tie", "水"], ["earliest-due", "火"], ["cooling", "土"],
    ]) },
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: createQuestions("previous", [
      ["later-review", "山"], ["later-mistake", "云"], ["z-first-in-lesson", "风"],
      ["a-second-in-lesson", "雨"], ["undated", "雪"],
    ]) },
    { id: "current", grade: 3, unit: 1, number: 3, title: "本课", words: [] },
  ]);
  const state = createDefaultState(progress);
  const wrong = { attempts: 1, mistakes: 1, streak: 0 };
  state.wordStats = {
    "later-review": { ...wrong, lastReviewedAt: date(-6), lastMistakeAt: date(-16) },
    "later-mistake": { ...wrong, lastReviewedAt: date(-17), lastMistakeAt: date(-6) },
    "z-first-in-lesson": { ...wrong, lastMistakeAt: date(-8) },
    undated: wrong,
    "near-tie": { ...wrong, lastMistakeAt: date(-8) },
    "earliest-due": { ...wrong, lastReviewedAt: date(-13) },
    cooling: { ...wrong, lastReviewedAt: date(-4) },
  };
  const carryover = { "a-second-in-lesson": { baselineAttempts: 0, availableAt: date(-3) } };
  const expected = ["undated", "earliest-due", "z-first-in-lesson", "a-second-in-lesson", "near-tie"];
  assert.deepEqual(generateScreeningPractice(lessons, state, 20, { now, carryover }).map(({ word, historyGroup }) => [word.id, historyGroup]),
    expected.map((id) => [id, "mistake"]));
  assert.deepEqual(generateScreeningPractice(lessons, state, 1, { now, carryover }).map(({ word, historyGroup }) => [word.id, historyGroup]),
    [["undated", "mistake"]]);
});

test("未练基础题不足五道时只排剩余未练题", (t) => {
  const now = Date.UTC(2026, 10, 20, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const oldLesson = "grade-two-first";
  const untouched = [
    { ...word("z-first", "木", ["木"]), grade: 2, lessonId: oldLesson },
    { ...word("a-second", "林", ["林"]), grade: 2, lessonId: oldLesson },
  ];
  const mastered = Array.from("山水日月田", (char) => ({ ...word(char, char, [char]), lessonId: "recent" }));
  const cooling = { ...word("cooling", "冰", ["冰"]), lessonId: "recent" };
  const lessons = withStoredQuestions([
    { id: oldLesson, grade: 2, unit: 1, number: 1, title: "二上最早课", words: untouched },
    { id: "recent", grade: 3, unit: 1, number: 2, title: "近课", words: [...mastered, cooling] },
    { id: "current", grade: 3, unit: 1, number: 3, title: "本课", words: [] },
  ]);
  const state = createDefaultState(progress);
  for (const { id } of mastered) state.wordStats[id] = { attempts: 1, mistakes: 0, streak: 1 };
  state.wordStats[cooling.id] = { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: new Date(now).toISOString() };
  const first = generateScreeningPractice(lessons, state);
  assert.deepEqual(first.map(({ word, historyGroup }) => [word.id, historyGroup]), untouched.map(({ id }) => [id, "basic"]));
  const graded = applyReviewResult(state, first, new Set());
  assert.deepEqual(generateScreeningPractice(lessons, graded), []);
});

test("progressOrder 找不到课次时按同量级年级序兜底", () => {
  const gradeTwoLesson = { id: "g2-1", grade: 2, unit: 1, number: 1, title: "二上第一课", words: [] };
  const fallback = progressOrder({ grade: 3, lessonId: "missing-lesson" }, [gradeTwoLesson]);
  assert.equal(fallback, 30000);
  assert.ok(fallback > lessonOrder(gradeTwoLesson));
});
