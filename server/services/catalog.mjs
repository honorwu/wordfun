import { getLessons } from "../db/catalog.mjs";
import {
  generateCurrentLessonPractice, generatePoetryPractice, generateScreeningPractice, getScreeningQuestions,
} from "../../shared/domain/practice.ts";
import { historyQuestionStatus, historyRoundWordLimit, isQuestionMasteryInherited } from "../../shared/domain/reviewPolicy.ts";

const summarizeLesson = ({ words, textbookWords, dictationWords, textCompanions, classicalTexts, ...summary }) => summary;

// 词库在服务端复用；另一连接更新词库时丢弃缓存，学习状态始终使用本次请求的数据。
export const createCatalogService = (db) => {
  let snapshot;
  let version;
  const catalog = () => {
    const nextVersion = db.prepare("PRAGMA data_version").get().data_version;
    if (!snapshot || version !== nextVersion) {
      const lessons = getLessons(db);
      snapshot = {
        lessons,
        summaries: lessons.map(summarizeLesson),
        questions: lessons.flatMap((lesson) => lesson.dictationWords),
        historyQuestions: new Map(),
      };
      version = nextVersion;
    }
    return snapshot;
  };
  return {
    summaries: () => catalog().summaries,
    questions: () => catalog().questions,
    practice: (progress, wordStats = {}, mode = "lesson", carryover = {}, inheritedMasteredChars = new Set()) => {
      const { lessons, historyQuestions } = catalog();
      const lesson = lessons.find((item) => item.id === progress?.lessonId);
      if (!lesson) throw Object.assign(new Error("所选课次不存在，请刷新后重新选择"), { statusCode: 404 });
      if (mode !== "lesson" && mode !== "history") throw Object.assign(new Error("复习方式不正确"), { statusCode: 400 });
      const state = { progress: { grade: lesson.grade, lessonId: lesson.id }, charStats: {}, wordStats, logs: [], wordIssues: [] };
      if (!historyQuestions.has(lesson.id)) historyQuestions.set(lesson.id, getScreeningQuestions(lessons, state.progress));
      const now = Date.now();
      const previousStatuses = historyQuestions.get(lesson.id).map((word) => {
        const stat = wordStats[word.id];
        return historyQuestionStatus(stat, carryover[word.id], now, isQuestionMasteryInherited(word, stat, inheritedMasteredChars));
      });
      return {
        lesson: { ...summarizeLesson(lesson), ...(mode === "lesson" && lesson.classicalTexts?.length ? { classicalTexts: lesson.classicalTexts } : {}) },
        mode,
        items: mode === "history" ? generateScreeningPractice(lessons, state, historyRoundWordLimit, 0, { carryover, inheritedMasteredChars, now })
          : lesson.lessonKind === "classical_poetry" ? generatePoetryPractice(lesson) : generateCurrentLessonPractice(lessons, state),
        stats: {
          historyTotal: previousStatuses.length,
          historyReviewed: previousStatuses.filter((status) => status === "mastered").length,
          historyInherited: previousStatuses.filter((status) => status === "inherited").length,
          historyUnreviewed: previousStatuses.filter((status) => status === "unreviewed").length,
          pendingMistakes: previousStatuses.filter((status) => status === "due" || status === "waiting").length,
          waitingReview: previousStatuses.filter((status) => status === "waiting").length,
        },
      };
    },
  };
};
