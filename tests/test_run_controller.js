#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("../docs/run-controller.js");
const lib = require("../docs/lib.js");

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

(async () => {
  await test("verification contexts own immutable input, settings, and local state", () => {
    const controller = R.createRunController();
    const entries = [{ ID: "a", title: "Original" }];
    const settings = { preferPublished: true, nested: { mode: "balanced" } };
    const run = controller.startVerification({ entries, settings });

    entries[0].title = "Changed";
    settings.nested.mode = "fast";

    assert.strictEqual(run.id, 1);
    assert.strictEqual(run.entries[0].title, "Original");
    assert.strictEqual(run.settings.nested.mode, "balanced");
    assert.ok(Object.isFrozen(run.entries));
    assert.ok(Object.isFrozen(run.entries[0]));
    assert.ok(Object.isFrozen(run.settings.nested));
    assert.deepStrictEqual(run.results, new Array(1));
    assert.deepStrictEqual(run.decisions, []);
    assert.deepStrictEqual(run.fieldEdits, []);
  });

  await test("run B aborts A and the audit bound to A", () => {
    const controller = R.createRunController();
    const runA = controller.startVerification({ entries: [{ ID: "a" }], settings: {} });
    const auditA = controller.startAudit({ inputs: { manuscript: "A" }, settings: {} });
    const runB = controller.startVerification({ entries: [{ ID: "b" }], settings: {} });

    assert.strictEqual(runB.id, 2);
    assert.strictEqual(runA.signal.aborted, true);
    assert.strictEqual(auditA.signal.aborted, true);
    assert.strictEqual(controller.isActive(runA), false);
    assert.strictEqual(controller.isActive(auditA), false);
    assert.strictEqual(controller.isActive(runB), true);
  });

  await test("a new audit aborts only the prior audit", () => {
    const controller = R.createRunController();
    const run = controller.startVerification({ entries: [], settings: {} });
    const auditA = controller.startAudit({ inputs: {}, settings: {} });
    const auditB = controller.startAudit({ inputs: {}, settings: {} });

    assert.strictEqual(auditA.signal.aborted, true);
    assert.strictEqual(auditB.verificationId, run.id);
    assert.strictEqual(controller.isActive(auditB), true);
    assert.strictEqual(run.signal.aborted, false);
    assert.strictEqual(controller.isActive(run), true);
  });

  await test("an unbound audit survives the first verification", () => {
    const controller = R.createRunController();
    const audit = controller.startAudit({ inputs: {}, settings: {} });
    const run = controller.startVerification({ entries: [], settings: {} });
    assert.strictEqual(audit.verificationId, null);
    assert.strictEqual(controller.isActive(audit), true);
    assert.strictEqual(controller.isActive(run), true);
  });

  await test("late work can publish only through its active owner", async () => {
    const controller = R.createRunController();
    const publications = [];
    const runA = controller.startVerification({ entries: [{ ID: "a" }], settings: {} });
    let releaseA;
    const lateA = new Promise(resolve => { releaseA = resolve; }).then(() => {
      controller.ifActive(runA, () => publications.push("A"));
    });
    const runB = controller.startVerification({ entries: [{ ID: "b" }], settings: {} });
    controller.ifActive(runB, () => publications.push("B"));
    releaseA();
    await lateA;

    assert.deepStrictEqual(publications, ["B"]);
  });

  await test("explicit cancellation is terminal without deactivating a newer run", () => {
    const controller = R.createRunController();
    const runA = controller.startVerification({ entries: [], settings: {} });
    assert.strictEqual(controller.cancelVerification("user cancelled"), runA);
    assert.strictEqual(runA.signal.aborted, true);
    assert.strictEqual(controller.isActive(runA), false);
    const runB = controller.startVerification({ entries: [], settings: {} });
    assert.strictEqual(controller.isActive(runB), true);
  });

  await test("cancelling an owned onboarding delay settles without publication or rejection", async () => {
    const controller = R.createRunController();
    const run = controller.startVerification({ entries: [{ title: "QZX999" }], settings: {} });
    let rejectDelay;
    const delay = new Promise((_resolve, reject) => { rejectDelay = reject; });
    const pending = controller.settleOwned(run, delay).then(value => {
      if (controller.isActive(run)) throw new Error("cancelled delay remained active");
      return value;
    });
    controller.cancelVerification("cancel onboarding run");
    rejectDelay(run.signal.reason);
    assert.strictEqual(await pending, null);
    assert.deepStrictEqual(run.results, new Array(1));
  });

  await test("browser loads the run controller before audit and app consumers", () => {
    const index = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");
    const controllerIndex = index.indexOf('src="run-controller.js');
    const auditIndex = index.indexOf('src="citation-audit.js');
    const appIndex = index.indexOf('src="app.js');
    assert.ok(controllerIndex >= 0);
    assert.ok(controllerIndex < auditIndex);
    assert.ok(controllerIndex < appIndex);
  });

  await test("late run A cannot replace run B cards, counts, decisions, preview, or download", async () => {
    const controller = R.createRunController();
    const state = { cards: [], count: 0, decisions: [], preview: "", downloadRunId: null };
    let releaseA;
    const runA = controller.startVerification({ entries: [{ ID: "a" }], settings: {} });
    const execute = async (run, producer) => {
      await lib.runBoundedQueue(run.entries, async (_entry, index) => {
        try {
          return await producer();
        } catch (error) {
          if (run.signal.aborted) return null;
          throw error;
        }
      }, {
        concurrency: 1,
        signal: run.signal,
        onResult: (value, index) => controller.ifActive(run, () => {
          run.results[index] = value;
          run.decisions[index] = { action: "original" };
          state.cards[index] = value;
          state.count++;
          state.decisions = run.decisions.slice();
          state.preview = value.title;
        }),
      });
      controller.ifActive(run, () => { state.downloadRunId = run.id; });
    };
    const workA = execute(runA, () => new Promise(resolve => { releaseA = resolve; }));
    await Promise.resolve();

    const runB = controller.startVerification({ entries: [{ ID: "b" }], settings: {} });
    await execute(runB, async () => ({ title: "B" }));
    releaseA({ title: "late A" });
    await workA;

    assert.deepStrictEqual(state.cards, [{ title: "B" }]);
    assert.strictEqual(state.count, 1);
    assert.deepStrictEqual(state.decisions, [{ action: "original" }]);
    assert.strictEqual(state.preview, "B");
    assert.strictEqual(state.downloadRunId, runB.id);
  });
})();
