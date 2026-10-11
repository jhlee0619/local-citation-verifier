/*
 * lcv command dispatch, text and JSON output, exit codes:
 *   0 pass · 1 blocking findings · 2 usage error · 3 a network/lookup
 *   failure prevented a verdict.
 * main(argv, io) never exits the process; io replaces the process streams,
 * the network transport and the terminal for tests.
 */
import "./network.mjs"; // defines window.location before providers.js loads
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs, UsageError, USAGE } from "./args.mjs";
import { createCliFetch, createDiskCache, defaultCacheDir, installFetch } from "./network.mjs";
import { defaultAllowlistPath, entryFingerprint, parseAllowlist, upsertAllowlist } from "./allowlist.mjs";
import * as Check from "./check.mjs";
import { buildQuery, recordToBibtex, resolveWork, scoredSummary } from "./resolve.mjs";
import { compareKeys, keysExitCode } from "./keys.mjs";

const line = text => (text.endsWith("\n") ? text : `${text}\n`);

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${file} (${error.code || error.message})`);
  }
}

function readAllowlist(file) {
  if (!fs.existsSync(file)) return { exists: false, approvals: new Map(), malformed: 0 };
  return { exists: true, ...parseAllowlist(readText(file)) };
}

// The providers' network for one command: the disk cache (unless
// --no-cache), the /api/* mapping, and stats for the report.
function openNetwork(options, io) {
  const env = io.env || process.env;
  const stats = { requests: 0, cacheHits: 0, hosts: {} };
  const cache = options["no-cache"] ? null : createDiskCache({ dir: options["cache-dir"] || defaultCacheDir(env) });
  const restore = installFetch(createCliFetch({ transport: io.transport || globalThis.fetch, cache, env, stats }));
  return { stats, cache, restore };
}

// alerts: providers that served a bot challenge (providers.providerAlerts),
// each reported once.
function networkReport(network, started, alerts = []) {
  return {
    upstream_requests: network.stats.requests,
    cache_hits: network.stats.cacheHits,
    hosts: network.stats.hosts,
    cache_dir: network.cache?.dir || null,
    provider_alerts: alerts,
    runtime_ms: Date.now() - started,
  };
}

function networkText(report) {
  const lines = (report.provider_alerts || []).map(alert =>
    `note: ${alert.message}: ${alert.provider} was not asked again during this run; entries that needed it are Lookup failed (rerun later)`);
  return [...lines, `network: ${report.upstream_requests} upstream requests, ${report.cache_hits} cached answers, ${(report.runtime_ms / 1000).toFixed(1)} s`].join("\n");
}

function mergeAlerts(...lists) {
  const out = [];
  for (const alert of lists.flat()) if (!out.some(item => item.provider === alert.provider)) out.push(alert);
  return out;
}

function progressFor(io, err) {
  if (io.progress !== undefined) return io.progress;
  if (err !== process.stderr || !process.stderr.isTTY) return null;
  return text => process.stderr.write(`\r${text}\x1b[K`);
}

// ─── check ───────────────────────────────────────────────────────────
async function verifyFile(file, options, providers, progress) {
  const text = readText(file);
  const loaded = Check.loadBibliography(text);
  const allowPath = options.allow ? path.resolve(options.allow) : defaultAllowlistPath(file);
  const allow = readAllowlist(allowPath);
  const total = loaded.document.entries.length;
  let done = 0;
  const { run, poolFor } = await Check.verifyDocument(loaded.document, providers, {
    onResult: progress ? () => progress(`lcv: ${file} ${++done}/${total}`) : undefined,
  });
  const { items, projected } = Check.reportEntries({ file, document: loaded.document, run, poolFor, approvals: allow.approvals });
  const keys = new Set(loaded.document.entries.map(entry => entry.ID));
  return {
    text,
    loaded,
    run,
    projected,
    report: {
      file,
      format: loaded.format,
      converted: loaded.converted,
      allowlist: allow.exists ? allowPath : null,
      allowlist_malformed_lines: allow.malformed,
      unused_approvals: [...allow.approvals.keys()].filter(key => !keys.has(key)),
      entries: items,
    },
  };
}

function summaryOf(items) {
  return {
    entries: items.filter(item => item.status !== "invalid").length,
    invalid: items.filter(item => item.status === "invalid").length,
    by_status: Check.countByStatus(items),
    blocking: items.filter(item => item.blocking).length,
    blocking_network_only: items.filter(item => item.blocking && item.network_only).length,
    approved: items.filter(item => item.approval?.state === "approved").length,
  };
}

function fileHeader(file) {
  const converted = file.format === "bibtex" ? "" : ` (${file.format === "ris" ? "RIS" : "MEDLINE"}, ${file.converted} records converted to BibTeX)`;
  return `${file.file}${converted}: ${file.entries.length} entries — ${Check.countsText(file.entries)}`;
}

function checkText(report, verbose) {
  const lines = [];
  for (const file of report.files) {
    lines.push(fileHeader(file));
    const blocking = file.entries.filter(item => item.blocking);
    const passing = file.entries.filter(item => !item.blocking);
    if (blocking.length) {
      lines.push(report.strict ? `Blocking (${blocking.length}):` : `Would block with --strict (${blocking.length}):`);
      for (const item of blocking) lines.push(`  ${Check.itemLine(item)}`);
    }
    if (verbose && passing.length) {
      lines.push(`Passing (${passing.length}):`);
      for (const item of passing) lines.push(`  ${Check.itemLine(item)}`);
    } else {
      const noted = passing.filter(item => item.lint?.length || item.duplicate_of || item.notices?.length).length;
      if (noted) lines.push(`${noted} passing entries have lint notes or notices (see --verbose or --json).`);
    }
    for (const key of file.unused_approvals) lines.push(`note: the approval for "${key}" in ${file.allowlist} matches no entry`);
    if (file.allowlist_malformed_lines) lines.push(`note: ${file.allowlist_malformed_lines} malformed lines in ${file.allowlist} were ignored`);
  }
  const { summary } = report;
  const network = summary.blocking_network_only ? ` (${summary.blocking_network_only} only because a lookup failed: rerun)` : "";
  lines.push(report.strict
    ? `strict: ${summary.blocking} of ${summary.entries + summary.invalid} entries block${network} — exit ${report.exit_code}`
    : `report only (gate with --strict): ${summary.blocking} entries would block${network} — exit ${report.exit_code}`);
  lines.push(networkText(report.network));
  return lines.join("\n");
}

async function runCheck({ options, positionals }, io, out, err) {
  const started = Date.now();
  const strict = options.strict === true;
  const progress = progressFor(io, err);
  const network = openNetwork(options, io);
  const files = [];
  const providers = Check.createCliProviders();
  try {
    for (const file of positionals) files.push((await verifyFile(file, options, providers, progress)).report);
  } finally {
    network.restore();
    if (progress && !io.progress) process.stderr.write("\r\x1b[K");
  }
  const items = files.flatMap(file => file.entries);
  const exitCode = Check.exitCodeFor(items, { strict });
  const report = {
    schema: "lcv.check/1",
    command: "check",
    strict,
    exit_code: exitCode,
    summary: summaryOf(items),
    files,
    network: networkReport(network, started, providers.providerAlerts()),
  };
  out.write(line(options.json ? JSON.stringify(report) : checkText(report, options.verbose)));
  return exitCode;
}

// ─── fix ─────────────────────────────────────────────────────────────
const FIX_PASSES = 3;
async function runFix({ options, positionals }, io, out, err) {
  const started = Date.now();
  const file = positionals[0];
  const progress = progressFor(io, err);
  const network = openNetwork(options, io);
  let verified;
  let alerts = [];
  try {
    const head = Check.loadBibliography(readText(file));
    if (head.format !== "bibtex")
      throw new UsageError(`lcv fix rewrites BibTeX files only; ${file} is ${head.format === "ris" ? "RIS" : "MEDLINE"}`);
    const providers = Check.createCliProviders();
    verified = await verifyFile(file, options, providers, progress);
    alerts = providers.providerAlerts();
  } finally {
    network.restore();
    if (progress && !io.progress) process.stderr.write("\r\x1b[K");
  }
  let { text, loaded, run, projected, report } = verified;
  const original = text;
  let fixed = Check.fixedText(loaded.document, run, projected);
  const appliedNow = entries => entries.filter(item => item.status === "updated" && item.fix)
    .map(item => ({ key: item.key, kind: item.fix.kind, record: item.fix.record, changes: item.fix.changes }));
  const applied = appliedNow(report.entries);
  // One fix can enable another (e.g. a DOI added in pass 1 lets PubMed
  // supply the PMID in pass 2). When writing, repeat until nothing changes.
  const target = options["in-place"] ? file : options.output && options.output !== "-" ? options.output : null;
  for (let pass = 2; target && fixed !== text && pass <= FIX_PASSES; pass++) {
    fs.writeFileSync(target, fixed);
    const network = openNetwork(options, io);
    const providers = Check.createCliProviders();
    try {
      ({ text, loaded, run, projected, report } = await verifyFile(target, options, providers, progress));
    } finally {
      network.restore();
    }
    alerts = mergeAlerts(alerts, providers.providerAlerts());
    fixed = Check.fixedText(loaded.document, run, projected);
    applied.push(...appliedNow(report.entries));
  }
  text = original;
  const remaining = report.entries.filter(item => item.blocking && item.block.some(code => code !== "updated"));
  const exitCode = !remaining.length ? 0
    : remaining.every(item => item.block.filter(code => code !== "updated").every(code => code === "lookup_failed")) ? 3 : 1;

  let written = null;
  if (options["in-place"]) {
    if (fixed !== text) {
      fs.writeFileSync(file, fixed);
      written = file;
    }
  } else if (options.output === "-") {
    out.write(fixed);
    written = "-";
  } else if (options.output) {
    fs.writeFileSync(options.output, fixed);
    written = options.output;
  }
  const result = {
    schema: "lcv.fix/1",
    command: "fix",
    file,
    written,
    dry_run: !options["in-place"] && !options.output,
    changed: fixed !== text,
    applied,
    remaining,
    exit_code: exitCode,
    network: networkReport(network, started, alerts),
  };
  const stream = options.output === "-" ? err : out;
  if (options.json) {
    stream.write(line(JSON.stringify(result)));
    return exitCode;
  }
  const lines = [fileHeader(report)];
  lines.push(applied.length ? `Auto-updates (${applied.length}):` : "No system auto-update applies.");
  for (const item of applied)
    lines.push(`  ${item.key} — ${item.kind} record ${Check.recordRef(item.record)} — ${item.changes.map(change =>
      (change.from === null ? `+${change.field}` : change.to === null ? `-${change.field}` : `${change.field}: ${change.from} → ${change.to}`)).join("; ")}`);
  if (result.dry_run) lines.push(applied.length ? "Dry run: nothing written (use --in-place, -o <out> or -o -)." : "Nothing to write.");
  else if (written && written !== "-") lines.push(`Written: ${written}`);
  else if (!written) lines.push("Unchanged: nothing written.");
  if (remaining.length) {
    lines.push(`Still needs a human or agent decision (${remaining.length}):`);
    for (const item of remaining) lines.push(`  ${Check.itemLine(item)}`);
  }
  lines.push(`exit ${exitCode}`);
  lines.push(networkText(result.network));
  stream.write(line(lines.join("\n")));
  return exitCode;
}

// ─── resolve ─────────────────────────────────────────────────────────
function shortAuthors(authors) {
  const names = String(authors || "").split(/\s+and\s+/).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join("; ")} et al.` : names.join("; ");
}

