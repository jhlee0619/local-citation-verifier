#!/usr/bin/env node
/*
 * citation-guard PreToolUse hook (Claude Code and Codex): human approvals stay
 * human. Denies
 *   - file edits of any references.allow (Claude Code Edit/Write/MultiEdit/
 *     NotebookEdit; Codex apply_patch, whose patch text is tool_input.command),
 *   - shell commands that run `lcv allow` (lcv, lcv.mjs, the npx package name),
 *   - shell commands that write references.allow: a redirection into it, or
 *     any command on it other than a known read-only one (cat, grep, git diff…).
 * Reads the hook JSON on stdin; prints a deny decision as JSON, or nothing.
 * A guardrail, not a sandbox: a determined script can still write the file.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_FILE = "references.allow";

export const DENY_REASON = "Approvals of references are human-only: agents must never edit references.allow or run lcv allow. " +
  "Replace or remove the reference instead (lcv resolve … --bibtex), and tell the user which entries need a human approval.";

const FILE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "exec_command", "local_shell"]);
const PATCH_TOOLS = new Set(["apply_patch"]);

const RUNS_ALLOW = /(?:^|[\s"'/\\;&|(`])(?:lcv(?:\.mjs)?|local-citation-verifier)["']?\s+allow\b/i;
const MENTIONS_ALLOWLIST = /references\.allow\b/i;
const REDIRECT_INTO_ALLOWLIST = /(?:^|[^<])(?:\d|&)?>{1,2}\|?\s*["']?[^\s"';|&<>]*references\.allow\b/i;
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$|^\*\*\* Move to:\s*(.+)$/gm;

// Programs that only read the file they are given.
const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "wc", "ls", "stat", "file", "diff", "cmp",
  "sha256sum", "sha1sum", "md5sum", "nl", "type", "get-content", "gc", "select-string", "sls", "test-path", "get-item",
  "get-childitem", "dir", "echo", "printf", "write-output", "realpath", "dirname", "basename",
]);
const GIT_READ_ONLY = new Set(["diff", "log", "show", "status", "blame", "ls-files", "grep", "check-ignore"]);
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "env", "xargs"]);
const LCV_WORD = /(?:^|[/\\])(?:lcv(?:\.mjs)?|local-citation-verifier)$/i;
const LCV_READERS = new Set(["check", "fix", "keys", "resolve"]);

const isAllowlistPath = value => typeof value === "string" &&
  value.replace(/\\/g, "/").replace(/["'\s]+$/, "").split("/").pop().toLowerCase() === ALLOWLIST_FILE;

// The shell segments of a command line (split on ; && || | & and newlines),
// each as its words, quotes removed.
const rawSegments = command => command.split(/\|\||&&|[;|&\n]/).map(part => part.trim()).filter(Boolean);
const wordsOf = segment => (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(word => word.replace(/^["']|["']$/g, ""));
const segments = command => rawSegments(command).map(wordsOf);

function programOf(words) {
  let index = 0;
  while (index < words.length && (/^\w+=/.test(words[index]) || WRAPPERS.has(words[index].toLowerCase()) || /^-/.test(words[index]))) index++;
  const program = (words[index] || "").replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "").toLowerCase();
  return { program, rest: words.slice(index + 1) };
}

// Why a shell command is denied, or "".
export function shellDenial(command) {
  const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  // `lcv allow` anywhere but as the argument of a read-only command (grep 'lcv allow' README.md).
  if (rawSegments(text).some(segment => RUNS_ALLOW.test(segment) && !READ_ONLY.has(programOf(wordsOf(segment)).program)))
    return "runs lcv allow";
  if (!MENTIONS_ALLOWLIST.test(text)) return "";
  if (REDIRECT_INTO_ALLOWLIST.test(text)) return "redirects output into references.allow";
  for (const words of segments(text)) {
    if (!words.some(word => MENTIONS_ALLOWLIST.test(word))) continue;
    const { program, rest } = programOf(words);
    if (program === "git" && GIT_READ_ONLY.has((rest.find(word => !word.startsWith("-")) || "").toLowerCase())) continue;
    // lcv check/fix/keys --allow references.allow only read the allowlist.
    const lcvAt = words.findIndex(word => LCV_WORD.test(word));
    if (lcvAt >= 0 && LCV_READERS.has((words[lcvAt + 1] || "").toLowerCase())) continue;
    if (READ_ONLY.has(program)) continue;
    return `${program || "a command"} may write references.allow`;
  }
  return "";
}

// Why a file edit is denied, or "".
export function pathDenial(toolInput) {
  const paths = [toolInput?.file_path, toolInput?.notebook_path, toolInput?.path, ...(toolInput?.edits || []).map(edit => edit?.file_path)];
  return paths.some(isAllowlistPath) ? "edits references.allow" : "";
}

// Codex apply_patch: the files named in the patch headers.
export function patchDenial(patch) {
  const text = String(patch ?? "");
  for (const match of text.matchAll(PATCH_FILE_LINE)) if (isAllowlistPath((match[1] || match[2]).trim())) return "patches references.allow";
  return "";
}

/** The hook input → { deny: true, reason } or { deny: false }. */
export function guardDecision(input) {
  const tool = String(input?.tool_name ?? "").toLowerCase();
  const toolInput = input?.tool_input ?? {};
  let why = "";
  if (FILE_TOOLS.has(tool)) why = pathDenial(toolInput);
  else if (PATCH_TOOLS.has(tool)) why = patchDenial(typeof toolInput === "string" ? toolInput : toolInput.command ?? toolInput.patch ?? toolInput.input);
  else if (SHELL_TOOLS.has(tool)) why = shellDenial(toolInput.command ?? toolInput.cmd);
  return why ? { deny: true, reason: `citation-guard: denied (${why}). ${DENY_REASON}` } : { deny: false };
}

export function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function run() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // unreadable input: no decision, the normal permission flow applies
  }
  const decision = guardDecision(input);
  if (decision.deny) process.stdout.write(`${JSON.stringify(denyOutput(decision.reason))}\n`);
}

// No top-level await, so tests can require() this module.
const isMain = import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase());
if (isMain) run();
