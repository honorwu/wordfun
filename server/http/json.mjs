import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);

export const readBody = async (request) => {
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

export const sendJson = async (response, status, payload, request) => {
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