const RESOLVE_SHOWN = 5;

function matchText(match) {
  if (match.confidence === "identifier") return `named by the ${match.identifiers.join("/").toUpperCase()}`;
  if (match.confidence === "same_work") return match.strong ? "strong match" : "same work";
  if (match.confidence === "title") return "same title (no author given to confirm it)";
  return `similar title (${match.title_similarity}), NOT confirmed as this work`;
}

function resolveText(result) {
  const lines = [];
  if (result.records.length) {
    lines.push("Authoritative records (best first):");
    for (const record of result.records.slice(0, RESOLVE_SHOWN)) {
      const serious = record.notices.filter(notice => notice.serious).map(notice => notice.type.toUpperCase().replace(/_/g, " "));
      lines.push(`  ${record.rank}. ${record.title}${serious.length ? `  [${serious.join(", ")}]` : ""}`);
      lines.push(`     ${shortAuthors(record.authors)} (${record.year || "n.d."})${record.venue ? ` · ${record.venue}` : ""} · @${record.type || "misc"}`);
      lines.push(`     ${Check.recordRef(record)} · ${matchText(record.match)}`);
    }
    if (result.records.length > RESOLVE_SHOWN) lines.push(`  … ${result.records.length - RESOLVE_SHOWN} more (--json lists all)`);
  } else lines.push("No authoritative record (Crossref, PubMed, arXiv, DBLP, OpenReview) was found.");
  if (result.discovery_only.length) {
    lines.push("Discovery only — not usable as a reference (Semantic Scholar):");
    for (const record of result.discovery_only.slice(0, RESOLVE_SHOWN)) lines.push(`  - ${record.title} (${record.year || "n.d."}) ${Check.recordRef(record)}`);
  }
  for (const warning of [...result.warnings, ...result.failures]) lines.push(`note: ${warning}`);
  if (result.confident) lines.push(`BibTeX of record ${result.picked}: add --bibtex (--key K for your citation key; --pick N for another record).`);
  else if (result.records.length) lines.push("No record is confirmed as this work: check the list, then pass --pick N with --bibtex, or refine the query (--doi, --author, --year).");
  return lines.join("\n");
}

