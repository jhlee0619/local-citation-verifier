#!/usr/bin/env node
"use strict";

const assert = require("assert");
const lib = require("../docs/lib.js");

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

(async () => {
  await test("runBoundedQueue preserves result order while limiting concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const completed = [];
    const results = await lib.runBoundedQueue([30, 10, 20, 5], async (delay, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, delay));
      active--;
      completed.push(index);
      return `done-${index}`;
    }, { concurrency: 2 });

    assert.deepStrictEqual(results, ["done-0", "done-1", "done-2", "done-3"]);
    assert.ok(maxActive <= 2, `expected max concurrency <= 2, got ${maxActive}`);
    assert.notDeepStrictEqual(completed, [0, 1, 2, 3]);
  });

  await test("createTtlCache reuses values until expiration", async () => {
    let calls = 0;
    let now = 100;
    const cache = lib.createTtlCache({ ttlMs: 50, now: () => now });
    const first = await cache.getOrSet("paper", async () => {
      calls++;
      return { title: "Cached" };
    });
    const second = await cache.getOrSet("paper", async () => {
      calls++;
      return { title: "Wrong" };
    });
    now = 151;
    const third = await cache.getOrSet("paper", async () => {
      calls++;
      return { title: "Fresh" };
    });

    assert.strictEqual(first.title, "Cached");
    assert.strictEqual(second.title, "Cached");
    assert.strictEqual(third.title, "Fresh");
    assert.strictEqual(calls, 2);
  });

  await test("createTtlCache isolates pending work by run and promotes only fulfilled values", async () => {
    const cache = lib.createTtlCache({ ttlMs: 1000 });
    const controllerA = new AbortController();
    let releaseA;
    const pendingA = cache.getOrSet("paper", () => new Promise(resolve => { releaseA = resolve; }), {
      runId: 1,
      signal: controllerA.signal,
    });
    await Promise.resolve();
    controllerA.abort("superseded");

    setTimeout(() => releaseA({ title: "late A" }), 10);
    const valueB = await cache.getOrSet("paper", async () => ({ title: "B" }), { runId: 2 });
    await assert.rejects(Promise.race([
      pendingA,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("pending work did not abort")), 25)),
    ]), error => error?.name === "AbortError");
    assert.strictEqual(valueB.title, "B");
    assert.strictEqual(cache.get("paper").title, "B");
  });

  await test("runBoundedQueue stops scheduling after abort", async () => {
    const controller = new AbortController();
    const started = [];
    const published = [];
    await lib.runBoundedQueue([0, 1, 2, 3], async (_value, index) => {
      started.push(index);
      if (index === 0) controller.abort("stop");
      return index;
    }, {
      concurrency: 1,
      signal: controller.signal,
      onResult: value => published.push(value),
    });

    assert.deepStrictEqual(started, [0]);
    assert.deepStrictEqual(published, []);
  });

  await test("a rejected aborted pending lookup cannot poison a newer stable value", async () => {
    const cache = lib.createTtlCache({ ttlMs: 1000 });
    const controllerA = new AbortController();
    let rejectA;
    const pendingA = cache.getOrSet("paper", () => new Promise((_resolve, reject) => { rejectA = reject; }), {
      runId: "A",
      signal: controllerA.signal,
    });
    await Promise.resolve();
    controllerA.abort("superseded");
    const valueB = await cache.getOrSet("paper", async () => ({ title: "B" }), { runId: "B" });
    rejectA(new Error("late A failed"));
    await assert.rejects(pendingA, error => error?.name === "AbortError");
    await Promise.resolve();
    assert.strictEqual(valueB.title, "B");
    assert.strictEqual(cache.get("paper").title, "B");
  });
})();
