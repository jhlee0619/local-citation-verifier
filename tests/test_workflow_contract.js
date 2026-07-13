"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

function workflow(name) {
  return read(path.join(".github", "workflows", name));
}

function assertPinnedActions(contents, name) {
  const actionRefs = [...contents.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)];
  assert(actionRefs.length > 0, `${name} must use at least one action or reusable workflow`);
  for (const [, action, ref] of actionRefs) {
    if (action.startsWith("./")) continue;
    assert.match(ref, /^[0-9a-f]{40}$/, `${name}: ${action} is not pinned to a commit`);
  }
}

function jobBody(contents, jobName, nextJobName) {
  const start = contents.indexOf(`  ${jobName}:`);
  assert(start >= 0, `missing ${jobName} job`);
  const end = nextJobName ? contents.indexOf(`  ${nextJobName}:`, start + 1) : contents.length;
  assert(end > start, `cannot isolate ${jobName} job`);
  return contents.slice(start, end);
}

function testQualityWorkflow() {
  const quality = workflow("quality.yml");
  assert.match(quality, /workflow_call:/);
  assert.match(quality, /source_sha:/);
  assert.match(quality, /produce_pages_artifact:/);
  assert.match(quality, /node-version:\s*\[18, 20, 22\]/);
  assert.match(quality, /python-version:\s*["']3\.12["']/);
  assert.match(quality, /npm run test:browser/);
  assert.match(quality, /playwright install --with-deps chromium/);
  assert.match(quality, /needs:\s*\[preflight, node, python, browser\]/);
  assert.match(quality, /actions\/upload-artifact@/);
  assert.match(quality, /artifact\.tar/);
  assert.doesNotMatch(quality, /upload-pages-artifact/);
  assert.match(quality, /pages_artifact_name=github-pages-\$SOURCE_SHA/);
  assert.match(quality, /release-manifest\.js create/);
  assert.match(quality, /release-manifest\.js verify/);
  assert.match(quality, /awk '\$1 == "120000"/);
  assert.match(quality, /steps\.pages\.outputs\.artifact-id/);
  const checkoutCount = (quality.match(/actions\/checkout@/g) || []).length;
  const noCredentialCount = (quality.match(/persist-credentials:\s*false/g) || []).length;
  assert.strictEqual(noCredentialCount, checkoutCount, "every quality checkout must drop credentials");
  assertPinnedActions(quality, "quality.yml");
}

function testCiUsesOnlyTheSharedGate() {
  const ci = workflow("ci.yml");
  assert.match(ci, /branches:\s*\[main\]/);
  assert.doesNotMatch(ci, /gh-pages/);
  assert.match(ci, /uses:\s*\.\/\.github\/workflows\/quality\.yml/);
  assert.match(ci, /source_sha:\s*\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(ci, /npm (ci|run)/);
}

function testDeployReusesVerifiedArtifact() {
  const deploy = workflow("deploy.yml");
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /deploy_sha:/);
  assert.doesNotMatch(deploy, /rollback_sha:/);
  assert.match(deploy, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(deploy, /merge-base --is-ancestor/);
  assert.match(deploy, /build_type/);
  assert.match(deploy, /workflow publishing/i);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/quality\.yml/);
  assert.match(deploy, /produce_pages_artifact:\s*true/);
  assert.match(deploy, /needs:\s*\[resolve, quality, verify_artifact\]/);
  assert.match(deploy, /actions\/deploy-pages@/);
  assert.match(deploy, /post-deploy-smoke\.js/);
  assert.match(deploy, /--artifact-name.*--artifact-id/s);
  assert.match(deploy, /cancel-in-progress:\s*false/);

  const verify = jobBody(deploy, "verify_artifact", "deploy");
  const deployJob = jobBody(deploy, "deploy", "smoke");
  const smokeJob = jobBody(deploy, "smoke");
  assert.doesNotMatch(verify, /actions\/checkout@/);
  assert.doesNotMatch(deployJob, /actions\/checkout@/);
  assert.doesNotMatch(deployJob, /download-artifact|npm ci|post-deploy-smoke/);
  assert.doesNotMatch(deployJob, /upload-pages-artifact/);
  assert.doesNotMatch(smokeJob, /pages:\s*write|id-token:\s*write/);
  assert.match(smokeJob, /needs:\s*\[resolve, quality, deploy\]/);
  assertPinnedActions(deploy, "deploy.yml");
}

function testStaticAndOperationalContracts() {
  const app = read("docs/app.js");
  const operations = read("docs/operations.md");
  const readme = read("README.md");
  assert.match(app, /if\s*\(USE_METADATA_PROXY\)\s*\{\s*detectVllmServer\(\);\s*\}/s);
  assert.match(operations, /deploy_sha/);
  assert.match(operations, /full 40-character lowercase commit SHA/i);
  assert.match(operations, /public smoke/i);
  assert.match(operations, /build_type.*workflow/is);
  assert.match(operations, /legacy.*disabled/is);
  assert.match(readme, /npm run test:browser/);
  assert.match(readme, /tests\/manual\/browser_live_run\.js/);
  assert.match(readme, /six-minute|6-minute/i);
}

testQualityWorkflow();
testCiUsesOnlyTheSharedGate();
testDeployReusesVerifiedArtifact();
testStaticAndOperationalContracts();
console.log("workflow contract tests: OK");
