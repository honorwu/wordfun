import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.mjs";
import { sendJson } from "./json.mjs";

const distDir = path.join(projectRoot, "dist");

export const serveStatic = async (response, pathname) => {
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
