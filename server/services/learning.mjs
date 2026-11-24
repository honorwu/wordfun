import { getInheritedMasteredChars, getReviewActivity, getReviewCarryover, getReviewLogs, getState, saveState } from "../db/learning.mjs";
import { createCatalogService } from "./catalog.mjs";

// 组合词库和学习记录；HTTP 层只负责请求解析与响应。
export const createLearningService = ({ catalogDb, learningDb, studentId }) => {
  const catalog = createCatalogService(catalogDb);
  const readState = (options) => getState(learningDb, catalogDb, studentId, options);
  const readCarryover = () => getReviewCarryover(learningDb, studentId);
  const readInheritedMasteredChars = () => getInheritedMasteredChars(learningDb, studentId);
  return {
    /** @returns {import("../../shared/contracts.ts").AppDataResponse} */
    appData() {
      const state = readState({ includeLogs: false });
      return {
        lessons: catalog.summaries(),
        state,
        activity: getReviewActivity(learningDb, studentId),
        practice: catalog.practice(state.progress, state.wordStats, "lesson", readCarryover(), new Set(readInheritedMasteredChars())),
      };
    },
    /** @param {import("../../shared/contracts.ts").PracticeRequest} body */
    practice(body) {
      return catalog.practice(
        body.progress, body.wordStats ?? readState({ includeLogs: false }).wordStats, body.mode,
        readCarryover(), new Set(readInheritedMasteredChars()),
      );
    },
    /** @returns {import("../../shared/contracts.ts").ParentDataResponse} */
    parentData() {
      return {
        logs: getReviewLogs(learningDb, catalogDb, studentId),
        questions: catalog.questions(),
        reviewCarryover: readCarryover(),
        inheritedMasteredChars: readInheritedMasteredChars(),
      };
    },
    /** @param {import("../../shared/contracts.ts").SaveStateRequest} body */
    save(body) {
      saveState(learningDb, body, studentId);
      return { ok: true };
    },
  };
};
