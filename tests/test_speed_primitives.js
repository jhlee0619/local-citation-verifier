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
})();
