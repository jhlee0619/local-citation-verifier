#!/usr/bin/env node
"use strict";

const assert = require("assert");
const harness = require("./run_fixture_verification.js");

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
  await test("fixture harness loads production fuzzball metric", () => {
    assert.strictEqual(harness.hasProductionFuzzball(), true);
  });

  await test("fixture harness marks 5xx as transient", () => {
    assert.strictEqual(harness.isTransientHttpStatus(503), true);
    assert.strictEqual(harness.isTransientHttpStatus(404), false);
  });
})();
