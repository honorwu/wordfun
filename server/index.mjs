import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  defaultCatalogDatabasePath,
  defaultLearningDatabasePath,
  defaultStudentId,
  getCompanionWords,
  getLessons,
  getState,
  openLearningDatabase,
  projectRoot,
  requireCatalogDatabase,
  saveState,
} from "./db.mjs";

const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "127.0.0.1";
const catalogDb = requireCatalogDatabase();
const learningDb = openLearningDatabase();
const distDir = path.join(projectRoot, "dist");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 500;
    sendJson(response, status, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

server.listen(port, host, () => {
  console.log(`Ziqu API server listening on http://${host}:${port}`);
});

const handleApi = async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      catalogDb: defaultCatalogDatabasePath,
      learningDb: defaultLearningDatabasePath,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/app-data") {
    const lessons = getLessons(catalogDb);
    sendJson(response, 200, {
      lessons,
      companionWords: getCompanionWords(catalogDb),
      state: getState(learningDb, catalogDb, defaultStudentId),
      builtInLessonCount: lessons.length,
      builtInWordCount: lessons.reduce((sum, lesson) => sum + lesson.words.length, 0),
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/state") {
    const body = await readBody(request);
    saveState(learningDb, body, defaultStudentId);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
};

const readBody = async (request) => {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 4 * 1024 * 1024) {
      const error = new Error("学习记录过大，无法保存");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("保存内容格式不正确");
    error.statusCode = 400;
    throw error;
  }
};

const sendJson = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json;charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const serveStatic = async (response, pathname) => {
  if (!existsSync(distDir)) {
    sendJson(response, 404, { error: "Frontend build not found. Run npm run build or use npm run dev." });
    return;
  }

  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(distDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  if (!existsSync(filePath)) {
    filePath = path.join(distDir, "index.html");
  }

  response.writeHead(200, { "content-type": mimeType(filePath) });
  createReadStream(filePath).pipe(response);
};

const mimeType = (filePath) => {
  const extension = path.extname(filePath);
  return (
    {
      ".css": "text/css;charset=utf-8",
      ".html": "text/html;charset=utf-8",
      ".js": "text/javascript;charset=utf-8",
      ".json": "application/json;charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    }[extension] || "application/octet-stream"
  );
};
