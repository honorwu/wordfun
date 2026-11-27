import { timingSafeEqual } from "node:crypto";
import { sendJson } from "./json.mjs";

const safeEquals = (left, right) => {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
};

// 可选访问口令：未配置 ZIQU_ACCESS_TOKEN 时完全透明；配置后启用 HTTP Basic Auth（用户名任意，密码为口令）。
export const requireAccessToken = async (request, response, accessToken) => {
  if (!accessToken) return true;
  const header = request.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (safeEquals(password, accessToken)) return true;
  } else if (header.startsWith("Bearer ")) {
    if (safeEquals(header.slice(7).trim(), accessToken)) return true;
  }

  response.setHeader("www-authenticate", 'Basic realm="Ziqu"');
  await sendJson(response, 401, { error: "需要访问口令" }, request);
  return false;
};
