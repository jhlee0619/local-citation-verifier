/*
 * lcv's command line: commands, their options and the usage text.
 * parseArgs throws UsageError (exit code 2) for anything it does not know.
 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const COMMON = Object.freeze({ json: "boolean", "no-cache": "boolean", "cache-dir": "string", verbose: "boolean", help: "boolean" });
const ALIASES = Object.freeze({ h: "help", o: "output", v: "verbose" });

export const COMMANDS = Object.freeze({
  check: { options: { strict: "boolean", allow: "string" }, min: 1, max: Infinity },
  fix: { options: { output: "string", "in-place": "boolean", allow: "string" }, min: 1, max: 1 },
  resolve: {
    options: {
      doi: "string", pmid: "string", pmcid: "string", arxiv: "string", title: "string", author: "string",
      year: "string", pick: "string", bibtex: "boolean", key: "string",
    },
    min: 0,
    max: Infinity,
  },
  keys: { options: { strict: "boolean" }, min: 2, max: Infinity },
  allow: { options: { file: "string", reason: "string", allow: "string" }, min: 1, max: 1 },
});

export const USAGE = `lcv — verify and resolve bibliography references (same pipeline as the web app)

Usage:
  lcv check <file>... [--strict] [--allow <path>]      verify .bib / .ris / .nbib files
  lcv fix <file.bib> [-o <out> | -o - | --in-place]      apply only the system auto-updates
  lcv resolve [<free text>] [--doi X] [--pmid X] [--pmcid X] [--arxiv X]
              [--title T --author A --year Y] [--pick N] [--bibtex] [--key K]
                                                         find authoritative records for a work
  lcv keys <manuscript> <refs.bib>... [--strict]         cited keys vs. bibliography keys
  lcv allow <key> --file <refs.bib> --reason "<text>" [--allow <path>]
                                                         HUMAN ONLY: approve an entry outside database coverage

Options for every command:
  --json            machine-readable output (schema: cli/README.md)
  --no-cache        do not read or write the disk cache
  --cache-dir <d>   disk cache directory (default ~/.cache/lcv, or $LCV_CACHE_DIR)
  -v, --verbose     also list passing entries and their notes
  -h, --help        this text

Exit codes: 0 pass, 1 blocking findings, 2 usage error, 3 network/lookup failure prevented a verdict.
`;

// argv (without node and the script) → { command, options, positionals }.
export function parseArgs(argv) {
  const args = [...argv];
  if (!args.length || args[0] === "-h" || args[0] === "--help" || args[0] === "help")
    return { command: "help", options: { help: true }, positionals: [] };
  const command = args.shift();
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command "${command}"`);
  const types = { ...COMMON, ...spec.options };
  const options = {};
  const positionals = [];
  let onlyPositionals = false;
  while (args.length) {
    const arg = args.shift();
    if (onlyPositionals || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }
    let name;
    let value;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else {
      name = ALIASES[arg.slice(1)];
      if (!name) throw new UsageError(`unknown option "${arg}" for ${command}`);
    }
    const type = types[name];
    if (!type) throw new UsageError(`unknown option "--${name}" for ${command}`);
    if (type === "boolean") {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`);
      options[name] = true;
      continue;
    }
    if (value === undefined) {
      if (!args.length) throw new UsageError(`--${name} needs a value`);
      value = args.shift();
    }
    if (name in options) throw new UsageError(`--${name} given twice`);
    options[name] = value;
  }
  if (options.help) return { command, options, positionals };
  if (positionals.length < spec.min)
    throw new UsageError(`${command} needs ${spec.min === 1 ? "a file" : `at least ${spec.min} arguments`}`);
  if (positionals.length > spec.max) throw new UsageError(`${command} takes ${spec.max} argument${spec.max === 1 ? "" : "s"}`);
  if (command === "fix" && options.output !== undefined && options["in-place"])
    throw new UsageError("fix takes either -o <out> or --in-place, not both");
  if (command === "resolve") {
    if (!positionals.length && !["doi", "pmid", "pmcid", "arxiv", "title"].some(key => options[key]))
      throw new UsageError("resolve needs free text, --doi, --pmid, --pmcid, --arxiv or --title");
    if (options.pick !== undefined && !/^[1-9]\d*$/.test(options.pick)) throw new UsageError("--pick must be a positive number");
    if (options.key !== undefined && !/^[^\s{}(),=\\#%"'~]+$/.test(options.key)) throw new UsageError("--key is not a valid BibTeX key");
  }
  if (command === "allow") {
    if (!options.file) throw new UsageError("allow needs --file <refs.bib>");
    if (!String(options.reason || "").trim()) throw new UsageError("allow needs --reason \"<text>\"");
  }
  return { command, options, positionals };
}
