import { defaultCatalogDatabasePath, defaultLearningDatabasePath } from "../config.mjs";
import { readBody, sendJson } from "../http/json.mjs";

export const createApiHandler = (learning) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, catalogDb: defaultCatalogDatabasePath, learningDb: defaultLearningDatabasePath });
  }
  if (request.method === "GET" && url.pathname === "/api/app-data") {
    return sendJson(response, 200, learning.appData(), request);
  }
  if (request.method === "POST" && url.pathname === "/api/practice") {
    return sendJson(response, 200, learning.practice(await readBody(request)), request);
  }
  if (request.method === "POST" && url.pathname === "/api/parent-data") {
    return sendJson(response, 200, learning.parentData(await readBody(request)), request);
  }
  if (request.method === "PUT" && url.pathname === "/api/state") {
    return sendJson(response, 200, learning.save(await readBody(request)), request);
  }
  return sendJson(response, 404, { error: "Not found" }, request);
};
