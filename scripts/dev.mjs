import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:server"], { stdio: "inherit", shell: true }),
  spawn("npm", ["run", "dev:client"], { stdio: "inherit", shell: true }),
];

const shutdown = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race(children.map((child) => new Promise((resolve) => child.on("exit", resolve))));
shutdown();
