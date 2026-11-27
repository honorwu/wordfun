import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.mjs";
import { sendJson } from "./json.mjs";

const distDir = path.resolve(projectRoot, "dist");

const isFile = (targetPath) => Boolean(statSync(targetPath, { throwIfNoEntry: false })?.isFile());

export const serveStatic = async (request, response, pathname) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson(response, 405, { error: "Method not allowed" }, request);
  }
  const indexPath = path.join(distDir, "index.html");
  if (!isFile(indexPath)) {
    return sendJson(response, 404, { error: "Frontend build not found. Run npm run build or use npm run dev." }, request);
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(response, 400, { error: "Invalid request path" }, request);
  }
  if (decodedPath.includes("\0")) {
    return sendJson(response, 400, { error: "Invalid request path" }, request);
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/\\]+/, "");
  let filePath = path.resolve(distDir, relativePath);
  if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
    return sendJson(response, 403, { error: "Forbidden" }, request);
  }
  if (!isFile(filePath)) {
    filePath = indexPath;
  }

  const fileStat = statSync(filePath);
  const relativeServed = path.relative(distDir, filePath).split(path.sep).join("/");
  const cacheControl = relativeServed.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  const headers = {
    "content-type": mimeType(filePath),
    "content-length": String(fileStat.size),
    "cache-control": cacheControl,
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json;charset=utf-8" });
      response.end(JSON.stringify({ error: "Failed to read static asset" }));
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
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
