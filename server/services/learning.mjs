import { getAppDataSnapshot, getPracticeSnapshot, getReviewCarryover, getReviewLogs, saveState } from "../db/learning.mjs";
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
    /** @param {import("../../shared/contracts.ts").SaveStateRequest} body */
    save(body) {
      saveState(learningDb, body, studentId);
      return { ok: true };
    },
  };
};