async function runResolve({ options, positionals }, io, out, err) {
  const started = Date.now();
  const query = buildQuery(options, positionals);
  if (!query.title && !query.doi && !query.pmid && !query.pmcid && !query.arxiv)
    throw new UsageError("resolve could not read a title or an identifier from the input");
  const network = openNetwork(options, io);
  let found;
  try {
    found = await resolveWork(query, Check.createCliProviders());
  } finally {
    network.restore();
  }
  const pick = options.pick ? Number(options.pick) : 1;
  if (options.pick && found.records.length && pick > found.records.length)
    throw new UsageError(`--pick ${pick}: there ${found.records.length === 1 ? "is 1 authoritative record" : `are ${found.records.length} authoritative records`}`);
  const picked = found.records[pick - 1] || null;
  // Without --pick, only a record confirmed as the queried work is usable.
  const confident = !!picked && (options.pick !== undefined || picked.confidence !== "weak");
  const bibtex = options.bibtex && confident ? recordToBibtex(picked.record, options.key || "") : null;
  const exitCode = confident ? 0 : !found.records.length && found.failures.length ? 3 : 1;
  const result = {
    schema: "lcv.resolve/1",
    command: "resolve",
    query,
    records: found.records.map((item, index) => scoredSummary(item, index + 1)),
    discovery_only: found.discovery.map(item => ({ ...scoredSummary(item), note: "discovery only — not usable as a reference" })),
    picked: picked ? pick : null,
    confident,
    bibtex,
    warnings: found.warnings,
    failures: found.failures,
    exit_code: exitCode,
    network: networkReport(network, started),
  };
  if (options.json) {
    out.write(line(JSON.stringify(result)));
    return exitCode;
  }
  if (options.bibtex) {
    if (bibtex) {
      out.write(bibtex);
      const serious = result.records[pick - 1].notices.filter(notice => notice.serious);
      if (serious.length) err.write(line(`lcv: warning: this work has a ${serious.map(notice => notice.type).join(", ")} notice; lcv check --strict will block it`));
    } else err.write(line(resolveText(result)));
    return exitCode;
  }
  out.write(line(resolveText(result)));
  return exitCode;
}

