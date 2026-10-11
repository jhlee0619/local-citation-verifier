#!/usr/bin/env node
/*
 * citation-guard Stop hook (Claude Code and Codex). Reads the hook JSON on
 * stdin and always prints one JSON object:
 *   {}                                     nothing to check, or everything passes
 *   {"decision":"block","reason":"…"}      changed references fail: keep working
 *   {"systemMessage":"…"}                  let the turn end, but tell the user
 *
 * Fast path (no network): only when the git working tree has changed or new
 * .bib/.ris/.nbib files, or changed .tex/.md files with \cite commands, does it
 * run `lcv check --strict` on those bibliographies and `lcv keys` for those
 * manuscripts (against their \bibliography{}/\addbibresource{} files, else
 * every .bib in the repository), in-process, within LCV_HOOK_TIMEOUT seconds
 * (default 180).
 *
 * Loop guard (state in <git dir>/lcv-hook-state.json): when the hook already
 * continued the turn (stop_hook_active) and the failing set is unchanged after
 * MAX_BLOCKS blocks, the stop is allowed with a systemMessage listing what is
 * still unverified. Failed lookups and timeouts block once, then warn.
 * LCV_HOOK=off disables the hook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_BLOCKS = 3;
export const DEFAULT_TIMEOUT_S = 180;
export const STATE_FILE = "lcv-hook-state.json";
const MAX_LINES = 15;
const MAX_REASON = 6000;

const BIBLIOGRAPHY = /\.(?:bib|ris|nbib)$/i;
const MANUSCRIPT = /\.(?:tex|ltx|md|markdown|qmd|rmd)$/i;
// A citation command with a key list: \cite{…}, \citep[p.~3]{…}, \parencite*{…}, \cites{…}{…}
const CITATION = /\\[A-Za-z]*cite[A-Za-z]*\*?\s*(?:\[[^\]\n]*\]\s*)*\{/;
const BIB_COMMAND = /\\(?:bibliography|addbibresource|addglobalbib|addsectionbib)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

export const hookDisabled = env => /^(?:off|0|false|no|disabled?)$/i.test(String(env?.LCV_HOOK ?? "").trim());

export function timeoutMs(env) {
  const seconds = Number(env?.LCV_HOOK_TIMEOUT);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_S) * 1000;
}

// LaTeX % comments are skipped in .tex files only (in Markdown, % is text).
export const citesIn = (text, file = "") => CITATION.test(/\.(?:tex|ltx)$/i.test(file)
  ? String(text ?? "").replace(/(^|[^\\])%.*$/gm, "$1") : String(text ?? ""));

// The bibliography files a manuscript names (\bibliography{a,b}, \addbibresource{x.bib}),
// resolved against its directory, then the repository root.
export function bibliographiesOf(text, manuscript, root) {
  const found = [];
  for (const match of String(text ?? "").matchAll(BIB_COMMAND))
    for (const name of match[1].split(",").map(part => part.trim()).filter(Boolean)) {
      const file = /\.(?:bib|ris|nbib)$/i.test(name) ? name : `${name}.bib`;
      found.push([path.resolve(path.dirname(manuscript), file), path.resolve(root, file)]);
    }
  return found;
}

const sameSet = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

function clip(lines) {
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`… and ${lines.length - MAX_LINES} more (run lcv check --strict / lcv keys for the full list)`);
  const text = shown.map(line => `- ${line}`).join("\n");
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

/**
 * The decision for one Stop event. deps (all injectable for tests):
 *   env, cwd
 *   changes(cwd)          → null (not a git repository) | { root, gitDir, files: [absolute path] }
 *   readText(file)        → string
 *   allBibliographies(root) → [absolute path of every .bib in the repository]
 *   exists(file)          → boolean
 *   check(files, ms)      → lcv.check/1 report, or { timedOut: true } | { error }
 *   keys(manuscript, bibs) → lcv.keys/1 report, or { error }
 *   loadState(gitDir) / saveState(gitDir, state)
 * Returns the JSON object to print.
 */
