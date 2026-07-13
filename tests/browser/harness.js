"use strict";

const fs = require("fs/promises");
const { expect } = require("@playwright/test");
const { installFixtureRoutes } = require("./fixtures.js");

async function preparePage(page, baseURL, scenario = {}, options = {}) {
  if (options.clock) await page.clock.install({ time: new Date("2026-07-13T00:00:00Z") });
  if (options.initScript) await page.addInitScript(options.initScript);
  await page.addInitScript(() => {
    localStorage.setItem("bv-onboarding-dismissed", "1");
    localStorage.setItem("bv-onboarding-version", "3");
  });
  const state = await installFixtureRoutes(page, baseURL, scenario);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator('.input-tab[data-tab="paste"]').click();
  return state;
}

async function startVerification(page, bib) {
  await page.locator("#bib-paste").fill(bib);
  await page.locator("#btn-verify-paste").click();
}

async function waitForDone(page, options = {}) {
  await expect(page.locator(".bar-progress-text")).toContainText("Done —", { timeout: options.timeout || 15_000 });
  if (options.clock) await page.clock.runFor(1_250);
  await expect(page.locator("#btn-download")).toBeEnabled();
  await expect(page.locator("#btn-download")).not.toHaveClass(/hidden/);
}

async function verifyBib(page, bib, options = {}) {
  await startVerification(page, bib);
  await waitForDone(page, options);
}

async function downloadBib(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#btn-download").click(),
  ]);
  expect(download.suggestedFilename()).toBe("verified_refs.bib");
  const file = await download.path();
  return fs.readFile(file, "utf8");
}

function expectCleanNetwork(state, options = {}) {
  expect(state.browserErrors).toEqual([]);
  expect(state.failedLocalAssets).toEqual([]);
  expect(state.unhandledRequests).toEqual([]);
  if (!options.allowExternal) expect(state.externalRequests).toEqual([]);
}

module.exports = {
  preparePage,
  startVerification,
  waitForDone,
  verifyBib,
  downloadBib,
  expectCleanNetwork,
};
