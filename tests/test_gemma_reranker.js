"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const lib = require("../docs/lib.js");
const gemma = require("../docs/gemma-reranker.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function createFixture(options = {}) {
  let imports = 0;
  let loads = 0;
  let loadOptions;
  const model = options.model || { complete: async () => "ok" };
  const engine = gemma.createGemmaEngine({
    enabled: options.enabled,
    available: () => true,
    timeoutMs: options.timeoutMs || 1000,
    importModule: async url => {
      imports++;
      assert.strictEqual(url, gemma.GEMMA_MODULE_URL);
      return {
        Gemma4Mobile: {
          load: async (_source, received) => {
            loads++;
            loadOptions = received;
            if (options.load) return options.load(received, model);
            return model;
          },
        },
      };
    },
  });
  return { engine, counts: () => ({ imports, loads }), loadOptions: () => loadOptions };
}

test("pins immutable loader and model revisions", () => {
  assert.match(gemma.LOADER_REVISION, /^[0-9a-f]{40}$/);
  assert.match(gemma.MODEL_REVISION, /^[0-9a-f]{40}$/);
  assert.strictEqual(gemma.LOADER_REVISION, "158f16ae0f672943ca304d59c47c8e3a264e399e");
  assert.strictEqual(gemma.MODEL_REVISION, "9fcec64df66cb1e4d972fc5cdc142afb25b2362c");
  assert.ok(gemma.GEMMA_MODULE_URL.includes(`/resolve/${gemma.LOADER_REVISION}/`));
  assert.ok(!gemma.GEMMA_MODULE_URL.includes("/resolve/main/"));
  assert.strictEqual(gemma.WEBGPU_TIMEOUT_MS, 120000);
});

test("requires explicit enablement before importing third-party code", async () => {
  const fixture = createFixture();
  assert.deepStrictEqual(fixture.counts(), { imports: 0, loads: 0 });
  await assert.rejects(
    fixture.engine.complete([], {}),
    error => error.kind === "disabled",
  );
  assert.deepStrictEqual(fixture.counts(), { imports: 0, loads: 0 });
});

test("loads once with the exact model revision and serializes completions", async () => {
  const gates = [deferred(), deferred()];
  const events = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const model = {
    complete: async () => {
      const index = calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`start${index}`);
      const value = await gates[index].promise;
      active--;
      events.push(`end${index}`);
      return value;
    },
  };
  const fixture = createFixture({ enabled: true, model });
  const first = fixture.engine.complete([], {});
  const second = fixture.engine.complete([], {});
  await waitFor(() => calls === 1);
  assert.strictEqual(maxActive, 1);
  gates[0].resolve("first");
  assert.strictEqual(await first, "first");
  await waitFor(() => calls === 2);
  assert.strictEqual(maxActive, 1);
  gates[1].resolve("second");
  assert.strictEqual(await second, "second");
  assert.deepStrictEqual(events, ["start0", "end0", "start1", "end1"]);
  assert.deepStrictEqual(fixture.counts(), { imports: 1, loads: 1 });
  assert.strictEqual(fixture.loadOptions().revision, gemma.MODEL_REVISION);
  assert.ok(fixture.loadOptions().signal instanceof AbortSignal);
});

test("uses independent load and complete deadlines", async () => {
  const model = {
    complete: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return "complete";
    },
  };
  const fixture = createFixture({
    enabled: true,
    timeoutMs: 70,
    model,
    load: async (_received, loadedModel) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return loadedModel;
    },
  });
  assert.strictEqual(await fixture.engine.complete([], {}), "complete");
});

test("quarantines timed-out inference and drains queued work", async () => {
  const late = deferred();
  let completeCalls = 0;
  const statuses = [];
  const fixture = createFixture({
    enabled: true,
    timeoutMs: 12,
    model: {
      complete: async () => {
        completeCalls++;
        return late.promise;
      },
    },
  });
  const first = fixture.engine.complete([], { onStatus: message => statuses.push(message) });
  const queued = fixture.engine.complete([], {});
  await assert.rejects(first, error => error.kind === "complete_timeout");
  await assert.rejects(queued, error => error.kind === "quarantined");
  assert.strictEqual(completeCalls, 1);
  late.resolve('{"best":1,"status":"updated"}');
  await Promise.resolve();
  fixture.engine.setEnabled(false);
  fixture.engine.setEnabled(true);
  await assert.rejects(fixture.engine.complete([], {}), error => error.kind === "quarantined");
  assert.strictEqual(completeCalls, 1);
  assert.strictEqual(fixture.engine.state().quarantined, true);
  assert.ok(statuses.some(message => message.includes("quarantined")));
});

test("quarantines a timed-out load without a second load attempt", async () => {
  const lateLoad = deferred();
  let completeCalls = 0;
  const fixture = createFixture({
    enabled: true,
    timeoutMs: 12,
    model: { complete: async () => { completeCalls++; return "late"; } },
    load: async () => lateLoad.promise,
  });
  await assert.rejects(fixture.engine.complete([], {}), error => error.kind === "load_timeout");
  lateLoad.resolve({ complete: async () => { completeCalls++; return "late"; } });
  await Promise.resolve();
  await assert.rejects(fixture.engine.complete([], {}), error => error.kind === "quarantined");
  assert.deepStrictEqual(fixture.counts(), { imports: 1, loads: 1 });
  assert.strictEqual(completeCalls, 0);
});

