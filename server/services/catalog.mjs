import { getCompanionWords, getLessons } from "../db/catalog.mjs";
import { buildBookCharacterIndex } from "../../shared/domain/characterMastery.ts";
import {
  generateCurrentLessonPractice, generatePoetryPractice, generateScreeningPractice,
  getEligibleCharacterWords, getScreeningTargetChars,
  historyRoundWordLimit, isHistoryCharCoolingDown, isMasteredChar, isPendingScreeningMistakeChar, isReviewedScreeningChar,
} from "../../shared/domain/index.ts";

const summarizeLesson = ({ words, textbookWords, dictationWords, textCompanions, classicalTexts, ...summary }) => summary;

// 词库在服务端复用；另一连接更新词库时丢弃缓存，学习状态始终使用本次请求的数据。
export const createCatalogService = (db) => {
  let snapshot;
  let version;
  const catalog = () => {
    const nextVersion = db.prepare("PRAGMA data_version").get().data_version;
    if (!snapshot || version !== nextVersion) {
      const lessons = getLessons(db);
      if (lessons.some((lesson) => !lesson.dictationWords)) {
        throw Object.assign(new Error("教材词库需要更新，请部署与本版本配套的词库"), { statusCode: 503 });
      }
      snapshot = { lessons, summaries: lessons.map(summarizeLesson), companions: getCompanionWords(db), historyChars: new Map() };
      version = nextVersion;
    }
    return snapshot;
  };
  return {
    summaries: () => catalog().summaries,
    characterBooks: () => {
      const data = catalog();
      return data.characterBooks ??= buildBookCharacterIndex(data.lessons);
    },
    practice: (progress, charStats, mode = "lesson") => {
      const { lessons, historyChars } = catalog();
      const lesson = lessons.find((item) => item.id === progress?.lessonId);
      if (!lesson) throw Object.assign(new Error("所选课次不存在，请刷新后重新选择"), { statusCode: 404 });
      if (mode !== "lesson" && mode !== "history") throw Object.assign(new Error("复习方式不正确"), { statusCode: 400 });
      const state = { progress: { grade: lesson.grade, lessonId: lesson.id }, charStats: charStats ?? {}, wordStats: {}, logs: [], wordIssues: [] };
      if (!historyChars.has(lesson.id)) historyChars.set(lesson.id, getScreeningTargetChars(lessons, state.progress));
      const chars = historyChars.get(lesson.id);
      return {
        lesson: { ...summarizeLesson(lesson), ...(mode === "lesson" && lesson.classicalTexts?.length ? { classicalTexts: lesson.classicalTexts } : {}) },
        mode,
        items: mode === "history" ? generateScreeningPractice(lessons, state, historyRoundWordLimit)
          : lesson.lessonKind === "classical_poetry" ? generatePoetryPractice(lesson) : generateCurrentLessonPractice(lessons, state),
        stats: {
          historyTotal: chars.length,
          historyReviewed: chars.filter((char) => isMasteredChar(state.charStats[char])).length,
          historyUnreviewed: chars.filter((char) => !isReviewedScreeningChar(state.charStats[char])).length,
          pendingMistakes: chars.filter((char) => isPendingScreeningMistakeChar(state.charStats[char])).length,
          waitingReview: chars.filter((char) => isHistoryCharCoolingDown(state.charStats[char])).length,
        },
      };
    },
    wordsForLogs: (progress, logs, extraWordIds = []) => {
      const ids = new Set([...logs.flatMap((log) => log.wordIds), ...extraWordIds]);
      if (!ids.size) return [];
      const { lessons, companions } = catalog();
      // 与旧版索引相同的覆盖顺序，保留单字题 ID、组词及古诗的还原能力。
      const words = new Map([
        ...lessons.flatMap((lesson) => lesson.words),
        ...getEligibleCharacterWords(lessons, progress, companions),
        ...lessons.flatMap((lesson) => lesson.dictationWords ?? []),
      ].filter((word) => ids.has(word.id)).map((word) => [word.id, word]));
      return [...words.values()];
    },
  };
};
