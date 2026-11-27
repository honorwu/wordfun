import { createServer } from "node:http";
import { defaultStudentId } from "./config.mjs";
import { openLearningDatabase, requireCatalogDatabase } from "./db/connection.mjs";
import { sendJson } from "./http/json.mjs";
import { serveStatic } from "./http/static.mjs";
import { createApiHandler } from "./routes/api.mjs";
import { createLearningService } from "./services/learning.mjs";

export const createAppServer = ({ catalogDb = requireCatalogDatabase(), learningDb = openLearningDatabase(), studentId = defaultStudentId } = {}) => {
  const handleApi = createApiHandler(createLearningService({ catalogDb, learningDb, studentId }));
  const server = createServer(async (request, response) => {
    try {
      let url;
      try {
        url = new URL(request.url || "/", "http://localhost");
      } catch {
        await sendJson(response, 400, { error: "Invalid request URL" }, request);
        return;
      }
      if (url.pathname.startsWith("/api")) {
        await handleApi(request, response, url);
        return;
      }
      await serveStatic(request, response, url.pathname);
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 500;
      await sendJson(response, status, { error: error instanceof Error ? error.message : "Unknown error" }, request);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
};
