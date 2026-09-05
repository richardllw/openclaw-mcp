"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPendingYieldStore } = require("./pending-yield-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pending-yield-test-"));
try {
  const sharedDir = path.join(root, "entries");
  const store = createPendingYieldStore({ dir: sharedDir });
  const concurrentStore = createPendingYieldStore({ dir: sharedDir });
  store.write("run-a", "agent:main:discord:direct:a");
  concurrentStore.write("run-b", "agent:main:discord:direct:b");
  concurrentStore.write("run-main", null);

  assert.deepStrictEqual(
    store.read("agent:main:discord:direct:a").map((entry) => entry.runId),
    ["run-a"]
  );
  assert.deepStrictEqual(
    store.read("agent:main:discord:direct:b").map((entry) => entry.runId),
    ["run-b"]
  );
  assert.deepStrictEqual(store.read(null).map((entry) => entry.runId), ["run-main"]);

  store.remove("run-a");
  assert.deepStrictEqual(store.read("agent:main:discord:direct:a"), []);
  assert.deepStrictEqual(
    store.read("agent:main:discord:direct:b").map((entry) => entry.runId),
    ["run-b"]
  );
  process.stdout.write("pending-yield-store: ok\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
