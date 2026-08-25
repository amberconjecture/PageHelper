import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandExecutionKey,
  createCommandExecutionDeduplicator
} from "../src/command-deduplication.js";

test("reuses one in-flight execution for the same target and command id", async () => {
  const deduplicator = createCommandExecutionDeduplicator();
  const key = buildCommandExecutionKey("website-one", { id: "command-1" });
  let executeCount = 0;
  let releaseExecution;
  const blocked = new Promise((resolve) => {
    releaseExecution = resolve;
  });
  const execute = async () => {
    executeCount += 1;
    await blocked;
    return { ok: true };
  };

  const first = deduplicator.run(key, execute);
  const second = deduplicator.run(key, execute);
  releaseExecution();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(executeCount, 1);
  assert.equal(firstResult.reused, false);
  assert.equal(secondResult.reused, true);
  assert.deepEqual(secondResult.result, firstResult.result);
});

test("executes a command id again after the retention window", async () => {
  let timestamp = 100;
  const deduplicator = createCommandExecutionDeduplicator({
    retentionMs: 30,
    now: () => timestamp
  });
  const key = buildCommandExecutionKey("website-one", { id: 7 });
  let executeCount = 0;
  const execute = async () => {
    executeCount += 1;
    return executeCount;
  };

  const first = await deduplicator.run(key, execute);
  timestamp = 131;
  const second = await deduplicator.run(key, execute);

  assert.equal(first.result, 1);
  assert.equal(second.result, 2);
  assert.equal(second.reused, false);
});

test("does not deduplicate commands that do not provide an id", async () => {
  const deduplicator = createCommandExecutionDeduplicator();
  let executeCount = 0;
  const execute = async () => {
    executeCount += 1;
    return executeCount;
  };

  const key = buildCommandExecutionKey("website-one", {});
  const first = await deduplicator.run(key, execute);
  const second = await deduplicator.run(key, execute);

  assert.equal(key, "");
  assert.equal(first.result, 1);
  assert.equal(second.result, 2);
  assert.equal(executeCount, 2);
});

test("does not build a deduplication key for unsupported command id types", () => {
  assert.equal(buildCommandExecutionKey("website-one", { id: {} }), "");
  assert.equal(buildCommandExecutionKey("website-one", { id: Number.NaN }), "");
});