// ─── keys ────────────────────────────────────────────────────────────
async function runKeys({ options, positionals }, io, out) {
  const [manuscript, ...bibFiles] = positionals;
  const text = readText(manuscript);
  const bibliographies = bibFiles.map(file => {
    const { document } = Check.loadBibliography(readText(file));
    return { file, entries: document.entries, invalid: document.items.filter(item => item.kind === "invalid").length };
  });
  const found = compareKeys(text, bibliographies);
  const strict = options.strict === true;
  const exitCode = keysExitCode(found, { strict });
  const result = {
    schema: "lcv.keys/1",
    command: "keys",
    manuscript,
    bibliographies: bibliographies.map(({ file, entries, invalid }) => ({ file, entries: entries.length, invalid })),
    strict,
    cited: found.cited.length,
    missing: found.missing,
    unparsable: found.unparsable,
    uncited: found.uncited,
    duplicates: found.duplicates,
    exit_code: exitCode,
  };
  if (options.json) {
    out.write(line(JSON.stringify(result)));
    return exitCode;
  }
  const lines = [`${manuscript}: ${found.cited.length} cited keys; ${bibliographies.reduce((sum, bib) => sum + bib.entries.length, 0)} entries in ${bibFiles.join(", ")}`];
  for (const bib of bibliographies)
    if (bib.invalid) lines.push(`note: ${bib.file} has ${bib.invalid} unparsable entries (their keys are unknown)`);
  if (found.missing.length) {
    lines.push(`Missing from the bibliography (${found.missing.length}, blocking):`);
    for (const item of found.missing)
      lines.push(`  ${item.key} — cited ${item.count}× (\\${item.command})${item.case_mismatch ? ` — only "${item.case_mismatch}" exists (case differs)` : ""} — "${item.sentence}"`);
  }
  if (found.unparsable.length) {
    lines.push(`Unparsable citation commands (${found.unparsable.length}${strict ? ", blocking" : ", blocking with --strict"}):`);
    for (const item of found.unparsable) lines.push(`  ${item.citation} — "${item.sentence}"`);
  }
  if (found.uncited.length) lines.push(`Uncited entries (${found.uncited.length}, information): ${found.uncited.join(", ")}`);
  for (const item of found.duplicates) lines.push(`note: "${item.key}" is defined in ${item.files.join(" and ")}`);
  lines.push(`exit ${exitCode}`);
  out.write(line(lines.join("\n")));
  return exitCode;
}

