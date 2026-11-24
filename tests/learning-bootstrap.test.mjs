import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultCatalogDatabasePath, projectRoot } from "../server/config.mjs";
import { getLessons } from "../server/db/catalog.mjs";
import { openLearningDatabase, requireCatalogDatabase } from "../server/db/connection.mjs";
import { getState, saveState } from "../server/db/learning.mjs";
import { bootstrapLegacyLearningDatabase } from "../server/db/migrate-legacy-learning.mjs";

const scratch = (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ziqu-learning-bootstrap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    legacyPath: path.join(directory, "ziqu-learning.sqlite"),
    learningPath: path.join(directory, "ziqu-learning-inherited-mastery.sqlite"),
  };
};

const stopServer = async (child) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
};

const startServer = async ({ legacyPath, learningPath }) => {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      ZIQU_CATALOG_DB_PATH: defaultCatalogDatabasePath,
      ZIQU_LEARNING_DB_PATH: learningPath,
      ZIQU_LEGACY_LEARNING_DB_PATH: legacyPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let timer;
  try {
    const address = await new Promise((resolve, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        const address = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (address) resolve(address);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`服务未启动，退出码 ${code}\n${stderr}`)));
      timer = setTimeout(() => reject(new Error(`服务未在时限内启动\n${stderr}`)), 5000);
    });
    return { address, stop: () => stopServer(child) };
  } catch (error) {
    await stopServer(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

test("线上入口先产出新学习库，再启动服务，重启可脱离旧库", async (t) => {
  const paths = scratch(t);
  const catalogDb = requireCatalogDatabase();
  const legacy = openLearningDatabase(paths.legacyPath);
  const date = "2026-11-16T10:51:00.000Z";
  let parent;
  try {
    const lessons = getLessons(catalogDb);
    const sourceLesson = lessons.find(({ title }) => title === "曹冲称象");
    const originalWord = sourceLesson.dictationWords.find(({ text }) => text === "船身");
    const currentLesson = lessons.find(({ title }) => title === "颐和园");
    const progress = { grade: currentLesson.grade, lessonId: currentLesson.id };
    const initial = getState(legacy, catalogDb);
    legacy.exec("DROP TABLE inherited_char_mastery; DROP TABLE review_carryover; PRAGMA wal_checkpoint(TRUNCATE)");
    const correct = { attempts: 1, mistakes: 0, streak: 1, lastReviewedAt: date };
    saveState(legacy, {
      ...initial,
      progress,
      charStats: {
        船: correct,
        身: correct,
        筑: { attempts: 1, mistakes: 1, streak: 0, lastReviewedAt: date, lastMistakeAt: date },
      },
      wordStats: { [originalWord.id]: correct },
      logs: [{
        id: "old-session", date, practiceMode: "lesson", lessons: [{ id: sourceLesson.id, title: sourceLesson.title }],
        wordIds: [originalWord.id], wrongWordIds: [],
        reviewedItems: [{ wordId: originalWord.id, wordText: originalWord.text, reviewedChars: ["船", "身"] }],
      }],
    });
    const oldBytes = readFileSync(paths.legacyPath);
    const walPath = `${paths.legacyPath}-wal`;
    const oldWal = readFileSync(walPath);
    assert.ok(oldWal.length > 0);

    const first = await startServer(paths);
    try {
      const startup = await (await fetch(`${first.address}/api/app-data`)).json();
      assert.deepEqual(startup.state.progress, progress);
      parent = await (await fetch(`${first.address}/api/parent-data`, { method: "POST" })).json();
      assert.deepEqual(parent.inheritedMasteredChars, ["船", "身"]);
      assert.equal(parent.logs.length, 1);
      assert.equal(parent.logs[0].id, "old-session");
      const [[wordId, review]] = Object.entries(parent.reviewCarryover);
      assert.ok(parent.questions.find(({ id }) => id === wordId).chars.includes("筑"));
      assert.equal(review.availableAt, "2026-11-21T10:51:00.000Z");
    } finally {
      await first.stop();
    }
    assert.ok(existsSync(paths.learningPath));
    assert.deepEqual(readFileSync(paths.legacyPath), oldBytes);
    assert.deepEqual(readFileSync(walPath), oldWal);
  } finally {
    legacy.close();
    catalogDb.close();
  }
  renameSync(paths.legacyPath, `${paths.legacyPath}.saved`);

  const second = await startServer(paths);
  try {
    const restarted = await (await fetch(`${second.address}/api/parent-data`, { method: "POST" })).json();
    assert.deepEqual(restarted, parent);
    assert.equal(existsSync(paths.legacyPath), false);
  } finally {
    await second.stop();
  }
});

test("已有新库时跳过旧库，缺旧库时交由正常启动初始化", (t) => {
  const paths = scratch(t);
  const catalogDb = requireCatalogDatabase();
  t.after(() => catalogDb.close());

  assert.equal(bootstrapLegacyLearningDatabase({ ...paths, catalogDb }), false);
  assert.equal(existsSync(paths.learningPath), false);

  openLearningDatabase(paths.learningPath).close();
  const newBytes = readFileSync(paths.learningPath);
  writeFileSync(paths.legacyPath, "无效的旧学习库");
  assert.equal(bootstrapLegacyLearningDatabase({ ...paths, catalogDb }), false);
  assert.deepEqual(readFileSync(paths.learningPath), newBytes);
});

test("损坏的旧库不会生成新学习库", (t) => {
  const paths = scratch(t);
  const catalogDb = requireCatalogDatabase();
  t.after(() => catalogDb.close());
  const invalid = "无效的旧学习库";
  writeFileSync(paths.legacyPath, invalid);

  assert.throws(() => bootstrapLegacyLearningDatabase({ ...paths, catalogDb }));
  assert.equal(existsSync(paths.learningPath), false);
  assert.equal(readFileSync(paths.legacyPath, "utf8"), invalid);
  assert.deepEqual(readdirSync(paths.directory), [path.basename(paths.legacyPath)]);
});

test("写入临时库失败时保留旧库并清理临时文件", (t) => {
  const paths = scratch(t);
  const catalogDb = requireCatalogDatabase();
  t.after(() => catalogDb.close());
  const legacy = openLearningDatabase(paths.legacyPath);
  try {
    legacy.exec(`
      DROP TABLE progress;
      CREATE TABLE progress (
        student_id TEXT PRIMARY KEY REFERENCES students(id),
        grade INTEGER NOT NULL,
        lesson_id TEXT NOT NULL
      );
      INSERT INTO students (id, name) VALUES ('old-student', 'Old Student');
      INSERT INTO progress VALUES ('old-student', 0, 'unknown-lesson');
      PRAGMA journal_mode = DELETE;
    `);
  } finally {
    legacy.close();
  }
  const oldBytes = readFileSync(paths.legacyPath);

  assert.throws(() => bootstrapLegacyLearningDatabase({ ...paths, catalogDb }), /CHECK constraint failed: grade BETWEEN 1 AND 6/);
  assert.deepEqual(readFileSync(paths.legacyPath), oldBytes);
  assert.deepEqual(readdirSync(paths.directory), [path.basename(paths.legacyPath)]);
});
