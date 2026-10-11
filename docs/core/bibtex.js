/*
 * BibTeX: one tokenizer-driven reader for parsing and validation, and a
 * writer that emits untouched entries byte-for-byte. DOM-free.
 *
 * parseBibDocument(text) → { items, entries, strings, errors, eol }
 *   items    every top-level piece in source order: { kind, span: [start, end], raw }
 *            with kind "entry" { type, key, index, fields, comments },
 *            "string" { fields }, "preamble" { value }, "comment", "invalid"
 *            { type, key, error } or "text" (anything between).
 *            Each field is { name, value, text, raw, span, literal }: the
 *            lower-case name, the expanded value (whitespace-normalised), the
 *            expansion as read (what @string stores), the value expression's
 *            source and span, and whether that expression is one {…}, "…" or
 *            number literal.
 *   entries  plain objects (ENTRYTYPE, ID, field → expanded value) for
 *            verification; entries[i] is the item with index i. @string
 *            macros, month macros and # are resolved; of duplicate fields the
 *            first wins (as in BibTeX). _bibIssues lists duplicate-field and
 *            duplicate-key integrity issues and non-blocking undefined_macro
 *            warnings (records.entryIntegrityIssues).
 *   strings  user @string macros by lower-case name
 *   errors   [{ offset, line, column, reason, message, key }], one per invalid
 *            item. A malformed entry (or @string/@preamble/@comment) never
 *            empties the document: its source, up to the next line-start "@",
 *            is an "invalid" item that is not verified and is written back
 *            verbatim; parsing resumes at that "@".
 *   eol      the dominant line ending ("\r\n", "\n" or a lone "\r"), used for
 *            re-serialised entries
 * Inside an entry, "%" to the end of the line is a comment wherever
 * whitespace may stand (between fields, around "=" and "#", after the key),
 * as biber and Overleaf treat it; between entries, a "%" line never opens an
 * entry, even when it contains "@".
 * parseBib(text) is the lenient reader (provider snippets, citation audit):
 * it keeps what it can read of a malformed entry and resynchronises after it.
 */
