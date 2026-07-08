#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8088/";
const BIB_PATH = process.argv[2] || path.join(__dirname, "fixtures/user-stroke-bib.bib");
const LIVE_HTML = path.join(__dirname, "fixtures/browser-run-live.html");
const SCREENSHOT_DIR = path.join(__dirname, "fixtures/browser-shots");

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function writeLive({ step, log, screenshot, done, error }) {
  const lines = (log || []).map((line) => `<li>${esc(line)}</li>`).join("\n");
  const shot = screenshot
    ? `<p><img src="browser-shots/${path.basename(screenshot)}" alt="latest screenshot" style="max-width:100%;border:1px solid #444;border-radius:8px;" /></p>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8" />
<meta http-equiv="refresh" content="2" />
<title>Browser verification live</title>
<style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:24px;max-width:1100px}
h1{font-size:1.25rem} .step{color:#8cf;font-weight:600} ul{line-height:1.6}
.err{color:#f88} .ok{color:#8f8}
</style></head><body>
<h1>Local Citation Verifier — browser run</h1>
<p class="step">${esc(step || "starting")}</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${done ? `<p class="ok">Done. Open <a href="${esc(APP_URL)}" style="color:#8cf">${esc(APP_URL)}</a> for the full UI.</p>` : `<p>Auto-refresh every 2s… (${new Date().toLocaleTimeString()})</p>`}
<ul>${lines || "<li>Waiting…</li>"}</ul>
${shot}
</body></html>`;
  fs.mkdirSync(path.dirname(LIVE_HTML), { recursive: true });
  fs.writeFileSync(LIVE_HTML, html);
}

async function snap(page, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

(async () => {
  const log = [];
  const bib = fs.readFileSync(BIB_PATH, "utf8");
  writeLive({ step: "Launching browser", log: [`App: ${APP_URL}`, `Bib: ${BIB_PATH}`] });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    log.push("Navigate to app");
    writeLive({ step: "Loading app", log });
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await snap(page, "01-loaded");

    log.push("Switch to Paste BibTeX tab");
    writeLive({ step: "Paste BibTeX", log });
    await page.click('.input-tab[data-tab="paste"]');
    await page.fill("#bib-paste", bib);
    await snap(page, "02-pasted");

    log.push("Start verification (25 entries — API calls, may take ~2 min)");
    writeLive({ step: "Verifying… watch progress bar in screenshot", log });
    await page.click("#btn-verify-paste");

    let lastText = "";
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(2000);
      const progress = await page.textContent("#bar-progress-text").catch(() => "");
      const counts = await page.evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || "0";
        return {
          verified: pick(".badge-verified .summary-count"),
          updated: pick(".badge-updated .summary-count"),
          review: pick(".badge-review .summary-count"),
          notfound: pick(".badge-notfound .summary-count"),
          cards: document.querySelectorAll(".entry-card").length,
        };
      });
      const line = progress || `cards=${counts.cards} V=${counts.verified} U=${counts.updated} R=${counts.review} N=${counts.notfound}`;
      if (line !== lastText) {
        log.push(line);
        lastText = line;
      }
      writeLive({
        step: progress || "Verifying…",
        log: log.slice(-20),
        screenshot: await snap(page, "03-progress"),
      });
      const done = await page.evaluate(() => {
        const t = document.querySelector("#bar-progress-text")?.textContent || "";
        return t.startsWith("Done —") || document.querySelector("#btn-download:not(.hidden)");
      });
      if (done) break;
    }

    await snap(page, "04-done");
    const summary = await page.evaluate(() => {
      const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || "0";
      return {
        verified: pick(".badge-verified .summary-count"),
        updated: pick(".badge-updated .summary-count"),
        review: pick(".badge-review .summary-count"),
        notfound: pick(".badge-notfound .summary-count"),
      };
    });
    log.push(`Finished — verified=${summary.verified} updated=${summary.updated} needs_review=${summary.review} not_found=${summary.notfound}`);
    writeLive({
      step: "Verification complete",
      log,
      screenshot: path.join(SCREENSHOT_DIR, "04-done.png"),
      done: true,
    });
  } catch (err) {
    log.push(`Error: ${err.message}`);
    writeLive({ step: "Failed", log, error: err.message, done: true });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
