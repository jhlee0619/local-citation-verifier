"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRelease,
  verifyRelease,
} = require("../scripts/release-manifest.js");

const SOURCE_SHA = "1".repeat(40);
const TREE_ID = "2".repeat(40);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function rewriteManifest(site, mutate) {
  const releaseRoot = path.join(site, "_release");
  const manifestPath = path.join(releaseRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  mutate(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(path.join(releaseRoot, "manifest.sha256"), `${sha256(bytes)}\n`);
}

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bibtex-release-"));
  const source = path.join(root, "docs");
  const site = path.join(root, "site");
  fs.mkdirSync(path.join(source, "nested"), { recursive: true });
  fs.writeFileSync(path.join(source, "index.html"), "<h1>Verifier</h1>\n");
  fs.writeFileSync(path.join(source, "nested", "가.txt"), Buffer.from([0, 1, 2, 255]));
  try {
    run({ root, source, site });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCreateAndVerify() {
  withFixture(({ source, site }) => {
    const result = createRelease({
      source,
      site,
      sourceSha: SOURCE_SHA,
      docsTreeId: TREE_ID,
    });
    const manifestBytes = fs.readFileSync(path.join(site, "_release", "manifest.json"));
    const digestBytes = fs.readFileSync(path.join(site, "_release", "manifest.sha256"), "utf8");
    const manifest = JSON.parse(manifestBytes);

    assert.strictEqual(result.manifestDigest, sha256(manifestBytes));
    assert.strictEqual(digestBytes, `${result.manifestDigest}\n`);
    assert.deepStrictEqual(manifest, {
      schema: 1,
      source_sha: SOURCE_SHA,
      docs_tree_id: TREE_ID,
      files: [
        {
          path: "index.html",
          size: 18,
          sha256: sha256("<h1>Verifier</h1>\n"),
        },
        {
          path: "nested/가.txt",
          size: 4,
          sha256: sha256(Buffer.from([0, 1, 2, 255])),
        },
      ],
    });
    assert.deepStrictEqual(verifyRelease({
      site,
      expectedSourceSha: SOURCE_SHA,
      expectedDocsTreeId: TREE_ID,
    }), result);
  });
}

function testMutationIsRejected() {
  withFixture(({ source, site }) => {
    createRelease({ source, site, sourceSha: SOURCE_SHA, docsTreeId: TREE_ID });
    fs.writeFileSync(path.join(site, "index.html"), "<h1>VerifieX</h1>\n");
    assert.throws(() => verifyRelease({ site }), /hash mismatch.*index\.html/i);
  });
}

function testExtraAndMissingFilesAreRejected() {
  withFixture(({ source, site }) => {
    createRelease({ source, site, sourceSha: SOURCE_SHA, docsTreeId: TREE_ID });
    fs.writeFileSync(path.join(site, "unexpected.txt"), "unexpected");
    assert.throws(() => verifyRelease({ site }), /unexpected file.*unexpected\.txt/i);
    fs.rmSync(path.join(site, "unexpected.txt"));
    fs.rmSync(path.join(site, "index.html"));
    assert.throws(() => verifyRelease({ site }), /missing file.*index\.html/i);
  });
}

function testReleaseMetadataAndUnsafePathsAreRejected() {
  withFixture(({ source, site }) => {
    createRelease({ source, site, sourceSha: SOURCE_SHA, docsTreeId: TREE_ID });
    fs.writeFileSync(path.join(site, "_release", "unexpected.txt"), "unexpected");
    assert.throws(() => verifyRelease({ site }), /unexpected release metadata.*unexpected\.txt/i);
    fs.rmSync(path.join(site, "_release", "unexpected.txt"));
    rewriteManifest(site, manifest => {
      manifest.files[0].path = "../escape.txt";
    });
    assert.throws(() => verifyRelease({ site }), /unsafe path.*\.\.\/escape\.txt/i);
  });
}

function testInvalidIdentityAndDirtyDestinationAreRejected() {
  withFixture(({ source, site }) => {
    assert.throws(() => createRelease({
      source,
      site,
      sourceSha: "main",
      docsTreeId: TREE_ID,
    }), /source SHA.*40 lowercase/i);
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, "old.txt"), "old");
    assert.throws(() => createRelease({
      source,
      site,
      sourceSha: SOURCE_SHA,
      docsTreeId: TREE_ID,
    }), /destination.*empty/i);
  });
}

function testMalformedEntryIsRejectedDeterministically() {
  withFixture(({ source, site }) => {
    createRelease({ source, site, sourceSha: SOURCE_SHA, docsTreeId: TREE_ID });
    rewriteManifest(site, manifest => {
      manifest.files = [null];
    });
    assert.throws(() => verifyRelease({ site }), /invalid file entry/i);
  });
}

testCreateAndVerify();
testMutationIsRejected();
testExtraAndMissingFilesAreRejected();
testReleaseMetadataAndUnsafePathsAreRejected();
testInvalidIdentityAndDirtyDestinationAreRejected();
testMalformedEntryIsRejectedDeterministically();
console.log("release manifest tests: OK");
