import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./app.mjs";
import { defaultLearningDatabasePath, legacyLearningDatabasePath } from "./config.mjs";
import { requireCatalogDatabase } from "./db/connection.mjs";

export { createAppServer };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5174);
  const host = process.env.HOST || "127.0.0.1";
  const catalogDb = requireCatalogDatabase();
  if (legacyLearningDatabasePath && !existsSync(defaultLearningDatabasePath)) {
    const { bootstrapLegacyLearningDatabase } = await import("./db/migrate-legacy-learning.mjs");
    const migrated = bootstrapLegacyLearningDatabase({
      legacyPath: legacyLearningDatabasePath,
      learningPath: defaultLearningDatabasePath,
      catalogDb,
    });
    if (migrated) console.log(`学习库迁移完成，正在使用 ${defaultLearningDatabasePath}`);
  }
  const server = createAppServer({ catalogDb });
  server.listen(port, host, () => console.log(`Ziqu API server listening on http://${host}:${server.address().port}`));
}
