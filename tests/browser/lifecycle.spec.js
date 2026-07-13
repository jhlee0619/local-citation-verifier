"use strict";

const { test, expect } = require("@playwright/test");
const {
  preparePage,
  startVerification,
  waitForDone,
  verifyBib,
  downloadBib,
  expectCleanNetwork,
} = require("./harness.js");
const {
  LOADER_REVISION,
  MODEL_REVISION,
  LOADER_URL,
  semanticPaper,
} = require("./fixtures.js");

const BIB = title => `@article{fixture,
  title = {${title}},
  author = {Owner, Olivia},
  year = {2020},
}`;

const FAIL = Object.freeze({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: "{",
});
const HANG = Object.freeze({ kind: "hang" });

async function verifyBibWithClock(page, bib) {
  await startVerification(page, bib);
  for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
    await page.clock.runFor(500);
    await page.evaluate(() => Promise.resolve());
  }
  await waitForDone(page, { clock: true });
}

test("a late superseded response cannot overwrite the current run", async ({ page, baseURL }) => {
  const state = await preparePage(page, baseURL, {}, {
    initScript: () => {
      const nativeFetch = window.fetch.bind(window);
      const pending = [];
      window.__lateFetchCount = 0;
      window.__resolveLateFetch = () => pending.splice(0).forEach(resolve => resolve());
      window.fetch = (input, init) => {
        const raw = typeof input === "string" ? input : input.url;
        const url = new URL(raw, window.location.href);
        if (url.pathname.endsWith("/paper/search/match") && url.searchParams.get("query") === "Delayed Run A") {
          window.__lateFetchCount += 1;
          return new Promise(resolve => pending.push(() => resolve(new Response(JSON.stringify({
            data: [{
              paperId: "late-run-a",
              title: "Delayed Run A",
              authors: [{ name: "Late Writer" }],
              year: 1999,
              venue: "Stale Journal",
              externalIds: {},
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } }))));
        }
        return nativeFetch(input, init);
      };
    },
  });

  await startVerification(page, BIB("Delayed Run A"));
  await expect.poll(() => page.evaluate(() => window.__lateFetchCount)).toBe(1);
  await startVerification(page, BIB("Fresh Run B"));
  await waitForDone(page);
  const before = await downloadBib(page);
  const beforeSummary = await page.locator(".summary-count").allTextContents();

  await page.evaluate(() => window.__resolveLateFetch());
  await page.waitForTimeout(200);
  await expect(page.locator(".entry-card")).toHaveCount(1);
  await expect(page.locator('.entry-card[data-index="0"] .entry-title')).toHaveText("Fresh Run B");
  expect(await page.locator(".summary-count").allTextContents()).toEqual(beforeSummary);
  expect(await downloadBib(page)).toBe(before);
  expect(before).not.toContain("Delayed Run A");
  expectCleanNetwork(state);
});

test("distinguishes all-failed lookup from a partial provider success", async ({ browser, baseURL }) => {
  const failedPage = await browser.newPage();
  const failedState = await preparePage(failedPage, baseURL, {
    ssMatch: FAIL,
    ssSearch: FAIL,
    crossrefSearch: FAIL,
    dblp: FAIL,
    openreview: FAIL,
  }, { clock: true });
  await verifyBibWithClock(failedPage, BIB("All Providers Failed"));
  await expect(failedPage.locator('.entry-card[data-index="0"] .status-tag')).toHaveText("Lookup Failed");
  await expect(failedPage.locator('.entry-card[data-index="0"]')).toHaveAttribute("data-status", "needs_review");
  expectCleanNetwork(failedState);
  await failedPage.close();

  const partialPage = await browser.newPage();
  const candidate = semanticPaper({
    paperId: "partial-success",
    title: "Partial Provider Success",
    externalIds: {},
  });
  const partialState = await preparePage(partialPage, baseURL, {
    ssMatch: { data: [candidate] },
    ssSearch: FAIL,
    crossrefSearch: FAIL,
    dblp: FAIL,
    openreview: FAIL,
  }, { clock: true });
  await verifyBibWithClock(partialPage, BIB("Partial Provider Success"));
  await expect(partialPage.locator('.entry-card[data-index="0"] .status-tag')).toHaveText("Needs Review");
  await expect(partialPage.locator('.entry-card[data-index="0"] .source-warning')).toBeVisible();
  expectCleanNetwork(partialState);
  await partialPage.close();
});

test("cancellation clears results and prevents export", async ({ page, baseURL }) => {
  const state = await preparePage(page, baseURL, {
    ssMatch: HANG,
    ssSearch: HANG,
    crossrefSearch: HANG,
    dblp: HANG,
    openreview: HANG,
  });
  await startVerification(page, BIB("Cancellation Fixture"));
  await expect.poll(() => state.requests.filter(request => request.endpoint !== "vllmHealth").length).toBeGreaterThanOrEqual(5);
  await page.locator("#btn-cancel-verification").click();

  await expect(page.locator(".bar-progress-text")).toContainText("Cancelled —");
  await expect(page.locator(".entry-card")).toHaveCount(0);
  await expect(page.locator("#btn-download")).toBeDisabled();
  await expect(page.locator("#preview-code")).toBeHidden();
  expectCleanNetwork(state);
});

test("production deadlines terminate hung providers and clean JSONP state", async ({ page, baseURL }) => {
  const state = await preparePage(page, baseURL, {
    ssMatch: HANG,
    ssSearch: HANG,
    crossrefSearch: HANG,
    dblp: HANG,
    openreview: HANG,
  }, { clock: true });
  await startVerification(page, BIB("Timeout Fixture"));

  for (let elapsed = 0; elapsed < 45_000; elapsed += 5_000) {
    await page.clock.runFor(5_000);
    await page.evaluate(() => Promise.resolve());
  }
  await waitForDone(page, { clock: true });
  await expect(page.locator('.entry-card[data-index="0"] .status-tag')).toHaveText("Lookup Failed");

  const counts = Object.groupBy(
    state.requests.filter(request => !["vllmHealth"].includes(request.endpoint)),
    request => request.endpoint,
  );
  for (const requests of Object.values(counts)) expect(requests.length).toBeLessThanOrEqual(3);
  expect((counts.dblp || []).length).toBeLessThanOrEqual(1);

  await page.evaluate(() => {
    window.__jsonpOutcome = "pending";
    window.BibRequest.jsonp("/__hang/jsonp", {
      callbackName: "__browserJsonp",
      timeoutMs: 1_000,
    }).then(() => { window.__jsonpOutcome = "resolved"; })
      .catch(error => { window.__jsonpOutcome = error.kind || error.name; });
  });
  await page.clock.runFor(1_001);
  await expect.poll(() => page.evaluate(() => window.__jsonpOutcome)).toBe("deadline_timeout");
  expect(await page.evaluate(() => ({
    callback: typeof window.__browserJsonp,
    scripts: document.querySelectorAll('script[src*="/__hang/jsonp"]').length,
  }))).toEqual({ callback: "undefined", scripts: 0 });
  expectCleanNetwork(state);
});

test("WebGPU opt-in uses pinned revisions then quarantines a timed-out engine", async ({ page, baseURL }) => {
  const loader = `export const Gemma4Mobile = {
    async load(_model, options) {
      globalThis.__fixtureModelRevision = options.revision;
      globalThis.__fixtureLoadCount = (globalThis.__fixtureLoadCount || 0) + 1;
      return { complete() {
        globalThis.__fixtureCompleteCount = (globalThis.__fixtureCompleteCount || 0) + 1;
        return new Promise(() => {});
      } };
    }
  };`;
  const state = await preparePage(page, baseURL, {
    hfLoader: { body: loader },
    ssSearch: { data: [
      semanticPaper({ paperId: "gpu-a", title: "GPU Fallback Fixture", externalIds: {} }),
      semanticPaper({
        paperId: "gpu-b",
        title: "GPU Fallback Fixture",
        authors: [{ name: "Different Candidate" }],
        year: 2021,
        externalIds: {},
      }),
    ] },
  }, {
    clock: true,
    initScript: () => Object.defineProperty(navigator, "gpu", { value: {}, configurable: true }),
  });
  expect(state.requests.filter(request => request.endpoint === "hfLoader")).toHaveLength(0);

  await page.evaluate(() => {
    const provider = document.querySelector("#opt-rerank-provider");
    const speed = document.querySelector("#opt-speed-mode");
    const enabled = document.querySelector("#opt-local-gpu-rerank");
    provider.value = "webgpu";
    speed.value = "thorough";
    enabled.checked = true;
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    speed.dispatchEvent(new Event("change", { bubbles: true }));
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    window.__webgpuOutcome = "pending";
    window.BibGemmaReranker.completePrompt("timeout fixture")
      .then(() => { window.__webgpuOutcome = "resolved"; })
      .catch(error => { window.__webgpuOutcome = error.kind || error.name; });
  });
  await expect.poll(() => page.evaluate(() => window.__fixtureModelRevision)).toBe(MODEL_REVISION);
  expect(state.requests.filter(request => request.endpoint === "hfLoader").map(request => request.url)).toEqual([LOADER_URL]);

  await page.clock.runFor(120_001);
  await expect.poll(() => page.evaluate(() => window.__webgpuOutcome)).toBe("complete_timeout");
  expect(await page.evaluate(() => window.BibGemmaReranker.engineState().quarantined)).toBe(true);
  const second = await page.evaluate(async () => {
    try {
      await window.BibGemmaReranker.completePrompt("second attempt");
      return "resolved";
    } catch (error) {
      return error.kind || error.name;
    }
  });
  expect(second).toBe("quarantined");
  expect(await page.evaluate(() => ({
    loads: window.__fixtureLoadCount,
    completes: window.__fixtureCompleteCount,
    loaderRevision: window.BibGemmaReranker.LOADER_REVISION,
  }))).toEqual({ loads: 1, completes: 1, loaderRevision: LOADER_REVISION });

  await verifyBib(page, BIB("GPU Fallback Fixture"), { clock: true });
  await expect(page.locator('.entry-card[data-index="0"]')).toHaveAttribute("data-status", "needs_review");
  await expect(page.locator("#gpu-rerank-status")).toContainText("heuristic");
  expect(await downloadBib(page)).toContain("author = {Owner, Olivia}");
  expectCleanNetwork(state);
});
