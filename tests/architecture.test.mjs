import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const filename = path.join(directory, entry.name);
  return entry.isDirectory() ? sourceFiles(filename) : /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [filename] : [];
});
const relative = (filename) => path.relative(root, filename).split(path.sep).join("/");
const resolveImport = (filename, specifier) => {
  const target = path.resolve(path.dirname(filename), specifier);
  return [target, `${target}.ts`, `${target}.tsx`, `${target}.mjs`].find((candidate) => existsSync(candidate));
};

test("共享规则独立于前后端，路由与数据库保持分层，模块无循环依赖", () => {
  const graph = new Map();
  for (const filename of ["shared", "server", "src"].flatMap((directory) => sourceFiles(path.join(root, directory)))) {
    const name = relative(filename);
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const dependencies = [];
    const visit = (node) => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) dependencies.push(specifier.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const local = [];
    for (const specifier of dependencies) {
      if (!specifier.startsWith(".")) {
        assert.ok(!name.startsWith("shared/"), `${name} 不应依赖运行环境或第三方包: ${specifier}`);
        assert.ok(!name.startsWith("src/") || !specifier.startsWith("node:"), `${name} 不应依赖 Node.js`);
        continue;
      }
      const target = resolveImport(filename, specifier);
      assert.ok(target, `${name} 引用不存在的模块: ${specifier}`);
      const dependency = relative(target);
      local.push(dependency);
      if (name.startsWith("shared/")) assert.ok(dependency.startsWith("shared/"), `${name} 不应依赖 ${dependency}`);
      if (name.startsWith("server/")) assert.ok(/^(server|shared)\//.test(dependency), `${name} 不应依赖前端`);
      if (name.startsWith("src/")) assert.ok(/^(src|shared)\//.test(dependency), `${name} 不应依赖服务端`);
      if (name.startsWith("server/routes/")) assert.ok(!/^server\/db(?:\/|\.mjs$)/.test(dependency), `${name} 不应直接操作数据库`);
      if (name.startsWith("server/services/")) assert.ok(!/^server\/(http|routes)\//.test(dependency), `${name} 不应依赖 HTTP 层`);
      if (name.startsWith("server/db/")) assert.ok(!/^server\/(http|routes|services)\//.test(dependency), `${name} 不应依赖上层服务`);
    }
    graph.set(name, local);
  }
  const visited = new Set();
  const visit = (name, stack = []) => {
    assert.ok(!stack.includes(name), `循环依赖: ${[...stack, name].join(" → ")}`);
    if (visited.has(name)) return;
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...stack, name]);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
});
