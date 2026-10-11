/*
 * lcv keys: the manuscript's citation keys against the bibliography keys,
 * with the citation scanner of the citation audit (core/audit.js
 * extractCitations): \cite, \citep, \citet, \parencite, \textcite,
 * \autocite, \footcite, \citeA, the multi-cite forms and their starred and
 * capitalised variants. Naming commands (\citeauthor, \citeyear, \nocite,
 * ...) are parsed by the scanner but not reported, so they are not checked.
 */
import "./network.mjs"; // defines window.location before audit.js loads providers.js
import { extractCitations } from "../../docs/core/audit.js";

const snippet = text => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}…` : flat;
};

/**
 * manuscript: its text; bibliographies: [{ file, entries }]. Returns
 * { cited, missing, uncited, unparsable, duplicates }:
 *   missing     cited keys no bibliography has (blocking), with the first
 *               citing sentence, the number of citations and a key that
 *               differs only in case, if any
 *   uncited     bibliography keys the manuscript never cites (information)
 *   unparsable  citation commands without a readable key list (blocking
 *               with --strict)
 *   duplicates  keys defined in more than one file (information)
 */
export function compareKeys(manuscript, bibliographies) {
  const { contexts, skipped } = extractCitations(manuscript);
  const defined = new Map();
  for (const { file, entries } of bibliographies)
    for (const entry of entries) {
      const key = String(entry.ID || "");
      if (!key) continue;
      if (!defined.has(key)) defined.set(key, []);
      if (!defined.get(key).includes(file)) defined.get(key).push(file);
    }
  const byLower = new Map([...defined.keys()].map(key => [key.toLowerCase(), key]));
  const cited = new Map();
  for (const context of contexts) {
    const known = cited.get(context.key);
    if (known) known.count++;
    else cited.set(context.key, { key: context.key, count: 1, command: context.command, sentence: snippet(context.sentence) });
  }
  const missing = [...cited.values()].filter(item => !defined.has(item.key)).map(item => {
    const near = byLower.get(item.key.toLowerCase());
    return near ? { ...item, case_mismatch: near } : item;
  });
  return {
    cited: [...cited.keys()],
    missing,
    uncited: [...defined.keys()].filter(key => !cited.has(key)),
    unparsable: skipped.map(item => ({ citation: item.citation, key: item.key || "", sentence: snippet(item.sentence) })),
    duplicates: [...defined].filter(([, files]) => files.length > 1).map(([key, files]) => ({ key, files })),
  };
}

export function keysExitCode(result, { strict = false } = {}) {
  return result.missing.length || (strict && result.unparsable.length) ? 1 : 0;
}
