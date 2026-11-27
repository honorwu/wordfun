import {
  getAppDataSnapshot, getPracticeSnapshot, getReviewCarryover, getReviewLogs,
  recordReview, resolveSavedWordIssue, saveProgress, saveState, supplementReview, toggleSavedWordIssue,
} from "../db/learning.mjs";
import { createCatalogService } from "./catalog.mjs";

// 组合词库和学习记录；HTTP 层只负责请求解析与响应。
export const createLearningService = ({ catalogDb, learningDb, studentId }) => {
  const catalog = createCatalogService(catalogDb);
  const readCarryover = () => getReviewCarryover(learningDb, studentId);
  return {
    /** @returns {import("../../shared/contracts.ts").AppDataResponse} */
    appData() {
      const { state, activity, carryover } = getAppDataSnapshot(learningDb, catalogDb, studentId);
      return {
        lessons: catalog.summaries(),
        state,
        activity,
        practice: catalog.practice(state.progress, state.wordStats, "lesson", carryover),
      };
    },
    /** @param {import("../../shared/contracts.ts").PracticeRequest} body */
    practice({ progress, mode }) {
      const { wordStats, carryover } = getPracticeSnapshot(learningDb, studentId);
      return catalog.practice(progress, wordStats, mode, carryover);
    },
    /** @returns {import("../../shared/contracts.ts").ParentDataResponse} */
    parentData() {
      return {
        logs: getReviewLogs(learningDb, catalogDb, studentId),
        questions: catalog.questions(),
        reviewCarryover: readCarryover(),
      };
    },
    /** @param {import("../../shared/contracts.ts").UpdateProgressRequest} body */
    updateProgress(body) {
      return saveProgress(learningDb, catalogDb, body?.progress, studentId);
    },
    /** @param {import("../../shared/contracts.ts").SubmitReviewRequest} body */
    submitReview(body) {
      return recordReview(learningDb, body, catalog.questionMap(), studentId);
    },
    /** @param {string} logId @param {import("../../shared/contracts.ts").SupplementReviewRequest} body */
    supplementReview(logId, body) {
      return supplementReview(learningDb, catalogDb, logId, body, catalog.questionMap(), studentId);
    },
    /** @param {import("../../shared/contracts.ts").ToggleWordIssueRequest} body */
    toggleWordIssue(body) {
      return toggleSavedWordIssue(learningDb, body, studentId);
    },
    /** @param {string} issueId @param {import("../../shared/contracts.ts").ResolveWordIssueRequest} body */
    resolveWordIssue(issueId, body) {
      return resolveSavedWordIssue(learningDb, issueId, body?.resolved, studentId);
    },
    /** @param {import("../../shared/contracts.ts").SaveStateRequest} body */
    save(body) {
      saveState(learningDb, body, studentId);
      return { ok: true };
    },
  };
};
