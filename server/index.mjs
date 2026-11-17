import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./app.mjs";

export { createAppServer };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5174);
  const host = process.env.HOST || "127.0.0.1";
  createAppServer().listen(port, host, () => console.log(`Ziqu API server listening on http://${host}:${port}`));
}