export async function decideStop(input, deps) {
  const env = deps.env || {};
  if (hookDisabled(env)) return {};
  const cwd = input?.cwd || deps.cwd;
  const repo = deps.changes(cwd);
  if (!repo) return {};
  const rel = file => path.relative(repo.root, file).replace(/\\/g, "/");
  const bibliographies = repo.files.filter(file => BIBLIOGRAPHY.test(file));
  const manuscripts = repo.files.filter(file => MANUSCRIPT.test(file)).map(file => ({ file, text: deps.readText(file) }))
    .filter(item => citesIn(item.text, item.file));
  const sessionState = () => {
    const state = deps.loadState(repo.gitDir);
    return state && state.session_id === (input?.session_id ?? null) ? state : null;
  };
  if (!bibliographies.length && !manuscripts.length) {
    if (sessionState()) deps.saveState(repo.gitDir, null);
    return {};
  }

  const findings = []; // { id, line, network }
  const warnings = [];
  if (bibliographies.length) {
    const report = await deps.check(bibliographies, timeoutMs(env));
    if (report?.timedOut) findings.push({ id: "timeout", line: `lcv check did not finish within ${timeoutMs(env) / 1000} s — run lcv check --strict ${bibliographies.map(rel).join(" ")} yourself (it warms the cache)`, network: true });
    else if (report?.error || !report?.files) warnings.push(`lcv check failed (${report?.error || "no report"})`);
    else
      for (const file of report.files)
        for (const entry of file.entries.filter(item => item.blocking))
          findings.push({
            id: `${rel(path.resolve(file.file))}|${entry.key}|${entry.block.join(",")}`,
            line: `${entry.key || "(no key)"} — ${entry.status} — ${entry.action}${bibliographies.length > 1 ? ` [${rel(path.resolve(file.file))}]` : ""}`,
            network: !!entry.network_only,
          });
  }
  for (const { file, text } of manuscripts) {
    const named = bibliographiesOf(text, file, repo.root).map(choices => choices.find(deps.exists)).filter(Boolean);
    const bibs = named.length ? [...new Set(named)] : deps.allBibliographies(repo.root);
    const report = await deps.keys(file, bibs);
    if (report?.error || !report?.missing) {
      warnings.push(`lcv keys failed for ${rel(file)} (${report?.error || "no report"})`);
      continue;
    }
    for (const item of report.missing)
      findings.push({
        id: `${rel(file)}|${item.key}|missing_key`,
        line: `${item.key} — cited in ${rel(file)} but missing from ${bibs.length ? bibs.map(rel).join(", ") : "every bibliography (none found)"}${item.case_mismatch ? ` (only "${item.case_mismatch}" exists)` : ""} — add the entry with lcv resolve … --bibtex, or correct the key`,
        network: false,
      });
  }

  const warning = warnings.length ? `citation-guard: ${warnings.join("; ")}` : "";
  if (!findings.length) {
    deps.saveState(repo.gitDir, null);
    return warning ? { systemMessage: warning } : {};
  }
  const signature = findings.map(item => item.id).sort();
  const kind = findings.every(item => item.network) ? "network" : "findings";
  const previous = sessionState();
  const repeated = input?.stop_hook_active === true && previous?.kind === kind && sameSet(previous.signature, signature);
  const count = repeated ? previous.count : 0;
  const lines = findings.map(item => item.line);
  const limit = kind === "network" ? 1 : MAX_BLOCKS;
  if (count >= limit) {
    deps.saveState(repo.gitDir, null);
    const why = kind === "network" ? "the reference lookups failed, so these are NOT verified" : `still unverified after ${count} attempts`;
    return { systemMessage: `citation-guard: ${why}. A human must decide (fix, remove, or approve with lcv allow):\n${clip(lines)}${warning ? `\n${warning}` : ""}` };
  }
  deps.saveState(repo.gitDir, { session_id: input?.session_id ?? null, kind, signature, count: count + 1 });
  const head = kind === "network"
    ? "citation-guard: the reference lookups failed, so the changed references are not verified yet. Rerun the checks before finishing:"
    : `citation-guard: ${findings.length} reference problem${findings.length === 1 ? "" : "s"} must be fixed before finishing (KEY — status — action):`;
  return { decision: "block", reason: `${head}\n${clip(lines)}\nFollow the citation-guard skill: obtain references only with lcv resolve, apply lcv fix for updates, remove what cannot be verified and tell the user; never edit references.allow.` };
}

