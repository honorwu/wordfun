import assert from "node:assert/strict";
import test from "node:test";
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
  const next = applyReviewResult(initial, items, new Set([charReviewKey("mountains", "山")]), undefined, context);
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

test("显式计分范围区分提示字与独立默写字", () => {
  const reviewed = new Map([["mountains", ["山"]], ["green", ["青", "山"]]]);
  const next = applyReviewResult(createDefaultState(progress), items, new Set(), reviewed, context);
  assert.equal(next.charStats["河"], undefined);
  assert.equal(next.charStats["青"].attempts, 1);
  assert.equal(next.charStats["山"].attempts, 1);
  assert.equal(isMasteredChar(next.charStats["山"]), true);
  assert.equal(hasQuestionAttempt(next.wordStats.mountains), true);
  assert.equal(next.wordStats.mountains.attempts, 0);
  assert.equal(isMasteredQuestion(next.wordStats.mountains), false);
  assert.equal(isMasteredQuestion(next.wordStats.green), true);
  const questions = items.map(({ word }) => word);
  assert.deepEqual(summarizeCoverage([...questions, word("health", "健康", ["健", "康"])], next), {
    totalWords: 3, totalChars: 3, reviewedChars: 1, wrongWords: 0, masteredWords: 1,
  });
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", words: questions },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ]);
  assert.deepEqual(generateScreeningPractice(lessons, next).map(({ word }) => word.id), ["mountains"]);
});

test("同题的两个考察字都错或单独搭配字写错，均只计一道错题", () => {
  const health = { word: word("health", "健康", ["健", "康"]), score: 1, reasons: [] };
  const reviewed = new Map([["mountains", ["山"]]]);
  const wrong = new Set([charReviewKey("health", "健"), charReviewKey("health", "康"), charReviewKey("mountains", "河")]);
  const next = applyReviewResult(createDefaultState(progress), [health, items[0], health], wrong, reviewed, context);
  assert.equal(next.wordStats.health.attempts, 1);
  assert.equal(next.wordStats.health.mistakes, 1);
  assert.equal(next.wordStats.mountains.mistakes, 1);
  assert.deepEqual(next.logs[0].wrongWordIds, ["health", "mountains"]);
  assert.deepEqual(next.logs[0].wrongChars, [
    { wordId: "health", char: "健" }, { wordId: "health", char: "康" }, { wordId: "mountains", char: "河" },
  ]);
});

test("历史复习整词计分，即使同词中的字已掌握也能重新判错", () => {
  const initial = createDefaultState(progress);
  initial.charStats.河 = { attempts: 1, mistakes: 0, streak: 1 };
  const reviewed = new Map([["mountains", ["山"]]]);
  const wrong = new Set([charReviewKey("mountains", "河")]);
  const next = applyReviewResult(initial, items.slice(0, 1), wrong, reviewed, { ...context, practiceMode: "history" });
  assert.equal(next.charStats.河.attempts, 2);
  assert.equal(next.charStats.河.mistakes, 1);
  assert.equal(isMasteredChar(next.charStats.河), false);
  assert.equal(next.charStats.山.attempts, 1);
  assert.deepEqual(next.logs[0].wrongChars, [{ wordId: "mountains", char: "河" }]);
  assert.deepEqual(next.logs[0].reviewedItems[0].reviewedChars, ["山", "河"]);
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

test("带提示且未评完整题的练习，补记实际计分字后只增加一次可判定错题", () => {
  const reviewed = new Map([["mountains", ["山"]]]);
  const initial = applyReviewResult(createDefaultState(progress), items.slice(0, 1), new Set(), reviewed, context);
  assert.equal(initial.wordStats.mountains.attempts, 0);
  const id = initial.logs[0].id;
  const words = new Map([["mountains", items[0].word]]);
  assert.equal(addMissedWrongChars(initial, id, [{ wordId: "mountains", char: "河" }], words), initial);
  const corrections = [{ wordId: "mountains", char: "山" }];
  const next = addMissedWrongChars(initial, id, corrections, words);
  assert.equal(next.wordStats.mountains.attempts, 1);
  assert.equal(next.wordStats.mountains.mistakes, 1);
  assert.equal(next.logs.length, 1);
  assert.equal(addMissedWrongChars(next, id, corrections, words), next);
});

test("历史错题满五天后才再练，已掌握题退出历史复习", (t) => {
  const fiveDays = 5 * 24 * 60 * 60 * 1000;
  const firstMistake = new Date(2026, 10, 10, 23).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: firstMistake + fiveDays - 1 });
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课", directDictation: true, words: [word("mountains", "山河", ["山", "河"])] },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [] },
  ]);
  const state = createDefaultState(progress);
  state.wordStats.mountains = { attempts: 1, mistakes: 1, streak: 0, lastMistakeAt: new Date(firstMistake).toISOString() };
  assert.deepEqual(generateScreeningPractice(lessons, state), []);
  t.mock.timers.setTime(firstMistake + fiveDays);
  const first = generateScreeningPractice(lessons, state);
  assert.deepEqual(first.map((item) => item.word), lessons[0].dictationWords);
  const afterFirst = applyReviewResult(state, first, new Set(), undefined, { ...context, practiceMode: "history" });
  assert.equal(isMasteredQuestion(afterFirst.wordStats.mountains), false);
  assert.deepEqual(generateScreeningPractice(lessons, afterFirst), []);
  t.mock.timers.setTime(firstMistake + 2 * fiveDays - 1);
  assert.deepEqual(generateScreeningPractice(lessons, afterFirst), []);
  t.mock.timers.setTime(firstMistake + 2 * fiveDays);
  const second = generateScreeningPractice(lessons, afterFirst);
  assert.deepEqual(second.map((item) => item.word), lessons[0].dictationWords);
  const mastered = applyReviewResult(afterFirst, second, new Set(), undefined, { ...context, practiceMode: "history" });
  t.mock.timers.setTime(firstMistake + 3 * fiveDays);
  assert.equal(isMasteredQuestion(mastered.wordStats.mountains), true);
  assert.deepEqual(generateScreeningPractice(lessons, mastered), []);
});

