import { getCompanionWords, getLessons } from "./db.mjs";
import {
  generateCurrentLessonPractice, generatePoetryPractice, generateScreeningPractice,
  getEligibleCharacterWords, getEligibleWords, getScreeningTargetChars,
  isHistoryCharCoolingDown, isMasteredChar, isPendingScreeningMistakeChar,
} from "../src/lib/scheduler.ts";

const summarizeLesson = ({ words, textbookWords, textCompanions, classicalTexts, ...summary }) => summary;

// 词库在服务端复用；另一连接更新词库时丢弃缓存，学习状态始终使用本次请求的数据。
export const createCatalogService = (db) => {
  let snapshot;
  let version;
  const catalog = () => {
    const nextVersion = db.prepare("PRAGMA data_version").get().data_version;
    if (!snapshot || version !== nextVersion) {
      const lessons = getLessons(db);
      snapshot = { lessons, summaries: lessons.map(summarizeLesson), companions: getCompanionWords(db), historyChars: new Map() };
      version = nextVersion;
    }
    return snapshot;
  };
  return {
    summaries: () => catalog().summaries,
    practice: (progress, charStats, mode = "lesson") => {
      const { lessons, companions, historyChars } = catalog();
      const lesson = lessons.find((item) => item.id === progress?.lessonId);
      if (!lesson) throw Object.assign(new Error("所选课次不存在，请刷新后重新选择"), { statusCode: 404 });
      if (mode !== "lesson" && mode !== "history") throw Object.assign(new Error("复习方式不正确"), { statusCode: 400 });
      const state = { progress: { grade: lesson.grade, lessonId: lesson.id }, charStats: charStats ?? {}, wordStats: {}, logs: [], wordIssues: [] };
      if (!historyChars.has(lesson.id)) historyChars.set(lesson.id, getScreeningTargetChars(lessons, state.progress, companions));
      const chars = historyChars.get(lesson.id);
      return {
        lesson: { ...summarizeLesson(lesson), ...(lesson.classicalTexts?.length ? { classicalTexts: lesson.classicalTexts } : {}) },
        mode,
        items: mode === "history" ? generateScreeningPractice(lessons, state, 20, companions)
          : lesson.lessonKind === "classical_poetry" ? generatePoetryPractice(lesson) : generateCurrentLessonPractice(lessons, state, companions),
        stats: {
          historyTotal: chars.length,
          historyReviewed: chars.filter((char) => isMasteredChar(state.charStats[char])).length,
          pendingMistakes: chars.filter((char) => isPendingScreeningMistakeChar(state.charStats[char])).length,
          waitingReview: chars.filter((char) => isHistoryCharCoolingDown(state.charStats[char])).length,
        },
      };
    },
    wordsForLogs: (progress, logs, extraWordIds = []) => {
      const { lessons, companions } = catalog();
      const ids = new Set([...logs.flatMap((log) => log.wordIds), ...extraWordIds]);
      if (!ids.size) return [];
      // 与旧版索引相同的覆盖顺序，保留单字题 ID、组词及古诗的还原能力。
      const words = new Map([
        ...lessons.flatMap((lesson) => [...lesson.words, ...(lesson.textbookWords ?? [])]),
        ...lessons.filter((lesson) => lesson.lessonKind === "classical_poetry").flatMap((lesson) => generatePoetryPractice(lesson).map((item) => item.word)),
        ...getEligibleCharacterWords(lessons, progress, companions),
        ...getEligibleWords(lessons, progress, companions),
      ].filter((word) => ids.has(word.id)).map((word) => [word.id, word]));
      return [...words.values()];
    },
  };
};
