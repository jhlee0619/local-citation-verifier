"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RELEASE_DIR = "_release";
const MANIFEST_NAME = "manifest.json";
const DIGEST_NAME = "manifest.sha256";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function assertIdentity(value, label) {
  if (!SHA_PATTERN.test(value || "")) {
    fail(`${label} must be a full 40 lowercase hexadecimal commit identity`);
  }
}

function sortPaths(paths) {
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function relativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function collectFiles(root, { allowRelease = false } = {}) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`release root must be a real directory: ${root}`);
  }
  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativePath(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`symbolic link is forbidden: ${relative}`);
      if (stat.isDirectory()) {
        if (!allowRelease && relative === RELEASE_DIR) {
          fail(`${RELEASE_DIR} is reserved for generated release metadata`);
        }
        visit(absolute);
      } else if (stat.isFile()) {
        files.push(relative);
      } else {
        fail(`unsupported filesystem entry: ${relative}`);
      }
    }
  }
  visit(root);
  return sortPaths(files);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertEmptyDestination(site) {
  if (!fs.existsSync(site)) return;
  const stat = fs.lstatSync(site);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("release destination must be an empty directory");
  }
  if (fs.readdirSync(site).length > 0) {
    fail("release destination must be empty");
  }
}

function assertSeparatePaths(source, site) {
  const sourceRoot = `${path.resolve(source)}${path.sep}`;
  const siteRoot = `${path.resolve(site)}${path.sep}`;
  if (sourceRoot === siteRoot || siteRoot.startsWith(sourceRoot)) {
    fail("release destination must be outside the source tree");
  }
}

function manifestEntry(root, filePath) {
  const bytes = fs.readFileSync(path.join(root, ...filePath.split("/")));
  return { path: filePath, size: bytes.length, sha256: sha256(bytes) };
}

function resultFor(manifest, manifestDigest) {
  return {
    sourceSha: manifest.source_sha,
    docsTreeId: manifest.docs_tree_id,
    manifestDigest,
    fileCount: manifest.files.length,
  };
}

function createRelease({ source, site, sourceSha, docsTreeId }) {
  assertIdentity(sourceSha, "source SHA");
  assertIdentity(docsTreeId, "docs tree ID");
  assertSeparatePaths(source, site);
  assertEmptyDestination(site);
  const sourceFiles = collectFiles(source);
  fs.mkdirSync(site, { recursive: true });
  for (const filePath of sourceFiles) {
    const destination = path.join(site, ...filePath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, ...filePath.split("/")), destination);
  }
  const manifest = {
    schema: 1,
    source_sha: sourceSha,
    docs_tree_id: docsTreeId,
    files: sourceFiles.map((filePath) => manifestEntry(site, filePath)),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestDigest = sha256(manifestBytes);
  const releaseRoot = path.join(site, RELEASE_DIR);
  fs.mkdirSync(releaseRoot);
  fs.writeFileSync(path.join(releaseRoot, MANIFEST_NAME), manifestBytes);
  fs.writeFileSync(path.join(releaseRoot, DIGEST_NAME), `${manifestDigest}\n`);
  return resultFor(manifest, manifestDigest);
}

function validateManifest(manifest, manifestBytes) {
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files)) {
    fail("release manifest schema is invalid");
  }
  assertIdentity(manifest.source_sha, "manifest source SHA");
  assertIdentity(manifest.docs_tree_id, "manifest docs tree ID");
  const canonical = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (!canonical.equals(manifestBytes)) fail("release manifest is not canonical JSON");
  if (manifest.files.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    fail("release manifest contains an invalid file entry");
  }
  const paths = manifest.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) fail("release manifest contains duplicate paths");
  if (JSON.stringify(paths) !== JSON.stringify(sortPaths([...paths]))) {
    fail("release manifest paths are not byte sorted");
  }
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail("release manifest contains an invalid file entry");
    }
    if (!entry.path || entry.path === "." || entry.path.split("/").includes("..")
      || path.posix.isAbsolute(entry.path) || path.posix.normalize(entry.path) !== entry.path
      || entry.path.includes("\\") || entry.path === RELEASE_DIR || entry.path.startsWith(`${RELEASE_DIR}/`)) {
      fail(`release manifest contains an unsafe path: ${entry.path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
      fail(`release manifest contains an invalid hash: ${entry.path}`);
    }
  }
}

function verifyRelease({ site, expectedSourceSha, expectedDocsTreeId }) {
  const releaseRoot = path.join(site, RELEASE_DIR);
  const manifestPath = path.join(releaseRoot, MANIFEST_NAME);
  const digestPath = path.join(releaseRoot, DIGEST_NAME);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  validateManifest(manifest, manifestBytes);
  if (expectedSourceSha && manifest.source_sha !== expectedSourceSha) fail("source SHA mismatch");
  if (expectedDocsTreeId && manifest.docs_tree_id !== expectedDocsTreeId) fail("docs tree ID mismatch");
  const manifestDigest = sha256(manifestBytes);
  const recordedDigest = fs.readFileSync(digestPath, "utf8");
  if (recordedDigest !== `${manifestDigest}\n`) fail("manifest digest mismatch");

  const allFiles = collectFiles(site, { allowRelease: true });
  const releaseFiles = allFiles.filter(filePath => filePath.startsWith(`${RELEASE_DIR}/`));
  const expectedReleaseFiles = [`${RELEASE_DIR}/${DIGEST_NAME}`, `${RELEASE_DIR}/${MANIFEST_NAME}`];
  for (const filePath of releaseFiles) {
    if (!expectedReleaseFiles.includes(filePath)) fail(`unexpected release metadata: ${filePath}`);
  }
  for (const filePath of expectedReleaseFiles) {
    if (!releaseFiles.includes(filePath)) fail(`missing release metadata: ${filePath}`);
  }
  const actualFiles = allFiles.filter(filePath => !filePath.startsWith(`${RELEASE_DIR}/`));
  const expectedFiles = manifest.files.map((entry) => entry.path);
  for (const filePath of expectedFiles) {
    if (!actualFiles.includes(filePath)) fail(`missing file: ${filePath}`);
  }
  for (const filePath of actualFiles) {
    if (!expectedFiles.includes(filePath)) fail(`unexpected file: ${filePath}`);
  }
  for (const entry of manifest.files) {
    const actual = manifestEntry(site, entry.path);
    if (actual.size !== entry.size) fail(`size mismatch for ${entry.path}`);
    if (actual.sha256 !== entry.sha256) fail(`hash mismatch for ${entry.path}`);
  }
  return resultFor(manifest, manifestDigest);
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

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const options = {
    source: args.source,
    site: args.site,
    sourceSha: args["source-sha"],
    docsTreeId: args["docs-tree-id"],
    expectedSourceSha: args["source-sha"],
    expectedDocsTreeId: args["docs-tree-id"],
  };
  const result = command === "create"
    ? createRelease(options)
    : command === "verify"
      ? verifyRelease(options)
      : fail("usage: release-manifest.js <create|verify> --site PATH [options]");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { collectFiles, createRelease, verifyRelease };
