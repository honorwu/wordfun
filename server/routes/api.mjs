import { readBody, sendJson } from "../http/json.mjs";

const decodeParam = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("请求路径格式不正确"), { statusCode: 400 });
  }
};

export const createApiHandler = (learning) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true }, request);
  }
  if (request.method === "GET" && url.pathname === "/api/app-data") {
    return sendJson(response, 200, learning.appData(), request);
  }
  if (request.method === "POST" && url.pathname === "/api/practice") {
    return sendJson(response, 200, learning.practice(await readBody(request)), request);
  }
  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/parent-data") {
    const includeQuestions = url.searchParams.get("includeQuestions") !== "0";
    return sendJson(response, 200, learning.parentData({ includeQuestions }), request);
  }
  if (request.method === "PUT" && url.pathname === "/api/progress") {
    return sendJson(response, 200, learning.updateProgress(await readBody(request)), request);
  }
  if (request.method === "POST" && url.pathname === "/api/reviews") {
    return sendJson(response, 200, learning.submitReview(await readBody(request)), request);
  }
  const correctionMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/corrections$/);
  if (request.method === "POST" && correctionMatch) {
    return sendJson(response, 200, learning.supplementReview(decodeParam(correctionMatch[1]), await readBody(request)), request);
  }
  if (request.method === "POST" && url.pathname === "/api/word-issues/toggle") {
    return sendJson(response, 200, learning.toggleWordIssue(await readBody(request)), request);
  }
  const issueMatch = url.pathname.match(/^\/api\/word-issues\/([^/]+)$/);
  if (request.method === "PATCH" && issueMatch) {
    return sendJson(response, 200, learning.resolveWordIssue(decodeParam(issueMatch[1]), await readBody(request)), request);
  }
  if (request.method === "PUT" && url.pathname === "/api/state") {
    return sendJson(response, 200, learning.save(await readBody(request)), request);
  }
  return sendJson(response, 404, { error: "Not found" }, request);
};
