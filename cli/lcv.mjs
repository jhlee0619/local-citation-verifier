#!/usr/bin/env node
/*
 * lcv — the Local Citation Verifier on the command line (cli/README.md).
 *
 * docs/ modules import each other with the page's cache-busting "?v=BUILD"
 * query. This resolve hook strips it from docs/ URLs so Node, like the
 * browser, loads each module exactly once; then the CLI loads.
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (typeof registerHooks !== "function") {
  process.stderr.write("lcv needs Node.js >= 22.15 (module.registerHooks)\n");
  process.exit(2);
}

const DOCS_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs") + path.sep).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith(DOCS_URL)) return result;
    const url = new URL(result.url);
    if (!url.search) return result;
    url.search = "";
    return { ...result, url: url.href };
  },
});

const { main } = await import("./lib/main.mjs");
process.exitCode = await main(process.argv.slice(2));
