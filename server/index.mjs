import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createCatalogService } from "./catalog.mjs";
import {
  defaultCatalogDatabasePath,
  defaultLearningDatabasePath,
  defaultStudentId,
  getReviewActivity,
  getState,
  openLearningDatabase,
  projectRoot,
  requireCatalogDatabase,
  saveState,
} from "./db.mjs";

const distDir = path.join(projectRoot, "dist");
const compress = promisify(gzip);

export const createAppServer = ({ catalogDb = requireCatalogDatabase(), learningDb = openLearningDatabase(), studentId = defaultStudentId } = {}) => {
  const catalog = createCatalogService(catalogDb);
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
      await sendJson(response, status, { error: error instanceof Error ? error.message : "Unknown error" }, request);
    }
  });

  const handleApi = async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, {
        ok: true,
        catalogDb: defaultCatalogDatabasePath,
        learningDb: defaultLearningDatabasePath,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/app-data") {
      const state = getState(learningDb, catalogDb, studentId, { includeLogs: false });
      return sendJson(response, 200, {
        lessons: catalog.summaries(),
        state,
        activity: getReviewActivity(learningDb, studentId),
        practice: catalog.practice(state.progress, state.charStats),
      }, request);
    }

    if (request.method === "POST" && url.pathname === "/api/practice") {
      const body = await readBody(request);
      return sendJson(response, 200, catalog.practice(body.progress, body.charStats, body.mode), request);
    }

    if (request.method === "POST" && url.pathname === "/api/parent-data") {
      const body = await readBody(request);
      const state = getState(learningDb, catalogDb, studentId);
      return sendJson(response, 200, {
        logs: state.logs,
        words: catalog.wordsForLogs(body.progress ?? state.progress, state.logs, body.wordIds ?? []),
      }, request);
    }

    if (request.method === "PUT" && url.pathname === "/api/state") {
      const body = await readBody(request);
      if (body.mergeLogs === true) {
        const previous = getState(learningDb, catalogDb, studentId);
        const logs = new Map(previous.logs.map((log) => [log.id, log]));
        for (const log of body.logs ?? []) logs.set(log.id, log);
        body.logs = [...logs.values()].sort((a, b) => b.date.localeCompare(a.date));
      }
      saveState(learningDb, body, studentId);
      return sendJson(response, 200, { ok: true }, request);
    }

    return sendJson(response, 404, { error: "Not found" }, request);
  };

  return server;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5174);
  const host = process.env.HOST || "127.0.0.1";
  createAppServer().listen(port, host, () => console.log(`Ziqu API server listening on http://${host}:${port}`));
}

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

const sendJson = async (response, status, payload, request) => {
  let body = Buffer.from(JSON.stringify(payload));
  const headers = { "content-type": "application/json;charset=utf-8", "cache-control": "no-store", vary: "Accept-Encoding" };
  const acceptsGzip = (request?.headers["accept-encoding"] ?? "").split(",").some((entry) => {
    const [encoding, ...params] = entry.trim().split(";");
    const quality = params.find((param) => param.trim().startsWith("q="));
    return encoding === "gzip" && (!quality || Number(quality.trim().slice(2)) > 0);
  });
  if (body.length > 1024 && acceptsGzip) {
    body = await compress(body);
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = String(body.length);
  response.writeHead(status, headers);
  response.end(body);
};

const serveStatic = async (response, pathname) => {
  if (!existsSync(distDir)) {
    return sendJson(response, 404, { error: "Frontend build not found. Run npm run build or use npm run dev." });
  }

  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(distDir)) {
    return sendJson(response, 403, { error: "Forbidden" });
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