// ─── allow (human only) ──────────────────────────────────────────────
function ttyPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer);
  }));
}

async function runAllow({ options, positionals }, io, out, err) {
  const interactive = io.interactive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (!interactive) {
    err.write(line("lcv allow records a HUMAN approval and needs an interactive terminal. " +
      "Coding agents must not approve references: ask a human to run lcv allow."));
    return 2;
  }
  const [key] = positionals;
  const file = options.file;
  const matches = Check.loadBibliography(readText(file)).document.entries.filter(entry => entry.ID === key);
  if (!matches.length) throw new UsageError(`no entry "${key}" in ${file}`);
  if (matches.length > 1) throw new UsageError(`${file} has ${matches.length} entries with the key "${key}"`);
  const entry = matches[0];
  const fingerprint = entryFingerprint(entry);
  const allowPath = options.allow ? path.resolve(options.allow) : defaultAllowlistPath(file);
  const reason = String(options.reason).trim();
  err.write(line([
    `Approve @${entry.ENTRYTYPE}{${key}} as a reference outside database coverage:`,
    `  ${entry.title || "(no title)"} — ${entry.author || "(no author)"} (${entry.year || "n.d."})`,
    `  reason: ${reason}`,
    `  fingerprint ${fingerprint} → ${allowPath}`,
    "Any later edit of the entry's type, title, authors, year, venue or identifiers invalidates the approval.",
  ].join("\n")));
  const answer = await (io.prompt || ttyPrompt)(`Type the key "${key}" to approve: `);
  if (String(answer).trim() !== key) {
    err.write(line("Not approved."));
    return 2;
  }
  const date = new Date().toISOString().slice(0, 10);
  const current = fs.existsSync(allowPath) ? readText(allowPath) : "";
  fs.writeFileSync(allowPath, upsertAllowlist(current, { key, fingerprint, reason, date }));
  const result = { schema: "lcv.allow/1", command: "allow", key, fingerprint, allowlist: allowPath, reason, date, exit_code: 0 };
  out.write(line(options.json ? JSON.stringify(result) : `Approved ${key} (${fingerprint}) in ${allowPath}`));
  return 0;
}

// ─── dispatch ────────────────────────────────────────────────────────
const RUNNERS = { check: runCheck, fix: runFix, resolve: runResolve, keys: runKeys, allow: runAllow };

export async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const parsed = parseArgs(argv);
    if (parsed.options.help) {
      out.write(USAGE);
      return 0;
    }
    return await RUNNERS[parsed.command](parsed, io, out, err);
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(line(`lcv: ${error.message}\nRun "lcv --help" for usage.`));
      return 2;
    }
    err.write(line(`lcv: internal error: ${error?.stack || error}`));
    return 2;
  }
}
