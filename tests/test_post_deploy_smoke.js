"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const {
  assertStaticContracts,
  fetchBytes,
  publicUrl,
  validateDeploymentUrl,
  verifyPublicBytes,
  writeReport,
} = require("../scripts/post-deploy-smoke.js");

function testDeploymentUrlPolicy() {
  assert.strictEqual(
    validateDeploymentUrl("https://owner.github.io/project/", "owner.github.io").href,
    "https://owner.github.io/project/",
  );
  assert.throws(
    () => validateDeploymentUrl("http://owner.github.io/project/", "owner.github.io"),
    /HTTPS/i,
  );
  assert.throws(
    () => validateDeploymentUrl("https://127.0.0.1/project/", "owner.github.io"),
    /expected host/i,
  );
  assert.throws(
    () => validateDeploymentUrl("https://owner.github.io:444/project/", "owner.github.io"),
    /standard HTTPS port/i,
  );
  assert.strictEqual(validateDeploymentUrl(
    "http://127.0.0.1:4189/",
    "127.0.0.1",
    { allowHttpLocalhost: true },
  ).origin, "http://127.0.0.1:4189");
}

function testStaticContracts() {
  assert.doesNotThrow(() => assertStaticContracts(new Map([
    ["index.html", Buffer.from("<script src=\"app.js\"></script>")],
    ["app.js", Buffer.from("const revision = '0123456789abcdef';")],
  ])));
  assert.throws(() => assertStaticContracts(new Map([
    ["app.js", Buffer.from("https://example.test/resolve/main/model.js")],
  ])), /mutable \/resolve\/main\//i);
  assert.throws(() => assertStaticContracts(new Map([
    ["index.html", Buffer.from("<script src='https://evil.test/app.js'></script>")],
  ])), /external script/i);
}

function testPublicUrlEncoding() {
  assert.strictEqual(
    publicUrl("https://owner.github.io/project/", "nested/가.txt"),
    "https://owner.github.io/project/nested/%EA%B0%80.txt",
  );
}

function testBrowserIsolationContract() {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "post-deploy-smoke.js"), "utf8");
  assert.match(source, /newContext\(\{ serviceWorkers: "block" \}\)/);
  assert.match(source, /context\.route\("\*\*\/\*"/);
  assert.match(source, /unexpectedPages/);
  assert.doesNotMatch(source, /page\.route\("\*\*\/\*"/);
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testFetchRetriesAndRedirectPolicy() {
  let retries = 0;
  await withServer((request, response) => {
    if (request.url === "/retry") {
      retries += 1;
      response.writeHead(retries === 1 ? 503 : 200);
      response.end(retries === 1 ? "retry" : "ready");
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/ready" });
      response.end();
      return;
    }
    response.writeHead(request.url === "/ready" ? 200 : 503);
    response.end(request.url === "/ready" ? "ready" : "failed");
  }, async base => {
    const expectedOrigin = new URL(base).origin;
    const bytes = await fetchBytes(`${base}retry`, { attempts: 2, retryMs: 0, expectedOrigin });
    assert.strictEqual(bytes.toString(), "ready");
    assert.strictEqual(retries, 2);
    await assert.rejects(
      fetchBytes(`${base}redirect`, { attempts: 1, retryMs: 0, expectedOrigin }),
      /fetch failed|redirect/i,
    );
    await assert.rejects(
      fetchBytes(`${base}missing`, { attempts: 2, retryMs: 0, expectedOrigin }),
      /HTTP 503/,
    );
  });
}

async function testPublishedByteVerificationAndEvidence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-smoke-"));
  const appBytes = Buffer.from("const release = 'immutable';");
  const manifest = {
    schema: 1,
    source_sha: "1".repeat(40),
    docs_tree_id: "2".repeat(40),
    files: [{
      path: "app.js",
      size: appBytes.length,
      sha256: crypto.createHash("sha256").update(appBytes).digest("hex"),
    }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, manifestBytes);
  let servedApp = appBytes;
  try {
    await withServer((request, response) => {
      if (request.url === "/_release/manifest.json") response.end(manifestBytes);
      else if (request.url === "/app.js") response.end(servedApp);
      else { response.writeHead(404); response.end(); }
    }, async base => {
      const result = await verifyPublicBytes(base, manifestPath, { attempts: 1, retryMs: 0 });
      assert.strictEqual(result.manifest.source_sha, manifest.source_sha);
      servedApp = Buffer.from("const release = 'tampered!';");
      await assert.rejects(
        verifyPublicBytes(base, manifestPath, { attempts: 1, retryMs: 0 }),
        /size mismatch|hash mismatch/,
      );
    });
    const output = path.join(root, "evidence", "failed.json");
    writeReport(output, { status: "failed", source_sha: manifest.source_sha, error: "fixture" });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(output)), {
      status: "failed", source_sha: manifest.source_sha, error: "fixture",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  testDeploymentUrlPolicy();
  testStaticContracts();
  testPublicUrlEncoding();
  testBrowserIsolationContract();
  await testFetchRetriesAndRedirectPolicy();
  await testPublishedByteVerificationAndEvidence();
  console.log("post-deploy smoke tests: OK");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
