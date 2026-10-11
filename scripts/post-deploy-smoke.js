"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// The release CSP contract. The policy itself is read from the deployed,
// hash-verified index.html (no copy is kept here); these directives must hold
// exactly, and connect-src may name only 'self' and https:// origins.
const REQUIRED_CSP = Object.freeze({
  "default-src": "'self'",
  "base-uri": "'none'",
  "object-src": "'none'",
  "form-action": "'self'",
  "script-src": "'self'",
  "img-src": "'self' data:",
});

// The providers the GitHub Pages build asks directly from the browser:
// connect-src must allow each of them (S11 added PubMed, NCBI E-utilities;
// S15 DataCite, which confirms DOIs and arXiv IDs).
const REQUIRED_CONNECT_SOURCES = Object.freeze([
  "'self'",
  "https://api.crossref.org",
  "https://api.semanticscholar.org",
  "https://eutils.ncbi.nlm.nih.gov",
  "https://api.datacite.org",
]);

function fail(message) {
  throw new Error(message);
}

// The deployed CSP must allow scripts from this origin only: no remote
// script origin, no inline or eval escape hatch.
function assertScriptSrcSelfOnly(csp) {
  const directives = String(csp || "").split(";").map(part => part.trim().split(/\s+/)).filter(tokens => tokens[0]);
  const scriptSrc = directives.filter(tokens => tokens[0].toLowerCase() === "script-src");
  if (scriptSrc.length !== 1) fail("deployed CSP must have exactly one script-src directive");
  if (scriptSrc[0].slice(1).join(" ") !== "'self'") fail("deployed CSP script-src must be 'self' only (no remote script origin)");
}

function parseCsp(csp) {
  const directives = new Map();
  for (const part of String(csp || "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (directives.has(key)) fail(`deployed CSP repeats the ${key} directive`);
    directives.set(key, values);
  }
  return directives;
}

// The CSP of the deployed index.html (its one meta tag).
function cspFromHtml(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes ?? "");
  const metas = [...text.matchAll(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]*)"/gi)];
  if (metas.length !== 1) fail("deployed index.html must carry exactly one CSP meta tag");
  return metas[0][1];
}

function assertCspContract(csp) {
  assertScriptSrcSelfOnly(csp);
  const directives = parseCsp(csp);
  for (const [name, value] of Object.entries(REQUIRED_CSP)) {
    if ((directives.get(name) || []).join(" ") !== value) fail(`deployed CSP ${name} must be ${value}`);
  }
  for (const source of directives.get("connect-src") || []) {
    if (source !== "'self'" && !/^https:\/\/[a-z0-9.-]+$/i.test(source)) fail(`deployed CSP connect-src allows ${source}`);
  }
  for (const source of REQUIRED_CONNECT_SOURCES) {
    if (!(directives.get("connect-src") || []).includes(source)) fail(`deployed CSP connect-src must allow ${source}`);
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`invalid argument: ${key || "<missing>"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function publicUrl(base, filePath = "") {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return new URL(encoded, normalizedBase).href;
}

function validateDeploymentUrl(value, expectedHost, { allowHttpLocalhost = false } = {}) {
  if (!expectedHost) fail("expected host is required");
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.hostname.toLowerCase() !== expectedHost.toLowerCase()) fail("deployment URL does not use the expected host");
  if (url.username || url.password) fail("deployment URL must not contain credentials");
  if (url.search || url.hash) fail("deployment URL must not contain a query or fragment");
  if (url.protocol === "https:") {
    if (url.port) fail("deployment URL must use the standard HTTPS port");
  } else if (!(url.protocol === "http:" && allowHttpLocalhost && local)) {
    fail("deployment URL must use HTTPS");
  }
  return url;
}

function assertStaticContracts(files) {
  for (const [filePath, bytes] of files) {
    if (!/\.(?:html?|js)$/i.test(filePath)) continue;
    const text = bytes.toString("utf8");
    if (/\/resolve\/main\//i.test(text)) fail(`mutable /resolve/main/ reference in ${filePath}`);
    if (/\.html?$/i.test(filePath)) {
      for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
        if (/^(?:https?:)?\/\//i.test(match[1])) fail(`external script tag in ${filePath}: ${match[1]}`);
      }
    }
  }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchBytes(url, { attempts, retryMs, expectedOrigin }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
        redirect: "error",
      });
      if (response.url && new URL(response.url).origin !== expectedOrigin) fail(`response escaped expected origin: ${response.url}`);
      if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(retryMs);
    }
  }
  throw lastError;
}

async function verifyPublicBytes(baseUrl, manifestPath, retry) {
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const expectedOrigin = new URL(baseUrl).origin;
  const request = { ...retry, expectedOrigin };
  const publicManifest = await fetchBytes(publicUrl(baseUrl, "_release/manifest.json"), request);
  if (!publicManifest.equals(manifestBytes)) fail("public release manifest bytes differ from the deployed artifact");
  const files = new Map();
  await Promise.all(manifest.files.map(async entry => {
    const bytes = await fetchBytes(publicUrl(baseUrl, entry.path), request);
    if (bytes.length !== entry.size) fail(`public size mismatch for ${entry.path}`);
    if (sha256(bytes) !== entry.sha256) fail(`public hash mismatch for ${entry.path}`);
    files.set(entry.path, bytes);
  }));
  assertStaticContracts(files);
  return { manifest, manifestDigest: sha256(manifestBytes), files };
}

// expectedCsp: the CSP of the hash-verified index.html; the page the browser
// loads must carry the same one.
async function verifyBrowser(baseUrl, expectedCsp) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const externalRequests = [];
  const failedRequests = [];
  const consoleErrors = [];
  const pageErrors = [];
  const unexpectedPages = [];
  const expectedOrigin = new URL(baseUrl).origin;
  try {
    await context.route("**/*", async route => {
      const target = route.request().url();
      if (/^https?:/i.test(target) && new URL(target).origin !== expectedOrigin) {
        externalRequests.push(target);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    context.on("requestfailed", request => {
      const target = request.url();
      if (!/^https?:/i.test(target) || new URL(target).origin === expectedOrigin) failedRequests.push(target);
    });
    let page;
    context.on("page", opened => {
      if (page && opened !== page) {
        unexpectedPages.push(opened.url() || "about:blank");
        void opened.close();
      }
    });
    page = await context.newPage();
    page.on("console", message => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    const response = await page.goto(publicUrl(baseUrl), { waitUntil: "networkidle", timeout: 30000 });
    if (!response?.ok()) fail(`browser root navigation returned HTTP ${response?.status() || "unknown"}`);
    if (new URL(page.url()).origin !== expectedOrigin) fail("browser navigation escaped the expected origin");
    await page.waitForTimeout(750);
    const state = await page.evaluate(async () => {
      return {
        title: document.title,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
        scripts: [...document.scripts].map(script => script.src).filter(Boolean),
        gpuConsent: document.querySelector("#opt-local-gpu-rerank")?.checked,
      };
    });
    if (!/Citation Verifier/.test(state.title || "")) fail("deployed page title is missing");
    if (state.csp !== expectedCsp) fail("the loaded page's CSP differs from the deployed index.html");
    if (state.scripts.some(source => new URL(source).origin !== expectedOrigin)) fail("deployed page contains an external script tag");
    assertScriptSrcSelfOnly(state.csp);
    if (state.gpuConsent !== false) fail("AI rerank is not disabled by default");
    if (unexpectedPages.length) fail(`initial load opened unexpected pages: ${unexpectedPages.join(", ")}`);
    if (externalRequests.length) fail(`initial load attempted external requests: ${externalRequests.join(", ")}`);
    if (failedRequests.length) fail(`initial load had failed requests: ${failedRequests.join(", ")}`);
    if (consoleErrors.length) fail(`initial load logged console errors: ${consoleErrors.join(" | ")}`);
    if (pageErrors.length) fail(`initial load raised page errors: ${pageErrors.join(" | ")}`);
    return { ...state, unexpectedPages, externalRequests, failedRequests, consoleErrors, pageErrors };
  } finally {
    await context.close();
    await browser.close();
  }
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Pages public smoke\n\n- Status: ${report.status}\n- Mode: ${report.release_mode || "unknown"}\n- Source: \`${report.source_sha || "unknown"}\`\n- Docs tree: \`${report.docs_tree_id || "unknown"}\`\n- Manifest: \`${report.manifest_digest || "unknown"}\`\n- Artifact: \`${report.artifact_name || "unknown"}\` (ID \`${report.artifact_id || "unknown"}\`)\n- URL: ${report.page_url}\n\n`);
  }
}

