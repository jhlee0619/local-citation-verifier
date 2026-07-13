"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const docs = path.join(root, "docs");
const vendorBundlePath = path.join(docs, "vendor", "fuzzball-2.2.3.umd.min.js");
const vendorLicensePath = path.join(docs, "vendor", "fuzzball.LICENSE");
const vendorReadmePath = path.join(docs, "vendor", "README.md");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseCsp(policy) {
  const directives = new Map();
  for (const part of policy.split(";").map(value => value.trim()).filter(Boolean)) {
    const [rawDirective, ...values] = part.split(/\s+/);
    const directive = rawDirective.toLowerCase();
    assert.ok(!directives.has(directive), `duplicate CSP directive: ${directive}`);
    directives.set(directive, values);
  }
  return directives;
}

function extractServerCsp(source) {
  const block = source.match(/CSP_POLICY: Final = \(\s*([\s\S]*?)\s*\n\)/)?.[1] || "";
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map(match => JSON.parse(`"${match[1]}"`))
    .join("");
}

function scriptAttributeSections(html) {
  const sections = [];
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const start = lower.indexOf("<script", cursor);
    if (start < 0) break;
    const boundary = html[start + 7] || "";
    if (boundary && !/[\s/>]/.test(boundary)) {
      cursor = start + 7;
      continue;
    }
    let quote = "";
    let end = -1;
    for (let index = start + 7; index < html.length; index += 1) {
      const character = html[index];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        end = index;
        break;
      }
    }
    assert.ok(end >= 0, "unterminated script opening tag");
    sections.push(html.slice(start + 7, end));
    cursor = end + 1;
  }
  return sections;
}

function scriptSources(html) {
  return scriptAttributeSections(html).flatMap(attributes => {
    const assignments = [...attributes.matchAll(/(?:^|[\s/])src\s*=/gi)];
    const matches = [...attributes.matchAll(/(?:^|[\s/])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)];
    assert.strictEqual(matches.length, assignments.length, "unparseable script src attribute");
    assert.ok(matches.length <= 1, "duplicate script src attribute");
    if (!matches.length) return [];
    return [matches[0][1] ?? matches[0][2] ?? matches[0][3]];
  });
}

function isLocalScriptSource(source) {
  const [pathname] = source.split("?", 1);
  if (!/^[a-z0-9._/-]+\.js(?:\?v=[a-z0-9._-]+)?$/i.test(source) || pathname.startsWith("/")) return false;
  return !pathname.split("/").some(segment => segment === "." || segment === "..");
}

function externalScriptSources(html) {
  return scriptSources(html).filter(source => !isLocalScriptSource(source));
}

function hasMutableRevision(source) {
  return source.includes("/resolve/main/");
}

assert.ok(fs.existsSync(vendorBundlePath), "vendored fuzzball bundle must exist");
assert.ok(fs.existsSync(vendorLicensePath), "vendored fuzzball license must exist");
assert.ok(fs.existsSync(vendorReadmePath), "vendored fuzzball provenance must exist");

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
assert.strictEqual(packageJson.devDependencies.fuzzball, "2.2.3");
assert.strictEqual(packageLock.packages[""].devDependencies.fuzzball, "2.2.3");
assert.strictEqual(packageLock.packages["node_modules/fuzzball"].version, "2.2.3");

const installedRoot = path.dirname(require.resolve("fuzzball/package.json"));
const installedBundle = fs.readFileSync(path.join(installedRoot, "dist", "fuzzball.umd.min.js"));
const installedLicense = fs.readFileSync(path.join(installedRoot, "LICENSE.md"));
const vendorBundle = fs.readFileSync(vendorBundlePath);
const vendorLicense = fs.readFileSync(vendorLicensePath);
assert.deepStrictEqual(vendorBundle, installedBundle, "vendored bundle must exactly match the locked package");
assert.deepStrictEqual(vendorLicense, installedLicense, "vendored license must exactly match the locked package");

const provenance = fs.readFileSync(vendorReadmePath, "utf8");
const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
const packageIntegrity = packageLock.packages["node_modules/fuzzball"].integrity;
assert.ok(provenance.includes("fuzzball@2.2.3"));
assert.ok(provenance.includes("node_modules/fuzzball/dist/fuzzball.umd.min.js"));
assert.ok(provenance.includes(packageIntegrity));
assert.ok(provenance.includes(sha256(vendorBundle)));
assert.ok(provenance.includes(sha256(vendorLicense)));
assert.match(provenance, /MIT/);
assert.match(provenance, /SHA-256/);
assert.ok(attributes.includes("docs/vendor/fuzzball-2.2.3.umd.min.js -text"));
assert.ok(attributes.includes("docs/vendor/fuzzball.LICENSE -text"));

