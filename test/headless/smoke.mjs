import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const bundlePath = path.join(repoRoot, "dist-headless", "index.js");
const bundle = await readFile(bundlePath, "utf8");

assert.doesNotMatch(bundle, /from ["']electron["']/);
assert.doesNotMatch(bundle, /electron-store/);
assert.doesNotMatch(bundle, /electron-log\/main/);

const userDataPath = await mkdtemp(
  path.join(os.tmpdir(), "agent-ui-headless-smoke-"),
);
const requestedPort = 40_000 + Math.floor(Math.random() * 10_000);
const child = spawn(process.execPath, [bundlePath], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AGENT_UI_DATA_DIR: userDataPath,
    AGENT_UI_WEB_PORT: String(requestedPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

function waitForUrl() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for headless startup:\n${output}`));
    }, 15_000);

    const checkOutput = () => {
      const match = output.match(
        /Agent UI listening at (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };

    child.stdout.on("data", checkOutput);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Headless process exited before startup (${code}):\n${output}`,
        ),
      );
    });
    checkOutput();
  });
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(`${url.replace("http:", "ws:")}/rpc`);
    const timeout = setTimeout(() => {
      websocket.terminate();
      reject(new Error("Timed out opening headless WebSocket"));
    }, 5_000);
    websocket.once("open", () => {
      clearTimeout(timeout);
      websocket.close();
    });
    websocket.once("close", () => {
      resolve();
    });
    websocket.once("error", reject);
  });
}

try {
  const url = await waitForUrl();
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"><\/div>/);
  await connectWebSocket(url);

  const persistedState = JSON.parse(
    await readFile(path.join(userDataPath, "agent-ui.json"), "utf8"),
  );
  assert.equal(persistedState.schemaVersion, 3);
  assert.match(
    await readFile(path.join(userDataPath, "logs", "headless.log"), "utf8"),
    /Web app server started/,
  );

  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve) => {
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, output);
  process.stdout.write(`Headless smoke test passed at ${url}\n`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await rm(userDataPath, { recursive: true, force: true });
}