function manifestIdentity(manifestPath) {
  try {
    const bytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(bytes);
    return { source_sha: manifest.source_sha, docs_tree_id: manifest.docs_tree_id, manifest_digest: sha256(bytes) };
  } catch {
    return {};
  }
}

async function run(options) {
  const attempts = Number.parseInt(options.attempts || "12", 10);
  const retryMs = Number.parseInt(options["retry-ms"] || "5000", 10);
  if (!options.url || !options["expected-host"] || !options.manifest || !options.output) {
    fail("--url, --expected-host, --manifest, and --output are required");
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) fail("attempts must be between 1 and 20");
  if (!Number.isInteger(retryMs) || retryMs < 0 || retryMs > 10000) fail("retry-ms must be between 0 and 10000");
  const deploymentUrl = validateDeploymentUrl(options.url, options["expected-host"], {
    allowHttpLocalhost: options["allow-http-localhost"] === "true",
  });
  const release = await verifyPublicBytes(deploymentUrl.href, options.manifest, { attempts, retryMs });
  const csp = cspFromHtml(release.files.get("index.html"));
  assertCspContract(csp);
  const browser = await verifyBrowser(deploymentUrl.href, csp);
  return {
    status: "passed", release_mode: options["release-mode"] || "unknown",
    artifact_name: options["artifact-name"] || "unknown",
    artifact_id: options["artifact-id"] || "unknown",
    page_url: publicUrl(deploymentUrl.href),
    source_sha: release.manifest.source_sha, docs_tree_id: release.manifest.docs_tree_id,
    manifest_digest: release.manifestDigest, checked_files: release.manifest.files.length, browser,
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  try {
    const report = await run(options);
    writeReport(options.output, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    if (options.output) writeReport(options.output, {
      status: "failed", release_mode: options["release-mode"] || "unknown",
      artifact_name: options["artifact-name"] || "unknown",
      artifact_id: options["artifact-id"] || "unknown",
      page_url: options.url || "unknown",
      ...manifestIdentity(options.manifest), error: error.message,
    });
    throw error;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_CSP, REQUIRED_CONNECT_SOURCES, assertCspContract, assertScriptSrcSelfOnly, assertStaticContracts, cspFromHtml, fetchBytes, publicUrl, run,
  validateDeploymentUrl, verifyPublicBytes, writeReport,
};