test("旧错字按新题到期复练，承接和题级错题共用配额", (t) => {
  const available = new Date(2026, 10, 19, 12).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: available - 1 });
  const dueIds = Array.from("甲乙丙丁");
  const lessons = withStoredQuestions([
    { id: "previous", grade: 3, unit: 1, number: 1, title: "前课",
      words: [word("mountains", "山河", ["山"]), ...dueIds.map((char) => word(char, char, [char])), word("older", "荻花", ["荻"]), word("fresh", "新题", ["新"])] },
    { id: "current", grade: 3, unit: 1, number: 2, title: "本课", words: [{ ...word("current-question", "本课", ["本"]), lessonId: "current" }] },
  ]);
  const state = createDefaultState(progress);
  state.wordStats.mountains = { attempts: 1, mistakes: 0, streak: 1 };
  for (const id of dueIds) state.wordStats[id] = { attempts: 1, mistakes: 1, streak: 0 };
  const carryover = {
    mountains: { baselineAttempts: 1, availableAt: new Date(available).toISOString() },
    older: { baselineAttempts: 0, availableAt: null },
    甲: { baselineAttempts: 1, availableAt: null },
    "current-question": { baselineAttempts: 0, availableAt: null },
  };
  const getItems = (current) => generateScreeningPractice(lessons, current, 20, 0, { carryover });
  assert.deepEqual(getItems(state).map(({ word }) => word.id), [...dueIds, "older", "fresh"]);
  t.mock.timers.setTime(available);
  const atDue = getItems(state);
  assert.deepEqual(atDue.map(({ word }) => word.id), ["mountains", ...dueIds, "fresh"]);
  assert.equal(atDue.filter(({ reasons }) => reasons.includes("错题再练")).length, 5);
  assert.deepEqual(atDue.map(({ mistakeReview }) => mistakeReview), ["character", "word", "word", "word", "word", undefined]);

  const hinted = applyReviewResult(state, [atDue[0]], new Set(), new Map([["mountains", ["山"]]]), context);
  assert.equal(hinted.wordStats.mountains.attempts, 1);
  assert.equal(getItems(hinted)[0].word.id, "mountains");

  const finished = applyReviewResult(hinted, [atDue[0]], new Set(), undefined, context);
  assert.equal(finished.wordStats.mountains.attempts, 2);
  assert.ok(!getItems(finished).some(({ word }) => word.id === "mountains"));

  const missed = applyReviewResult(hinted, [atDue[0]], new Set([charReviewKey("mountains", "河")]), undefined, context);
  assert.equal(missed.wordStats.mountains.mistakes, 1);
  assert.ok(!getItems(missed).some(({ word }) => word.id === "mountains"));
  t.mock.timers.setTime(available + 120 * 60 * 60 * 1000);
  assert.equal(getItems(missed)[0].word.id, "mountains");
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
  assert.ok(items.slice(5).every(({ word, reasons }) => reasons.includes("待完成整题")
    && Array.from(word.text).every((char) => !oldChars.includes(char) && char !== "迟")));

  for (const id of newChars.slice(2)) state.wordStats[id] = { attempts: 1, mistakes: 0, streak: 1 };
  assert.deepEqual(generateScreeningPractice(lessons, state).map(({ word }) => word.text), [...oldChars.slice(0, 5), ...newChars.slice(0, 2)]);
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
  assert.deepEqual(items.map(({ word, reasons }) => [word.text, word.chars, reasons[1]]), [
    ["堡垒", ["垒"], "课文取词"], ["水平", ["水", "平"], "词语表"],
  ]);
  assert.equal(items[0].word.textbookHint, "这个〔　〕很坚固。");
  assert.equal(items[0].word.lessonId, "recent");
  delete state.wordStats["textbook-later"];
  assert.deepEqual(generateScreeningPractice(lessons, state).map(({ word, mistakeReview }) => [word.id, mistakeReview]), [
    ["base", "word"], ["textbook", "word"], ["textbook-later", undefined],
  ]);
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
    state = applyReviewResult(state, items, new Set(wrongKeys), undefined, { ...context, practiceMode: "history" });
  };
  practice("山");
  practice("新", true);
  practice("青");
  assert.deepEqual(nextItems(), []);
  t.mock.timers.setTime(new Date(2026, 10, 8, 12).getTime());
  practice("新");
  practice("山");
  assert.deepEqual(nextItems(), []);
  t.mock.timers.setTime(new Date(2026, 10, 13, 12).getTime());
  practice("新");
  assert.ok(Object.values(state.wordStats).every(isMasteredQuestion));
  assert.deepEqual(nextItems(), []);
});