const html = fs.readFileSync(path.join(docs, "index.html"), "utf8");
const productionScripts = scriptSources(html);
const fuzzballIndex = productionScripts.indexOf("vendor/fuzzball-2.2.3.umd.min.js?v=2.2.3");
const bibLibIndex = productionScripts.indexOf("lib.js?v=20260712-run-ownership-final");
assert.ok(fuzzballIndex >= 0 && bibLibIndex > fuzzballIndex, "fuzzball must load locally before BibLib");
assert.deepStrictEqual(externalScriptSources(html), [], "every production script must be local");
for (const source of productionScripts) {
  const localPath = source.split("?", 1)[0];
  assert.ok(fs.existsSync(path.join(docs, localPath)), `local script is missing: ${localPath}`);
}
assert.deepStrictEqual(externalScriptSources(`
  <script src="https://evil.test/double.js"></script>
  <script SRC = 'https://evil.test/single.js'></script>
  <script src=//evil.test/unquoted.js></script>
  <script data-src="lib.js" src="https://evil.test/data-prefix.js"></script>
  <script data-note=">" src="https://evil.test/quoted-angle.js"></script>
  <script src="&#x68;ttps://evil.test/entity.js"></script>
`), [
  "https://evil.test/double.js",
  "https://evil.test/single.js",
  "//evil.test/unquoted.js",
  "https://evil.test/data-prefix.js",
  "https://evil.test/quoted-angle.js",
  "&#x68;ttps://evil.test/entity.js",
]);
assert.throws(
  () => scriptSources('<script src="lib.js" src="https://evil.test/duplicate.js"></script>'),
  /duplicate script src attribute/,
);
assert.throws(
  () => scriptSources("<script src=`https://evil.test/backtick.js`></script>"),
  /unparseable script src attribute/,
);
assert.strictEqual(hasMutableRevision("https://huggingface.co/model/resolve/main/model.json"), true);

const productionRuntime = fs.readdirSync(docs, { recursive: true })
  .filter(name => /\.(?:html|js)$/i.test(name))
  .map(name => fs.readFileSync(path.join(docs, name), "utf8"))
  .join("\n");
assert.strictEqual(hasMutableRevision(productionRuntime), false, "mutable Hugging Face revisions are forbidden");
assert.ok(!html.includes("unpkg.com"), "unpkg must not remain in HTML or meta CSP");
assert.throws(
  () => parseCsp("SCRIPT-SRC https://evil.test; script-src 'self'"),
  /duplicate CSP directive: script-src/,
);

const metaPolicy = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1] || "";
const serverSource = fs.readFileSync(path.join(root, "server", "vllm_proxy_server.py"), "utf8");
const serverPolicy = extractServerCsp(serverSource);
const metaDirectives = parseCsp(metaPolicy);
const serverDirectives = parseCsp(serverPolicy);
assert.deepStrictEqual(metaDirectives.get("script-src"), [
  "'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://huggingface.co",
]);
assert.deepStrictEqual(metaDirectives.get("connect-src"), [
  "'self'",
  "https://api.crossref.org",
  "https://api.semanticscholar.org",
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  "https://cas-bridge.xethub.hf.co",
  "https://cas-server.xethub.hf.co",
  "https://transfer.xethub.hf.co",
]);
assert.ok(!serverDirectives.get("script-src")?.includes("https://dblp.org"));
assert.ok(!serverDirectives.get("script-src")?.includes("https://openreview.net"));
assert.ok(!serverPolicy.includes("unpkg.com"));
assert.deepStrictEqual(serverDirectives.get("frame-ancestors"), ["'none'"]);
serverDirectives.delete("frame-ancestors");
assert.deepStrictEqual(serverDirectives, metaDirectives, "meta and response CSP shared directives must not drift");
assert.ok(!fs.readFileSync(path.join(docs, "app.js"), "utf8").includes("R.jsonp("));

const browserContext = { console };
browserContext.window = browserContext;
vm.createContext(browserContext);
vm.runInContext(vendorBundle.toString("utf8"), browserContext, { filename: "fuzzball-2.2.3.umd.min.js" });
assert.strictEqual(typeof browserContext.fuzzball?.token_sort_ratio, "function");
let fuzzballCalls = 0;
browserContext.fuzzball.token_sort_ratio = () => {
  fuzzballCalls += 1;
  return 73;
};
vm.runInContext(fs.readFileSync(path.join(docs, "lib.js"), "utf8"), browserContext, { filename: "lib.js" });
assert.strictEqual(browserContext.BibLib.titleSimilarity("alpha", "beta"), 73);
assert.strictEqual(fuzzballCalls, 1, "production BibLib must execute the fuzzball-backed path");

console.log("security contract tests passed");