test("does not start model loading after a late module import", async () => {
  const lateImport = deferred();
  let loads = 0;
  const engine = gemma.createGemmaEngine({
    enabled: true,
    available: () => true,
    timeoutMs: 12,
    importModule: async () => lateImport.promise,
  });
  const first = engine.complete([], {});
  await assert.rejects(first, error => error.kind === "load_timeout");
  lateImport.resolve({
    Gemma4Mobile: {
      load: async () => {
        loads++;
        return { complete: async () => "late" };
      },
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(loads, 0);
  await assert.rejects(engine.complete([], {}), error => error.kind === "quarantined");
});

test("quarantines an inference error and never retries it", async () => {
  let completeCalls = 0;
  const fixture = createFixture({
    enabled: true,
    model: {
      complete: async () => {
        completeCalls++;
        throw new Error("GPU device lost");
      },
    },
  });
  await assert.rejects(fixture.engine.complete([], {}), error => error.kind === "complete_failed");
  await assert.rejects(fixture.engine.complete([], {}), error => error.kind === "quarantined");
  assert.strictEqual(completeCalls, 1);
});

test("caller cancellation reaches WebGPU completion without quarantining a loaded engine", async () => {
  const controller = new AbortController();
  let calls = 0;
  let observedSignal = null;
  const fixture = createFixture({
    enabled: true,
    model: {
      complete: async (_messages, options) => {
        calls++;
        if (calls > 1) return "recovered";
        observedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    },
  });
  const pending = fixture.engine.complete([], { signal: controller.signal });
  await waitFor(() => observedSignal !== null);
  controller.abort("verification replaced");
  await assert.rejects(
    pending,
    error => error.kind === "cancelled" && error.reason === "verification replaced",
  );
  assert.strictEqual(observedSignal.aborted, true);
  assert.strictEqual(fixture.engine.state().quarantined, false);
  assert.strictEqual(await fixture.engine.complete([], {}), "recovered");
  assert.deepStrictEqual(fixture.counts(), { imports: 1, loads: 1 });
});

test("cancelled WebGPU load remains a single page attempt", async () => {
  const controller = new AbortController();
  let loadSignal = null;
  const fixture = createFixture({
    enabled: true,
    load: async received => {
      loadSignal = received.signal;
      return new Promise((_resolve, reject) => {
        received.signal.addEventListener("abort", () => reject(received.signal.reason), { once: true });
      });
    },
  });
  const pending = fixture.engine.complete([], { signal: controller.signal });
  await waitFor(() => loadSignal !== null);
  controller.abort("verification replaced during load");
  await assert.rejects(pending, error => error.kind === "cancelled");
  assert.strictEqual(fixture.engine.state().quarantined, true);
  await assert.rejects(fixture.engine.complete([], {}), error => error.kind === "quarantined");
  assert.deepStrictEqual(fixture.counts(), { imports: 1, loads: 1 });
});

test("preserves validated rerank parsing on the successful path", async () => {
  const output = JSON.stringify({
    best: 2,
    status: "updated",
    confidence: 0.8,
    risk_flags: ["year_mismatch"],
    reason: "Year needs review.",
  });
  const candidates = [{ title: "A" }, { title: "B" }];
  const result = await gemma.rerank({
    original: { title: "B" },
    candidates,
    parseChoice: lib.parseRerankChoice,
    engine: { complete: async () => output },
  });
  assert.strictEqual(result.candidate, candidates[1]);
  assert.strictEqual(result.status, "needs_review");
});

test("forwards the caller signal through Gemma rerank and citation completion", async () => {
  const controller = new AbortController();
  const received = [];
  const engine = {
    complete: async (_messages, options) => {
      received.push(options);
      return received.length === 1 ? '{"best":1}' : "citation output";
    },
  };
  await gemma.rerank({
    original: { title: "A" },
    candidates: [{ title: "A" }, { title: "B" }],
    parseChoice: lib.parseRerankChoice,
    signal: controller.signal,
    engine,
  });
  await gemma.completePrompt("prompt", { signal: controller.signal, engine });
  assert.strictEqual(received[0].signal, controller.signal);
  assert.strictEqual(received[1].signal, controller.signal);
});

test("declares opt-in and quarantine contracts in the browser surface", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
  const citation = fs.readFileSync(path.join(root, "docs", "citation-audit.js"), "utf8");
  assert.match(html, /id="opt-local-gpu-rerank"\s*\/>/);
  assert.doesNotMatch(html, /id="opt-local-gpu-rerank"[^>]*checked/);
  for (const text of ["Experimental WebGPU", "Hugging Face", "CI checks lifecycle", "hardware behavior may vary"])
    assert.ok(html.includes(text), text);
  const requestIndex = html.indexOf("request.js?v=");
  const engineIndex = html.indexOf("webgpu-engine.js?v=");
  const gemmaIndex = html.indexOf("gemma-reranker.js?v=");
  assert.ok(requestIndex >= 0 && engineIndex > requestIndex && gemmaIndex > engineIndex);
  assert.ok(app.includes("BibGemmaReranker?.setEnabled?.(enabled)"));
  assert.ok(!app.includes("optLocalGpuRerank.checked = true"));
  assert.ok(!app.includes("resetQuarantine"));
  assert.ok(citation.includes("BibGemmaReranker?.isEnabled?.()"));
  assert.doesNotMatch(gemma.GEMMA_MODULE_URL, /\/resolve\/main\//);
  assert.match(app, /rerank failed; using heuristic candidate[\s\S]*?return null;/);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }
  if (failed) process.exit(1);
})();
