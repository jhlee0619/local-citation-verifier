"use strict";

const { defineConfig, devices } = require("@playwright/test");

const port = Number(process.env.BROWSER_TEST_PORT || 4173);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: "test-results",
  reporter: [
    ["line"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    acceptDownloads: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "node tests/browser/static-server.js",
    env: { ...process.env, BROWSER_TEST_PORT: String(port) },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
