import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./app.mjs";
import { openLearningDatabase, requireCatalogDatabase } from "./db/connection.mjs";

export { createAppServer };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5174);
  const host = process.env.HOST || "127.0.0.1";
  const catalogDb = requireCatalogDatabase();
  const learningDb = openLearningDatabase();
  const server = createAppServer({ catalogDb, learningDb });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down Ziqu server...`);
    server.close(() => {
      try { learningDb.close(); } catch { /* ignore */ }
      try { catalogDb.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => {
      try { learningDb.close(); } catch { /* ignore */ }
      try { catalogDb.close(); } catch { /* ignore */ }
      process.exit(1);
    }, 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, host, () => console.log(`Ziqu API server listening on http://${host}:${server.address().port}`));
}
