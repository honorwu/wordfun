import { getReviewActivity, getState, saveState } from "../db/learning.mjs";
import { createCatalogService } from "./catalog.mjs";

// 组合词库和学习记录；HTTP 层只负责请求解析与响应。
export const createLearningService = ({ catalogDb, learningDb, studentId }) => {
  const catalog = createCatalogService(catalogDb);
  const readState = (options) => getState(learningDb, catalogDb, studentId, options);
  return {
    /** @returns {import("../../shared/contracts.ts").AppDataResponse} */
    appData() {
      const state = readState({ includeLogs: false });
      return {
        lessons: catalog.summaries(),
        state,
        activity: getReviewActivity(learningDb, studentId),
        practice: catalog.practice(state.progress, state.charStats),
      };
    },
    /** @param {import("../../shared/contracts.ts").PracticeRequest} body */
    practice(body) {
      return catalog.practice(body.progress, body.charStats, body.mode);
    },
    /** @param {import("../../shared/contracts.ts").ParentDataRequest} body */
    parentData(body) {
      const state = readState();
      return {
        logs: state.logs,
        words: catalog.wordsForLogs(body.progress ?? state.progress, state.logs, body.wordIds ?? []),
      };
    },
    /** @param {import("../../shared/contracts.ts").SaveStateRequest} body */
    save(body) {
      if (body.mergeLogs === true) {
        const previous = readState();
        const logs = new Map(previous.logs.map((log) => [log.id, log]));
        for (const log of body.logs ?? []) logs.set(log.id, log);
        body.logs = [...logs.values()].sort((a, b) => b.date.localeCompare(a.date));
      }
      saveState(learningDb, body, studentId);
      return { ok: true };
    },
  };
};