// ─── Real dependencies ───────────────────────────────────────────────
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
}

// Changed (staged, unstaged) and untracked files of the working tree, as
// absolute paths of files that exist.
export function parsePorcelainZ(output, root) {
  const parts = String(output).split("\0");
  const files = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    if (status[0] === "R" || status[0] === "C") index++; // the source path follows
    if (status === "!!") continue;
    files.push(path.resolve(root, part.slice(3)));
  }
  return files;
}

function gitChanges(cwd) {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
    const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]).trim();
    const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return { root, gitDir, files: parsePorcelainZ(status, root).filter(file => fs.existsSync(file)) };
  } catch {
    return null;
  }
}

function allBibliographies(root) {
  try {
    return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.bib"]).split("\0")
      .filter(Boolean).map(file => path.resolve(root, file)).filter(file => fs.existsSync(file));
  } catch {
    return [];
  }
}

let mainPromise = null;
// lcv's main(), loaded the way cli/lcv.mjs loads it (docs/ imports without "?v=").
function loadMain() {
  mainPromise ??= (async () => {
    const { registerHooks } = await import("node:module");
    const docs = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs") + path.sep).href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if (!result.url.startsWith(docs) || !new URL(result.url).search) return result;
        const url = new URL(result.url);
        url.search = "";
        return { ...result, url: url.href };
      },
    });
    return (await import("../lib/main.mjs")).main;
  })();
  return mainPromise;
}

async function runLcv(argv) {
  const main = await loadMain();
  const chunks = [];
  const sink = { write: text => { chunks.push(String(text)); return true; } };
  const code = await main([...argv, "--json"], { stdout: sink, stderr: { write: () => true }, progress: null, interactive: false });
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    return { error: `lcv ${argv[0]} exited ${code} without a report` };
  }
}

export function realDeps(env = process.env) {
  return {
    env,
    cwd: process.cwd(),
    changes: gitChanges,
    readText: file => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } },
    allBibliographies,
    exists: file => fs.existsSync(file),
    check: (files, ms) => {
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
      return Promise.race([runLcv(["check", ...files, "--strict"]), timeout]).finally(() => clearTimeout(timer));
    },
    keys: (manuscript, bibs) => runLcv(["keys", manuscript, ...bibs]),
    loadState: gitDir => { try { return JSON.parse(fs.readFileSync(path.join(gitDir, STATE_FILE), "utf8")); } catch { return null; } },
    saveState: (gitDir, state) => {
      const file = path.join(gitDir, STATE_FILE);
      try {
        if (state) fs.writeFileSync(file, JSON.stringify(state));
        else fs.rmSync(file, { force: true });
      } catch { /* best effort */ }
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function run() {
  let output = {};
  try {
    const raw = await readStdin();
    output = await decideStop(raw.trim() ? JSON.parse(raw) : {}, realDeps());
  } catch (error) {
    output = { systemMessage: `citation-guard: the Stop hook failed (${error?.message || error}); references were not checked` };
  }
  // Exit once the output is flushed: a timed-out check may still hold the event loop.
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

// No top-level await, so tests can require() this module.
const isMain = import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase());
if (isMain) run();