import { decodeHtmlEntities, matchingBrace, unicodeToLatex } from "./text.js?v=20261012-s15";

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  const MONTH_MACROS = MONTHS.map(month => [month.slice(0, 3).toLowerCase(), month]);
  const HEAD = /@([A-Za-z][\w-]*)\s*([{(])/y;
  const NAME = /[^\s"#%'(),={}]+/y;
  const LINE_START_AT = /[\r\n][ \t]*@[A-Za-z]/g;
  // Recovery only (a typo such as `{{GitHub},` left the entry unterminated):
  // a top-level ", name =" inside a braced value ends that value.
  const RECOVER_FIELD = /^\s*[A-Za-z][\w-]*\s*=/;

  // Offsets where a line starts (after "\r\n", "\n" or a lone "\r").
  function lineStarts(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 13 && src.charCodeAt(i + 1) === 10) i++;
      if (ch === 10 || ch === 13) starts.push(i + 1);
    }
    return starts;
  }

  function dominantEol(src) {
    let crlf = 0, lf = 0, cr = 0;
    for (let i = 0; i < src.length; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 13 && src.charCodeAt(i + 1) === 10) { crlf++; i++; }
      else if (ch === 13) cr++;
      else if (ch === 10) lf++;
    }
    return cr > crlf && cr > lf ? "\r" : crlf > lf ? "\r\n" : "\n";
  }

  // lenient: keep what can be read of a malformed entry (parseBib) instead of
  // an invalid item (parseBibDocument).
  function readSource(text, lenient) {
    const src = typeof text === "string" ? text : String(text ?? "");
    const items = [];
    const entries = [];
    const errors = [];
    const strings = {};
    const macros = new Map(MONTH_MACROS);
    let pos = 0;
    let textStart = 0;

    const skipSpace = i => {
      while (i < src.length && /\s/.test(src[i])) i++;
      return i;
    };
    // Whitespace and "%" comments to the end of the line; `comments` collects
    // the comment lines (kept when the entry is re-serialised).
    const skipGap = (i, comments) => {
      for (;;) {
        i = skipSpace(i);
        if (src[i] !== "%") return i;
        const start = i;
        while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
        comments?.push(src.slice(start, i).trimEnd());
      }
    };
    const keys = new Map();
    const fail = (offset, reason, message, extra) => ({ error: { offset, reason, message }, ...extra });
    let starts = null;
    const lineColumn = offset => {
      starts ??= lineStarts(src);
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: offset - starts[lo] + 1 };
    };
    // The first line-start "@" after `from` (Infinity when none); the last
    // answer is reused while `from` stays before it.
    let searchedFrom = -1;
    let foundAt = -1;
    const nextLineStartAt = from => {
      if (searchedFrom < 0 || from < searchedFrom || from >= foundAt) {
        LINE_START_AT.lastIndex = from;
        const match = LINE_START_AT.exec(src);
        searchedFrom = from;
        foundAt = match ? match.index + match[0].indexOf("@") : Infinity;
      }
      return foundAt;
    };
    // Whether the "@" at `at` stands in a "%" comment of the text between
    // entries; [line start, cleanTo) is known to hold no "%".
    let cleanTo = 0;
    const inComment = at => {
      for (let i = at - 1; i >= textStart && i >= cleanTo; i--) {
        if (src[i] === "\n" || src[i] === "\r") break;
        if (src[i] === "%") return true;
      }
      cleanTo = at;
      return false;
    };

    // After the first value that runs to the end of the file, prefix brace
    // depths tell at once whether a brace ever closes, so a file of unclosed
    // values stays linear. lastUnclosed is the innermost brace open at the end.
    let depthAt = null;
    let minDepthFrom = null;
    let lastUnclosed = -1;
    function indexUnclosed() {
      const n = src.length;
      depthAt = new Int32Array(n + 1);
      for (let x = 0; x < n; x++) depthAt[x + 1] = depthAt[x] + (src[x] === "{" ? 1 : src[x] === "}" ? -1 : 0);
      minDepthFrom = new Int32Array(n + 1);
      minDepthFrom[n] = depthAt[n];
      for (let x = n - 1; x >= 0; x--) minDepthFrom[x] = Math.min(depthAt[x], minDepthFrom[x + 1]);
      for (let x = n - 1; x >= 0 && lastUnclosed < 0; x--)
        if (src[x] === "{" && minDepthFrom[x + 1] > depthAt[x]) lastUnclosed = x;
    }

    function readBraced(i, recover) {
      if (!recover && depthAt && minDepthFrom[i + 1] > depthAt[i])
        return fail(lastUnclosed, "unterminated_brace", "This brace is never closed.", { eof: true });
      const open = [i];
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "{") open.push(j);
        else if (src[j] === "}") {
          open.pop();
          if (!open.length) return { text: src.slice(i + 1, j), end: j + 1 };
        } else if (recover && src[j] === "," && open.length === 1 && RECOVER_FIELD.test(src.slice(j + 1, j + 200))) {
          const inner = src.slice(i + 1, j);
          const missing = (inner.match(/\{/g) || []).length - (inner.match(/\}/g) || []).length;
          return { text: inner + "}".repeat(Math.max(0, missing)), end: j };
        }
      }
      if (!recover && !depthAt) indexUnclosed();
      return fail(open[open.length - 1], "unterminated_brace", "This brace is never closed.", { eof: true });
    }

    // Quoted values end at a '"' outside braces; \" and \\ are escapes.
    function readQuoted(i) {
      let depth = 0;
      for (let j = i + 1; j < src.length; j++) {
        const ch = src[j];
        if (ch === "\\") {
          if (j + 1 >= src.length) return fail(j, "unterminated_escape", "A backslash ends the file inside a quoted value.", { eof: true });
          if (src[j + 1] === '"' || src[j + 1] === "\\") j++;
        } else if (ch === "{") depth++;
        else if (ch === "}") {
          if (!depth) return fail(i, "unterminated_quote", "This quoted value is not closed before a closing brace.");
          depth--;
        } else if (ch === '"' && !depth) return { text: src.slice(i + 1, j), end: j + 1 };
      }
      return fail(i, "unterminated_quote", "This quoted value is never closed.", { eof: true });
    }

    // value = part ("#" part)*, part = {…} | "…" | number | macro name
    function readValue(i, recover) {
      const parts = [];
      const start = skipGap(i);
      let end = start;
      for (i = start; ; ) {
        let part;
        if (src[i] === "{") part = readBraced(i, recover);
        else if (src[i] === '"') part = readQuoted(i);
        else {
          NAME.lastIndex = i;
          const word = NAME.exec(src)?.[0];
          if (!word) return fail(i, "expected_value", "Expected a value: {…}, \"…\", a number or a @string name.", { eof: i >= src.length });
          const known = macros.get(word.toLowerCase());
          part = /^\d+$/.test(word)
            ? { text: word, end: i + word.length }
            : { text: known ?? word, end: i + word.length, macro: true, undefinedMacro: known === undefined ? word : "" };
        }
        if (part.error) return part;
        parts.push(part);
        end = part.end;
        const next = skipGap(end);
        if (src[next] !== "#") break;
        i = skipGap(next + 1);
      }
      return {
        text: parts.map(part => part.text).join(""),
        undefinedMacros: parts.map(part => part.undefinedMacro).filter(Boolean),
        raw: src.slice(start, end),
        span: [start, end],
        literal: parts.length === 1 && !parts[0].macro,
        end,
      };
    }

    // name = value, … up to the closing delimiter (missing commas tolerated).
    // Comment lines between fields are kept: field.comments holds those before
    // the field, the result's `comments` those after the last one.
    function readFields(i, close, recover) {
      const fields = [];
      let comments = [];
      for (;;) {
        i = skipGap(i, comments);
        const ch = src[i];
        if (ch === undefined) return fail(i, "unterminated", "", { eof: true, fields });
        if (ch === close) return { fields, comments, end: i + 1 };
        if (ch === ",") { i++; continue; }
        if (ch === "@") return fail(i, "unterminated_entry", "", { fields });
        NAME.lastIndex = i;
        const name = NAME.exec(src)?.[0];
        if (!name) return fail(i, "unexpected_character", `Unexpected "${ch}" where a field name was expected.`, { fields });
        i = skipGap(i + name.length);
        if (src[i] !== "=") return fail(i, "expected_equals", `Expected "=" after the field name "${name}".`, { eof: i >= src.length, fields });
        const value = readValue(i + 1, recover);
        if (value.error) return { ...value, fields };
        fields.push({
          name: name.toLowerCase(),
          value: value.text.replace(/\s*[\r\n]\s*/g, " ").trim(),
          text: value.text,
          raw: value.raw,
          span: value.span,
          literal: value.literal,
          undefinedMacros: value.undefinedMacros,
          comments,
        });
        comments = [];
        i = value.end;
      }
    }

    function readCommand(type, at, open, close, recover) {
      if (type === "comment") {
        if (close === "}") return readBraced(open, false);
        const end = src.indexOf(")", open);
        return end < 0 ? fail(open, "unterminated_brace", "This @comment is never closed.", { eof: true }) : { end: end + 1 };
      }
      if (type === "preamble") {
        const value = readValue(open + 1, false);
        if (value.error) return value;
        const end = skipGap(value.end);
        if (src[end] !== close) return fail(end, "expected_close", `Expected "${close}" to close the @preamble.`, { eof: end >= src.length });
        return { value: value.text, end: end + 1 };
      }
      if (type === "string") return readFields(open + 1, close, false);
      // The key runs to the comma on its line (as before S3, any other character is kept).
      const keyStart = skipGap(open + 1);
      let keyEnd = keyStart;
      while (keyEnd < src.length && !/[,{}\r\n]/.test(src[keyEnd]) && src[keyEnd] !== close) keyEnd++;
      const key = src.slice(keyStart, keyEnd).trim();
      if (!key) return fail(keyStart, "missing_key", "This entry has no citation key.", { eof: keyStart >= src.length });
      const after = skipGap(keyEnd);
      if (src[after] === close) return { key, fields: [], comments: [], end: after + 1 };
      if (src[after] !== ",") return fail(after, "expected_comma", `Expected "," after the citation key "${key}".`, { key, eof: after >= src.length });
      return { key, ...readFields(after + 1, close, recover) };
    }

    // The error of a malformed piece that ends at `stop` (where parsing
    // resumes). A piece read past `stop`, or one that meets the next entry
    // where a field should be, is "not closed before the next entry"; an entry
    // open to the end of the file is reported where it opens.
    function describe(result, at, open, key, stop) {
      const { error } = result;
      const label = key ? `The entry "${key}"` : "This entry";
      if (error.reason === "unterminated_entry" || (error.offset >= stop && stop < src.length))
        return { offset: stop, reason: "unterminated_entry", key, message: `${label} (line ${lineColumn(at).line}) is not closed before the next entry starts; check for an unbalanced brace, for example a lone \\{ or \\}.` };
      if (error.reason === "unterminated")
        return { offset: open, reason: "unterminated_brace", key, message: `${label} is never closed.` };
      return { ...error, key };
    }

    function addEntry(type, key, fields) {
      const entry = { ENTRYTYPE: type, ID: key };
      const issues = [];
      for (const field of fields) {
        // An undefined @string name stays the value (as before); BibTeX would
        // warn and use an empty string, so this is a non-blocking warning.
        if (field.undefinedMacros?.length && !issues.some(issue => issue.code === "undefined_macro" && issue.field === field.name)) issues.push({
          code: "undefined_macro",
          field: field.name,
          message: `The field "${field.name}" uses ${field.undefinedMacros.map(name => `"${name}"`).join(", ")}, which no @string defines; the name itself is kept as the value.`,
          severity: "warning",
          blocking: false,
        });
        if (!Object.prototype.hasOwnProperty.call(entry, field.name)) entry[field.name] = field.value;
        else if (!issues.some(issue => issue.field === field.name)) issues.push({
          code: "duplicate_field",
          field: field.name,
          message: `The field "${field.name}" appears more than once; BibTeX keeps the first value ("${entry[field.name]}") and ignores the others.`,
        });
      }
      const earlier = keys.get(key.toLowerCase());
      if (earlier === undefined) keys.set(key.toLowerCase(), key);
      else issues.push({
        code: "duplicate_citation_key",
        field: "ID",
        message: `The citation key "${key}" is already used by an earlier entry ("${earlier}"); BibTeX keeps only the first.`,
      });
      if (issues.length) entry._bibIssues = issues;
      entries.push(entry);
      return entries.length - 1;
    }

    const pushText = end => {
      if (end > textStart) items.push({ kind: "text", span: [textStart, end], raw: src.slice(textStart, end) });
    };

    for (;;) {
      const at = src.indexOf("@", pos);
      if (at < 0) break;
      if (inComment(at)) {
        pos = at + 1;
        while (pos < src.length && src[pos] !== "\n" && src[pos] !== "\r") pos++;
        continue;
      }
      HEAD.lastIndex = at;
      const head = HEAD.exec(src);
      if (!head) { pos = at + 1; continue; }
      const type = head[1].toLowerCase();
      const open = at + head[0].length - 1;
      const close = head[2] === "{" ? "}" : ")";
      const isEntry = !["comment", "preamble", "string"].includes(type);

      let result = readCommand(type, at, open, close, false);
      if (result.error) {
        const lineStartAt = nextLineStartAt(at);
        const resync = result.error.reason === "unterminated_entry"
          ? Math.min(result.error.offset, lineStartAt, src.length)
          : Math.min(lineStartAt, src.length);
        const error = describe(result, at, open, result.key || "", resync);
        errors.push(error);
        if (!lenient) {
          // The malformed piece stays in the document as an invalid item.
          let end = resync;
          while (end > at && /\s/.test(src[end - 1])) end--;
          pushText(at);
          items.push({ kind: "invalid", span: [at, end], raw: src.slice(at, end), type, key: result.key || "", error });
          textStart = end;
          pos = resync;
          continue;
        }
        // An entry left open to the end of the file: retry the typo recovery.
        const retry = isEntry && result.eof && lineStartAt === Infinity ? readCommand(type, at, open, close, true) : null;
        if (retry && !retry.error) result = retry;
        else {
          if (isEntry && result.key) addEntry(type, result.key, result.fields || []);
          pos = resync;
          continue;
        }
      }
      pushText(at);
      const item = { kind: isEntry ? "entry" : type, span: [at, result.end], raw: src.slice(at, result.end) };
      if (isEntry) Object.assign(item, { type, key: result.key, fields: result.fields, comments: result.comments || [], index: addEntry(type, result.key, result.fields) });
      else if (type === "preamble") item.value = result.value;
      else if (type === "string") {
        item.fields = result.fields;
        for (const field of result.fields) {
          macros.set(field.name, field.text);
          strings[field.name] = field.text;
        }
      }
      items.push(item);
      pos = textStart = result.end;
    }
    pushText(src.length);

    for (const error of errors) Object.assign(error, lineColumn(error.offset));
    return { items, entries, strings, errors, eol: dominantEol(src) };
  }

  function parseBibDocument(text) {
    return readSource(text, false);
  }

  function parseBib(text) {
    return readSource(text, true).entries;
  }

  // ─── Writing ───────────────────────────────────────────────────────
  // Values that came from the user's entry are LaTeX already and are written
  // as they are. Other values (providers, edits) are plain text and are made
  // LaTeX-safe outside identifier fields. Unicode→LaTeX accent conversion is
  // the separate latexEscape setting, never applied to identifiers.
  const IDENTIFIER_FIELDS = new Set([
    "url", "doi", "eprint", "archiveprefix", "primaryclass", "eprinttype", "eprintclass",
    "ee", "biburl", "pdf", "href", "isbn", "issn", "file", "pmid", "pmcid",
  ]);

  const fieldKey = name => String(name || "").trim().toLowerCase();

  // \url{…}, \path{…}, \nolinkurl{…} and the first argument of \href{…}{…}
  // are verbatim: never escaped or accent-converted.
  const VERBATIM_ARG = /\\(?:url|path|nolinkurl|href)\s*\{/y;
  const VERBATIM_ARGS = /\\(?:url|path|nolinkurl|href)\s*\{/g;

  // Unicode → LaTeX accent commands outside verbatim arguments. In a quoted
  // value a bare '"' ends the value, so a command holding \" is braced there
  // ({\"{u}}, {\"{\~{o}}}).
  function accentsToLatex(raw) {
    const options = { quoted: raw.includes('"') };
    let out = "";
    let cursor = 0;
    for (const match of raw.matchAll(VERBATIM_ARGS)) {
      if (match.index < cursor) continue;
      const open = match.index + match[0].length - 1;
      const close = matchingBrace(raw, open);
      if (close < 0) break;
      out += unicodeToLatex(raw.slice(cursor, open + 1), options) + raw.slice(open + 1, close);
      cursor = close;
    }
    return out + unicodeToLatex(raw.slice(cursor), options);
  }

  // Inline math by pandoc's rule: the opening $ has a non-space character
  // right after it, the closing $ a non-space character right before it and
  // no digit right after it; $$…$$ is display math. Returns the index of the
  // closing $, or -1 when the $ at i is a literal dollar.
  function mathClose(s, i) {
    if (s[i + 1] === "$") {
      const end = s.indexOf("$$", i + 2);
      return end > i + 2 ? end + 1 : -1;
    }
    if (i + 1 >= s.length || /\s/.test(s[i + 1])) return -1;
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === "$" && !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] || "")) return j;
    }
    return -1;
  }

  // Plain text → LaTeX: escape & % $ # _ ^ outside $…$ math, keep commands,
  // escapes, balanced braces and verbatim (URL) arguments, neutralise
  // unbalanced braces and a dangling backslash.
  function latexSafe(value) {
    const s = decodeHtmlEntities(value);
    const unbalanced = new Set();
    const open = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") open.push(i);
      else if (s[i] === "}" && !open.length) unbalanced.add(i);
      else if (s[i] === "}") open.pop();
    }
    open.forEach(i => unbalanced.add(i));
    const brace = i => s[i] === "{" ? "\\textbraceleft{}" : "\\textbraceright{}";
    let out = "";
    let mathUntil = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (unbalanced.has(i)) out += brace(i);
      else if (ch === "\\") {
        VERBATIM_ARG.lastIndex = i;
        const url = VERBATIM_ARG.exec(s);
        const close = url ? matchingBrace(s, i + url[0].length - 1) : -1;
        if (close > 0) { out += s.slice(i, close + 1); i = close; }
        else if (unbalanced.has(i + 1)) { out += brace(i + 1); i++; }
        else if (i + 1 >= s.length || /\s/.test(s[i + 1])) out += "\\textbackslash{}";
        else { out += ch + s[i + 1]; i++; }
      } else if (i <= mathUntil) out += ch;
      else if (ch === "$") {
        mathUntil = mathClose(s, i);
        out += mathUntil > i ? ch : "\\$";
      }
      else if ("&%#_".includes(ch)) out += `\\${ch}`;
      else if (ch === "^") out += "\\^{}";
      else out += ch;
    }
    return out;
  }

  // One entry in the canonical layout. original/sourceFields (from the
  // parsed document) mark which values are the user's; without them every
  // value is treated as the user's (entriesToBib). `comments` (name → lines)
  // puts the source's comment lines back before their field; comments whose
  // field is gone, and `trailing`, go last.
  function formatEntry(entry, { latexEscape = false, original = null, sourceFields = new Map(), eol = "\n", comments = new Map(), trailing = [] } = {}) {
    const lines = [`@${entry.ENTRYTYPE || "misc"}{${entry.ID || "unknown"},`];
    const emitted = new Set();
    for (const [name, value] of Object.entries(entry)) {
      if (name === "ENTRYTYPE" || name === "ID" || name.startsWith("_")) continue;
      const key = fieldKey(name);
      if (!key || emitted.has(key)) continue;
      emitted.add(key);
      const identifier = IDENTIFIER_FIELDS.has(key);
      const accents = text => latexEscape && !identifier ? accentsToLatex(text) : text;
      const fromUser = !original || (Object.prototype.hasOwnProperty.call(original, key) && String(original[key]) === String(value));
      const source = fromUser ? sourceFields.get(key) : null;
      let text;
      if (source && !source.literal) text = accents(source.raw);
      else if (fromUser) text = `{${accents(String(value))}}`;
      else text = `{${accents(identifier ? decodeHtmlEntities(value) : latexSafe(value))}}`;
      for (const comment of comments.get(key) || []) lines.push(`  ${comment}`);
      lines.push(`  ${name} = ${text},`);
    }
    for (const [key, list] of comments) if (!emitted.has(key)) for (const comment of list) lines.push(`  ${comment}`);
    for (const comment of trailing) lines.push(`  ${comment}`);
    lines.push("}");
    return lines.join(eol);
  }

  function entriesToBib(entries, options = {}) {
    return entries.map(entry => `${formatEntry(entry, options)}\n`).join("\n");
  }

  function publicFields(entry) {
    const fields = new Map();
    for (const [name, value] of Object.entries(entry || {})) {
      const key = fieldKey(name);
      if (name !== "ENTRYTYPE" && name !== "ID" && !name.startsWith("_") && key && !fields.has(key)) fields.set(key, String(value));
    }
    return fields;
  }

  function sameEntry(original, entry) {
    if (fieldKey(original.ENTRYTYPE) !== fieldKey(entry.ENTRYTYPE) || original.ID !== entry.ID) return false;
    const before = publicFields(original);
    const after = publicFields(entry);
    return before.size === after.size && [...before].every(([key, value]) => after.get(key) === value);
  }

  function entryText(doc, item, entry, latexEscape) {
    const original = doc.entries[item.index];
    if (sameEntry(original, entry)) {
      if (!latexEscape) return item.raw;
      let out = "";
      let cursor = 0;
      for (const field of item.fields) {
        if (IDENTIFIER_FIELDS.has(field.name)) continue;
        const [start, end] = field.span.map(offset => offset - item.span[0]);
        out += item.raw.slice(cursor, start) + accentsToLatex(item.raw.slice(start, end));
        cursor = end;
      }
      return out + item.raw.slice(cursor);
    }
    const sourceFields = new Map();
    const comments = new Map();
    for (const field of item.fields) {
      if (!sourceFields.has(field.name)) sourceFields.set(field.name, field);
      if (field.comments.length) comments.set(field.name, [...(comments.get(field.name) || []), ...field.comments]);
    }
    return formatEntry(entry, { latexEscape, original, sourceFields, eol: doc.eol, comments, trailing: item.comments });
  }

  /**
   * Writes a parsed document with `outputs` ([{ index, entry }]: the entry to
   * export for doc.entries[index]; entries without an output are removed,
   * together with the blank text that separated them). Everything else,
   * invalid (unparsable) items included, is written as it was, plus a final
   * line ending if missing. Returns the text and one part per item ({ kind,
   * index?, id?, original, output }; output is null for a removed entry) for
   * the preview diff.
   */
  function writeBib(doc, outputs, options = {}) {
    const latexEscape = options.latexEscape === true;
    const byIndex = new Map(outputs.map(output => [output.index, output.entry]));
    const parts = doc.items.map(item => {
      if (item.kind !== "entry") return {
        kind: item.kind,
        original: item.raw,
        output: latexEscape && (item.kind === "string" || item.kind === "preamble") ? accentsToLatex(item.raw) : item.raw,
      };
      const entry = byIndex.get(item.index);
      return {
        kind: "entry",
        index: item.index,
        id: entry?.ID ?? item.key,
        original: item.raw,
        output: entry ? entryText(doc, item, entry, latexEscape) : null,
      };
    });
    const blank = part => part?.kind === "text" && !part.original.trim();
    parts.forEach((part, p) => {
      if (part.output !== null) return;
      if (p > 1 && blank(parts[p - 1]) && parts[p - 1].output !== "") parts[p - 1].output = "";
      else if (blank(parts[p + 1])) parts[p + 1].output = "";
    });
    const text = parts.map(part => part.output ?? "").join("");
    // A file ends with a line ending (pasted text often lacks one).
    return { text: text && !/[\r\n]$/.test(text) ? text + doc.eol : text, parts };
  }

export {
  parseBib,
  parseBibDocument,
  entriesToBib,
  writeBib,
};
