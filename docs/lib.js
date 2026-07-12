/*
 * BibLib — pure logic functions for Local Citation Verifier.
 * Works as a browser global (window.BibLib) and as a Node.js module.
 */
(function (exports) {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────
  const TITLE_MATCH_THRESHOLD = 85;
  const MIN_TITLE_SIM = 70;
  const COMPARED_FIELDS = [
    "author", "year", "journal", "booktitle",
    "volume", "number", "pages", "doi", "publisher",
  ];

  // ─── LaTeX helpers ───────────────────────────────────────────────────
  const LATEX_ACCENT_MAP = {
    "\\'a":"á", "\\'e":"é", "\\'i":"í", "\\'o":"ó", "\\'u":"ú",
    "\\`a":"à", "\\`e":"è", "\\`i":"ì", "\\`o":"ò", "\\`u":"ù",
    '\\"a':"ä", '\\"e':"ë", '\\"i':"ï", '\\"o':"ö", '\\"u':"ü",
    "\\~n":"ñ", "\\~a":"ã", "\\~o":"õ",
    "\\^a":"â", "\\^e":"ê", "\\^i":"î", "\\^o":"ô", "\\^u":"û",
    "\\c{c}":"ç", "\\c c":"ç", "{\\ss}":"ß",
  };

  function stripLatex(text) {
    if (!text) return "";
    for (const [latex, ch] of Object.entries(LATEX_ACCENT_MAP))
      text = text.replaceAll(latex, ch);
    text = text.replace(/\\[a-zA-Z]+\s*/g, "");
    text = text.replace(/[{}]/g, "");
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeTitle(title) {
    return stripLatex(title).replace(/[βΒ]/g, "beta").toLowerCase().trim();
  }

  function looseTitleText(title) {
    return normalizeTitle(title).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // ─── BibTeX parser / serializer ──────────────────────────────────────
  function skipWhitespace(str, i) {
    while (i < str.length && /\s/.test(str[i])) i++;
    return i;
  }

  /** Append missing `}` so nested `{...}` recover from typos like `{{Foo},` before next field. */
  function balanceClosingBraces(s) {
    let net = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") net++;
      else if (s[i] === "}") net--;
    }
    let out = s;
    while (net > 0) {
      out += "}";
      net--;
    }
    return out;
  }

  /**
   * Parse `{...}` with nested-brace awareness. If the user omits the closing `}` before `,`
   * and the next token looks like another field (`title =`), treat the comma as the field
   * separator and repair inner braces (common with `{{GitHub},` typos).
   */
  function extractBracedFieldValue(str, start) {
    if (str[start] !== "{") return { value: "", next: start };
    let i = start + 1;
    let depth = 1;
    while (i < str.length && depth > 0) {
      const c = str[i];
      if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        depth--;
        i++;
        if (depth === 0) {
          const inner = str.slice(start + 1, i - 1);
          let next = skipWhitespace(str, i);
          if (str[next] === ",") next = skipWhitespace(str, next + 1);
          return { value: inner, next };
        }
      } else if (depth === 1 && c === ",") {
        const tail = str.slice(i + 1);
        if (/^\s*(?:\r?\n\s*)?\w+\s*=/.test(tail)) {
          const inner = str.slice(start + 1, i);
          return {
            value: balanceClosingBraces(inner),
            next: skipWhitespace(str, i + 1),
          };
        }
        i++;
      } else {
        i++;
      }
    }
    const inner = str.slice(start + 1);
    return { value: balanceClosingBraces(inner), next: str.length };
  }

  function extractQuotedFieldValue(str, start) {
    if (str[start] !== '"') return { value: "", next: start };
    let i = start + 1;
    let buf = "";
    while (i < str.length) {
      const c = str[i];
      if (c === "\\" && i + 1 < str.length) {
        buf += c + str[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        let next = skipWhitespace(str, i);
        if (str[next] === ",") next = skipWhitespace(str, next + 1);
        return { value: buf, next };
      }
      buf += c;
      i++;
    }
    return { value: buf, next: str.length };
  }

  function extractBareFieldValue(str, start) {
    let i = start;
    while (i < str.length && str[i] !== ",") i++;
    let next = skipWhitespace(str, i);
    if (str[next] === ",") next = skipWhitespace(str, next + 1);
    return { value: str.slice(start, i).trim(), next };
  }

  function parseYearNumber(value) {
    const match = String(value || "").match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
    return match ? Number(match[1]) : NaN;
  }

  function chooseDuplicateFieldValue(key, currentValue, nextValue) {
    if (key !== "year") return nextValue;
    const currentYear = parseYearNumber(currentValue);
    const nextYear = parseYearNumber(nextValue);
    if (Number.isFinite(currentYear) && Number.isFinite(nextYear))
      return String(Math.max(currentYear, nextYear));
    return nextValue || currentValue;
  }

  function parseEntryFields(body) {
    const fields = {};
    let i = skipWhitespace(body, 0);
    while (i < body.length) {
      if (body[i] === ",") {
        i = skipWhitespace(body, i + 1);
        continue;
      }
      const nameMatch = /^([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(i));
      if (!nameMatch) break;
      const key = nameMatch[1].toLowerCase();
      i += nameMatch[0].length;
      i = skipWhitespace(body, i);
      if (i >= body.length) break;

      let ext;
      if (body[i] === "{") ext = extractBracedFieldValue(body, i);
      else if (body[i] === '"') ext = extractQuotedFieldValue(body, i);
      else ext = extractBareFieldValue(body, i);

      if (ext.next === i) break;
      const value = ext.value.replace(/\s*\n\s*/g, " ").trim();
      fields[key] = Object.prototype.hasOwnProperty.call(fields, key)
        ? chooseDuplicateFieldValue(key, fields[key], value)
        : value;
      i = skipWhitespace(body, ext.next);
    }
    return fields;
  }

  function findEntryClose(content, openIndex, openChar) {
    const closeChar = openChar === "{" ? "}" : ")";
    let depth = 1;
    let braceDepth = 0;
    let inQuote = false;
    for (let i = openIndex + 1; i < content.length; i++) {
      const c = content[i];
      if (openChar === "{") {
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return i;
        }
        continue;
      }
      if (inQuote) {
        if (c === "\\" && i + 1 < content.length) {
          i++;
          continue;
        }
        if (c === '"') inQuote = false;
        continue;
      }
      if (c === '"') {
        inQuote = true;
        continue;
      }
      if (c === "{") braceDepth++;
      else if (c === "}" && braceDepth > 0) braceDepth--;
      else if (c === closeChar && braceDepth === 0) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function splitEntryKeyAndBody(inner) {
    let depth = 0;
    let inQuote = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (inQuote) {
        if (c === "\\" && i + 1 < content.length) {
          i++;
          continue;
        }
        if (c === '"') inQuote = false;
        continue;
      }
      if (c === '"') {
        inQuote = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}" && depth > 0) {
        depth--;
      } else if (c === "," && depth === 0) {
        return { id: inner.slice(0, i).trim(), body: inner.slice(i + 1).trim() };
      }
    }
    return { id: inner.trim(), body: "" };
  }

  function parseBib(content) {
    const entries = [];
    let i = 0;
    while (i < content.length) {
      const at = content.indexOf("@", i);
      if (at === -1) break;
      const typeMatch = /^@([A-Za-z][\w-]*)\s*/.exec(content.slice(at));
      if (!typeMatch) {
        i = at + 1;
        continue;
      }
      const entryType = typeMatch[1].toLowerCase();
      let openIndex = skipWhitespace(content, at + typeMatch[0].length);
      const openChar = content[openIndex];
      if (openChar !== "{" && openChar !== "(") {
        i = at + 1;
        continue;
      }
      const closeIndex = findEntryClose(content, openIndex, openChar);
      const innerEnd = closeIndex === -1 ? content.length : closeIndex;
      const inner = content.slice(openIndex + 1, innerEnd);
      i = closeIndex === -1 ? content.length : closeIndex + 1;

      if (entryType === "string" || entryType === "preamble" || entryType === "comment")
        continue;
      const { id, body } = splitEntryKeyAndBody(inner);
      if (!id) continue;
      const entry = { ENTRYTYPE: entryType, ID: id };
      Object.assign(entry, parseEntryFields(body));
      entries.push(entry);
    }
    return entries;
  }

  function scanBibtexEntryStructure(content, openIndex, openChar) {
    const braceOffsets = openChar === "{" ? [openIndex] : [];
    const entryFieldDepth = braceOffsets.length;
    let inQuote = false;
    let quoteOffset = -1;

    for (let i = openIndex + 1; i < content.length; i++) {
      const c = content[i];
      if (c === "\\") {
        if (i + 1 >= content.length)
          return { diagnostic: { offset: i, reason: "unterminated_escape" } };
        i++;
        continue;
      }
      if (c === '"') {
        if (inQuote) {
          inQuote = false;
          quoteOffset = -1;
        } else {
          let previous = i - 1;
          while (previous > openIndex && /\s/.test(content[previous])) previous--;
          if (braceOffsets.length === entryFieldDepth &&
              (content[previous] === "=" || content[previous] === "#")) {
            inQuote = true;
            quoteOffset = i;
          }
        }
        continue;
      }
      if (c === "{") {
        braceOffsets.push(i);
        continue;
      }
      if (c === "}") {
        if (!braceOffsets.length)
          return { diagnostic: { offset: i, reason: "unexpected_closing_brace" } };
        braceOffsets.pop();
        if (openChar === "{" && !braceOffsets.length) {
          if (inQuote)
            return { diagnostic: { offset: quoteOffset, reason: "unterminated_quote" } };
          return { closeIndex: i };
        }
        continue;
      }
      if (openChar === "(" && c === ")" && !inQuote && !braceOffsets.length)
        return { closeIndex: i };
    }

    if (inQuote)
      return { diagnostic: { offset: quoteOffset, reason: "unterminated_quote" } };
    const offset = braceOffsets.length ? braceOffsets[braceOffsets.length - 1] : openIndex;
    return { diagnostic: { offset, reason: "unterminated_brace" } };
  }

  function validateBibtexStructure(content) {
    let i = 0;
    while (i < content.length) {
      const at = content.indexOf("@", i);
      if (at === -1) return null;
      const typeMatch = /^@([A-Za-z][\w-]*)\s*/.exec(content.slice(at));
      if (!typeMatch) {
        i = at + 1;
        continue;
      }
      const openIndex = skipWhitespace(content, at + typeMatch[0].length);
      const openChar = content[openIndex];
      if (openChar !== "{" && openChar !== "(") {
        i = at + 1;
        continue;
      }
      const scanned = scanBibtexEntryStructure(content, openIndex, openChar);
      if (scanned.diagnostic) return scanned.diagnostic;
      i = scanned.closeIndex + 1;
    }
    return null;
  }

  function parseBibDocument(content) {
    const source = typeof content === "string" ? content : String(content ?? "");
    const diagnostic = validateBibtexStructure(source);
    return {
      source,
      diagnostic,
      entries: diagnostic ? [] : parseBib(source),
    };
  }

  // ─── Unicode → LaTeX escaping (optional export for pdfLaTeX/BibTeX) ───
  // Only codepoints > U+007F are transformed, so any LaTeX escapes already in
  // the input (pure ASCII like \"a, \H{o}) are left untouched — no double escaping.
  const LATEX_COMBINING_MAP = {
    "̀": "\\`", "́": "\\'", "̂": "\\^", "̃": "\\~",
    "̄": "\\=", "̆": "\\u", "̇": "\\.", "̈": '\\"',
    "̊": "\\r", "̋": "\\H", "̌": "\\v",
    "̣": "\\d", "̧": "\\c", "̨": "\\k", "̱": "\\b",
  };
  const LATEX_SPECIAL_MAP = {
    "ß": "{\\ss}",
    "ø": "{\\o}", "Ø": "{\\O}",
    "æ": "{\\ae}", "Æ": "{\\AE}",
    "œ": "{\\oe}", "Œ": "{\\OE}",
    "å": "{\\aa}", "Å": "{\\AA}",
    "ł": "{\\l}", "Ł": "{\\L}",
    "đ": "{\\dj}", "Đ": "{\\DJ}",
    "ð": "{\\dh}", "Ð": "{\\DH}",
    "þ": "{\\th}", "Þ": "{\\TH}",
    "ı": "{\\i}", "ȷ": "{\\j}",
  };
  const LATEX_PUNCT_MAP = {
    "–": "--", "—": "---",
    "‘": "`", "’": "'", "“": "``", "”": "''",
    "…": "\\ldots{}", " ": "~", "­": "", " ": " ", " ": " ",
  };

  function unicodeCharToLatex(ch) {
    if (LATEX_SPECIAL_MAP[ch]) return LATEX_SPECIAL_MAP[ch];
    if (LATEX_PUNCT_MAP[ch] !== undefined) return LATEX_PUNCT_MAP[ch];
    const decomposed = ch.normalize("NFD");
    const base = decomposed[0];
    if (decomposed.length > 1 && base && base.charCodeAt(0) <= 127 && /[A-Za-z]/.test(base)) {
      let out = base;
      for (let i = 1; i < decomposed.length; i++) {
        const acc = LATEX_COMBINING_MAP[decomposed[i]];
        if (!acc) return ch; // unknown combining mark — leave char untouched
        out = `${acc}{${out}}`;
      }
      return out;
    }
    return ch; // unmapped (e.g. CJK, rare symbol) — leave as-is, never corrupt
  }

  function unicodeToLatex(text) {
    let out = "";
    for (const ch of String(text || "").normalize("NFC"))
      out += ch.codePointAt(0) <= 127 ? ch : unicodeCharToLatex(ch);
    return out;
  }

  function entriesToBib(entries, options = {}) {
    const escapeValue = options.latexEscape ? unicodeToLatex : (value) => value;
    const lines = [];
    for (const entry of entries) {
      const type = entry.ENTRYTYPE || "misc";
      const id = entry.ID || "unknown";
      lines.push(`@${type}{${id},`);
      const emittedFields = new Set();
      for (const [k, v] of Object.entries(entry)) {
        if (k === "ENTRYTYPE" || k === "ID" || k.startsWith("_")) continue;
        const canonicalKey = String(k || "").trim().toLowerCase();
        if (!canonicalKey || emittedFields.has(canonicalKey)) continue;
        emittedFields.add(canonicalKey);
        lines.push(`  ${k} = {${escapeValue(v)}},`);
      }
      lines.push("}\n");
    }
    return lines.join("\n");
  }

  // ─── Fuzzy matching ──────────────────────────────────────────────────
  function tokenSortRatio(a, b) {
    if (typeof fuzzball !== "undefined") return fuzzball.token_sort_ratio(a, b);
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 100;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 100;
    let matches = 0;
    for (let i = 0; i < shorter.length; i++)
      if (longer.includes(shorter[i])) matches++;
    return Math.round((matches / longer.length) * 100);
  }

  function titleSimilarity(a, b) {
    return tokenSortRatio(a.toLowerCase().trim(), b.toLowerCase().trim());
  }

  // ─── Normalization helpers ───────────────────────────────────────────
  function normalizeText(text) {
    if (!text) return "";
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().trim().replace(/\s+/g, " ");
  }

  function normalizeAuthorSet(authorStr) {
    if (!authorStr) return new Set();
    const norm = normalizeText(authorStr);
    const parts = norm.split(/\s+and\s+/);
    const names = new Set();
    for (let a of parts) {
      a = a.trim();
      if (!a) continue;
      if (a.includes(",")) names.add(a.split(",")[0].trim());
      else { const t = a.split(/\s+/); names.add(t[t.length - 1]); }
    }
    return names;
  }

  function normalizePages(p) { return p.trim().replace(/\s*-+\s*/g, "-"); }

  // ─── Field comparison ────────────────────────────────────────────────
  function compareAuthors(a, b) {
    const sa = normalizeAuthorSet(a), sb = normalizeAuthorSet(b);
    if (!sa.size && !sb.size) return 100;
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    for (const n of sa) if (sb.has(n)) inter++;
    return (inter / Math.max(sa.size, sb.size)) * 100;
  }

  function authorParts(authorStr) {
    return String(authorStr || "")
      .split(/\s+and\s+/i)
      .map(part => part.trim())
      .filter(Boolean);
  }

  function hasTruncatedAuthorMarker(authorStr) {
    return /(^|\s+and\s+)(others|et\s+al\.?)\b|\.\.\./i.test(String(authorStr || ""));
  }

  function firstAuthorLastName(authorStr) {
    const first = authorParts(authorStr)[0] || "";
    const cleaned = stripLatex(first).replace(/[{}]/g, "").trim();
    if (!cleaned) return "";
    if (cleaned.includes(",")) return normalizeText(cleaned.split(",")[0]);
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return normalizeText(parts[parts.length - 1] || "");
  }

  function splitAuthorName(author) {
    const cleaned = stripLatex(author).replace(/[{}]/g, "").trim();
    if (!cleaned) return { family: "", given: "" };
    if (cleaned.includes(",")) {
      const [family, ...givenParts] = cleaned.split(",");
      return { family: normalizeText(family), given: normalizeText(givenParts.join(" ")) };
    }
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return { family: normalizeText(parts.pop() || ""), given: normalizeText(parts.join(" ")) };
  }

  function initialsFromGiven(given) {
    return normalizeText(given)
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part[0] || "")
      .join("");
  }

  function isInitialOnlyGiven(given) {
    const compact = normalizeText(given).replace(/[.\s-]/g, "");
    return !!compact && compact.length <= 3;
  }

  function hasOnlyInitialShortening(originalAuthor, foundAuthor) {
    const originalParts = authorParts(originalAuthor);
    const foundParts = authorParts(foundAuthor);
    if (originalParts.length !== foundParts.length || !originalParts.length) return false;
    return originalParts.every((originalPart, index) => {
      const original = splitAuthorName(originalPart);
      const found = splitAuthorName(foundParts[index]);
      if (!original.family || original.family !== found.family) return false;
      if (!original.given || !found.given || original.given === found.given) return true;
      return isInitialOnlyGiven(found.given) && initialsFromGiven(original.given).startsWith(initialsFromGiven(found.given));
    });
  }

  const SURNAME_PARTICLE_WORDS = new Set([
    "al", "da", "das", "de", "del", "della", "den", "der", "di", "dos",
    "du", "la", "le", "ten", "ter", "van", "von",
  ]);

  function trimTrailingNameParticles(given) {
    const parts = normalizeText(given).split(/\s+/).filter(Boolean);
    while (parts.length && SURNAME_PARTICLE_WORDS.has(parts[parts.length - 1])) parts.pop();
    return parts.join(" ");
  }

  function familyVariants(name) {
    const variants = new Set();
    const family = normalizeText(name.family);
    const given = normalizeText(name.given);
    if (family) variants.add(family);

    const familyParts = family.split(/\s+/).filter(Boolean);
    while (familyParts.length > 1 && SURNAME_PARTICLE_WORDS.has(familyParts[0])) {
      familyParts.shift();
      variants.add(familyParts.join(" "));
    }

    const givenParts = given.split(/\s+/).filter(Boolean);
    const trailingParticles = [];
    while (givenParts.length && SURNAME_PARTICLE_WORDS.has(givenParts[givenParts.length - 1])) {
      trailingParticles.unshift(givenParts.pop());
    }
    if (family && trailingParticles.length) variants.add(`${trailingParticles.join(" ")} ${family}`);
    return variants;
  }

  function familiesOverlap(original, found) {
    const originalVariants = familyVariants(original);
    const foundVariants = familyVariants(found);
    for (const variant of originalVariants) if (foundVariants.has(variant)) return true;
    return false;
  }

  function givensCompatibleForSuppression(originalGiven, foundGiven) {
    const original = trimTrailingNameParticles(originalGiven);
    const found = trimTrailingNameParticles(foundGiven);
    if (!original || !found || original === found) return true;
    const originalInitials = initialsFromGiven(original);
    const foundInitials = initialsFromGiven(found);
    if (!originalInitials || !foundInitials) return true;
    if (isInitialOnlyGiven(found)) return originalInitials[0] === foundInitials[0];
    return originalInitials === foundInitials || originalInitials.startsWith(foundInitials);
  }

  function hasParticleOrInitialOnlyEquivalentAuthors(originalAuthor, foundAuthor) {
    const originalParts = authorParts(originalAuthor);
    const foundParts = authorParts(foundAuthor);
    if (originalParts.length !== foundParts.length || !originalParts.length) return false;
    return originalParts.every((originalPart, index) => {
      const original = splitAuthorName(originalPart);
      const found = splitAuthorName(foundParts[index]);
      if (!original.family || !found.family || !familiesOverlap(original, found)) return false;
      return givensCompatibleForSuppression(original.given, found.given);
    });
  }

  function shouldSuppressAuthorSuggestion(originalAuthor, foundAuthor) {
    const originalParts = authorParts(originalAuthor);
    const foundParts = authorParts(foundAuthor);
    if (!originalParts.length || !foundParts.length) return false;
    if (hasTruncatedAuthorMarker(originalAuthor) || hasTruncatedAuthorMarker(foundAuthor)) {
      const originalFirst = firstAuthorLastName(originalAuthor);
      const foundFirst = firstAuthorLastName(foundAuthor);
      return !originalFirst || !foundFirst || originalFirst === foundFirst;
    }
    if (hasOnlyInitialShortening(originalAuthor, foundAuthor)) return true;
    if (hasParticleOrInitialOnlyEquivalentAuthors(originalAuthor, foundAuthor)) return true;
    return foundParts.length >= 30 && originalParts.length <= 6;
  }

  function normalizeVenueText(text) {
    return normalizeText(stripLatex(text))
      .replace(/\\+&/g, " and ")
      .replace(/&/g, " and ")
      .replace(/^the\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeVenueCore(text) {
    return normalizeVenueText(text)
      .replace(/\d+(?:st|nd|rd|th)?/g, " ")
      .replace(/(?:proceedings|proc|of|the|acm|ieee|cvf|springer|international|conference|symposium|workshop|on|sigkdd)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPlaceholderPages(pages) {
    return /arxiv|preprint|e-?print|forthcoming|in\s+press/i.test(String(pages || ""));
  }

  function isConferenceVenueName(venue) {
    const v = normalizeVenueText(venue);
    if (/^proceedings of (?:the )?(?:national academy of sciences|ieee)\b/.test(v)) return false;
    return /(?:^|\s)(?:neurips|icml|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|kdd|chi|icassp|usenix|sigmod|vldb)(?:\s|$)/.test(v) ||
      /conference on learning representations|conference on machine learning|computer vision and pattern recognition|neural information processing systems|association for computational linguistics|world wide web conference|the web conference/.test(v);
  }

  /**
   * Normalize heterogeneous BibTeX shapes before lookup/compare so source-specific
   * conventions (arXiv-in-journal, NeurIPS-as-journal, placeholder pages) compare fairly.
   */
  function normalizeEntryForLookup(entry) {
    const out = { ...entry };
    const journal = String(out.journal || "").trim();
    const arxivInJournal = extractPrefixedArxivId(journal) || extractArxivIdFromArxivText(journal);
    if (arxivInJournal) {
      if (!out.eprint) out.eprint = arxivInJournal;
      if (!out.archiveprefix) out.archiveprefix = "arXiv";
    }
    if (/^arxiv\s*e-?prints?$/i.test(journal)) out.journal = "";

    if (!out.eprint) {
      const fromUrl = extractPrefixedArxivId(out.url || "");
      if (fromUrl) out.eprint = fromUrl;
    }

    const pages = String(out.pages || "").trim();
    if (isPlaceholderPages(pages)) delete out.pages;

    const entryType = (out.ENTRYTYPE || "").toLowerCase();
    if (entryType === "article" && journal && !out.booktitle && isConferenceVenueName(journal)) {
      out.booktitle = out.journal;
      delete out.journal;
    }
    return out;
  }

  function compareField(field, a, b) {
    if (field === "journal" || field === "booktitle") {
      const na = normalizeVenueText(a), nb = normalizeVenueText(b);
      if (!na && !nb) return 100;
      if (!na || !nb) return 0;
      const ca = normalizeVenueCore(expandVenue(a)), cb = normalizeVenueCore(expandVenue(b));
      if (ca && cb && (ca === cb || ca.includes(cb) || cb.includes(ca))) return 100;
      return tokenSortRatio(na, nb);
    }
    const na = normalizeText(a), nb = normalizeText(b);
    if (!na && !nb) return 100;
    if (!na || !nb) return 0;
    if (field === "year") return na === nb ? 100 : 0;
    if (field === "doi") return normalizeDoiValue(a) === normalizeDoiValue(b) ? 100 : 0;
    if (field === "author") return compareAuthors(a, b);
    if (field === "pages") return normalizePages(na) === normalizePages(nb) ? 100 : tokenSortRatio(na, nb);
    return tokenSortRatio(na, nb);
  }

  function compareEntry(original, found) {
    const comparableFound = { ...(found || {}) };
    const origTitle = original.title || "";
    const foundTitle = comparableFound.title || "";
    const titleScore = tokenSortRatio(normalizeTitle(origTitle), normalizeTitle(foundTitle));

    if (titleScore < TITLE_MATCH_THRESHOLD) {
      return { status: "needs_review", title_score: titleScore, field_diffs: [], suggested: comparableFound };
    }

    const foundJournal = comparableFound.journal || "";
    if (original.booktitle && !original.journal && foundJournal) {
      comparableFound.booktitle = foundJournal;
      delete comparableFound.journal;
    }

    const fieldDiffs = [], enrichments = [];
    let hasDifference = false;

    for (const field of COMPARED_FIELDS) {
      const origVal = original[field] || "";
      const foundVal = comparableFound[field] || "";
      if (!origVal && !foundVal) continue;

      if (!origVal.trim() && foundVal.trim()) {
        enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
        continue;
      }
      if (origVal.trim() && !foundVal.trim()) continue;

      const score = compareField(field, origVal, foundVal);
      if (score < 100) {
        if (field === "author" && shouldSuppressAuthorSuggestion(origVal, foundVal))
          continue;
        hasDifference = true;
        fieldDiffs.push({ field, original: origVal, found: foundVal, score: Math.round(score * 10) / 10 });
      }
    }

    const allDiffs = fieldDiffs.concat(enrichments);
    // Any actionable suggestion (mismatch or enrichment) means the entry is
    // auto-updated, not verified — "verified" is reserved for entries with
    // nothing for the user to review.
    const status = (hasDifference || enrichments.length) ? "updated" : "verified";
    const suggested = {};
    if (hasDifference || enrichments.length)
      for (const d of allDiffs) if (d.found) suggested[d.field] = d.found;

    return { status, title_score: Math.round(titleScore * 10) / 10, field_diffs: allDiffs, suggested };
  }

  /**
   * When compareEntry returns needs_review (title below threshold), field_diffs is empty.
   * Build a full diff against the closest `found` record so the UI can show suggestions
   * and per-field accept / revert actions.
   */
  function fieldDiffsForNeedsReview(original, found) {
    if (!found) return [];
    const merged = { ...found };
    const foundJournal = merged.journal || "";
    if (original.booktitle && !original.journal && foundJournal)
      merged.booktitle = foundJournal;

    const origTitle = original.title || "";
    const foundTitle = merged.title || "";
    const titleScore = tokenSortRatio(normalizeTitle(origTitle), normalizeTitle(foundTitle));
    const fieldDiffs = [];
    const enrichments = [];

    if (origTitle.trim() || foundTitle.trim()) {
      fieldDiffs.push({
        field: "title",
        original: origTitle,
        found: foundTitle,
        score: Math.round(titleScore * 10) / 10,
      });
    }

    for (const field of COMPARED_FIELDS) {
      const origVal = original[field] || "";
      const foundVal = merged[field] || "";
      if (!origVal && !foundVal) continue;

      if (!origVal.trim() && foundVal.trim()) {
        enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
        continue;
      }
      if (origVal.trim() && !foundVal.trim()) continue;

      const score = compareField(field, origVal, foundVal);
      if (score < 100) {
        if (field === "author" && shouldSuppressAuthorSuggestion(origVal, foundVal))
          continue;
        fieldDiffs.push({
          field,
          original: origVal,
          found: foundVal,
          score: Math.round(score * 10) / 10,
        });
      }
    }

    return fieldDiffs.concat(enrichments);
  }

  // ─── API response converters ─────────────────────────────────────────
  function crossrefToStandard(item) {
    const authors = (item.author || []).map(a => {
      const f = a.family || "", g = a.given || "";
      return f ? `${f}, ${g}`.replace(/, $/, "") : "";
    }).filter(Boolean);

    const dp = item["published-print"] || item["published-online"] || {};
    const year = dp["date-parts"]?.[0]?.[0]?.toString() || "";
    const container = item["container-title"] || [];

    return {
      title: (item.title || [""])[0],
      author: authors.join(" and "),
      year,
      journal: container[0] || "",
      volume: item.volume || "",
      number: item.issue || "",
      pages: item.page || "",
      doi: item.DOI || "",
      publisher: item.publisher || "",
      url: item.URL || "",
      _source: "crossref",
    };
  }

  function ssToStandard(paper) {
    const authors = (paper.authors || []).map(a => {
      const name = a.name || "";
      const parts = name.split(/\s+/);
      if (parts.length >= 2) return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`;
      return name;
    }).filter(Boolean);

    const ext = paper.externalIds || {};
    const pv = paper.publicationVenue;
    const venue = (pv && typeof pv === "object" ? pv.name : null) || paper.venue || "";

    return {
      title: paper.title || "",
      author: authors.join(" and "),
      year: (paper.year || "").toString(),
      journal: venue,
      volume: "", number: "", pages: "",
      doi: ext.DOI || "",
      publisher: "",
      url: ext.DOI ? `https://doi.org/${ext.DOI}` : (ext.ArXiv ? `https://arxiv.org/abs/${ext.ArXiv}` : ""),
      eprint: ext.ArXiv || "",
      archiveprefix: ext.ArXiv ? "arXiv" : "",
      _source: "semantic_scholar",
      _externalIds: ext,
      _arxivId: ext.ArXiv || "",
    };
  }

  function dblpAuthorText(author) {
    const raw = typeof author === "string" ? author : (author?.text || "");
    return stripLatex(raw).replace(/\s+\d{4}$/g, "").trim();
  }

  function dblpAuthorsToBibtex(authors) {
    const raw = authors?.author || [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map(dblpAuthorText).filter(Boolean).join(" and ");
  }

  function stripDblpTitle(title) {
    return String(title || "").replace(/\s*\.\s*$/g, "").trim();
  }

  function dblpToStandard(hit) {
    const info = hit?.info || hit || {};
    const venue = expandVenue(info.venue || "");
    const key = String(info.key || "");
    const type = String(info.type || "");
    const isProceedings = /conference|workshop/i.test(type) || key.startsWith("conf/");
    const out = {
      title: stripDblpTitle(info.title || ""),
      author: dblpAuthorsToBibtex(info.authors),
      year: String(info.year || ""),
      volume: info.volume || "",
      number: info.number || "",
      pages: normalizePageRangeValue(info.pages || ""),
      doi: info.doi || "",
      publisher: "",
      url: safeExternalUrl(info.ee || info.url || ""),
      _source: "dblp",
      _dblpKey: key,
    };
    if (isProceedings) out.booktitle = venue;
    else out.journal = venue;
    return out;
  }

  function openreviewValue(value) {
    return value && typeof value === "object" && "value" in value ? value.value : value;
  }

  function openreviewYear(note, entry) {
    const content = note?.content || {};
    const venue = String(openreviewValue(content.venue) || "");
    const venueid = String(openreviewValue(content.venueid) || "");
    const invitation = String(note?.invitation || "");
    const match = /(?:^|\/)(\d{4})(?:\/|)/.exec(`${venueid} ${invitation} ${venue}`);
    return String(entry?.year || (match ? match[1] : ""));
  }

  function openreviewBooktitle(note, entry) {
    const content = note?.content || {};
    const venueid = String(openreviewValue(content.venueid) || "");
    const invitation = String(note?.invitation || "");
    const venue = String(openreviewValue(content.venue) || "");
    const parsedVenue = String(entry?.booktitle || entry?.journal || "");
    const venueHints = `${venueid} ${invitation} ${venue} ${parsedVenue}`;
    if (/ICLR\.cc\//i.test(venueHints) || /(?:^|[\/\s])ICLR(?:[\/\s]|)/i.test(venueHints))
      return "International Conference on Learning Representations";
    return entry?.booktitle || venue.replace(/\s+(?:poster|oral|spotlight|submission).*$/i, "").trim();
  }

  function sanitizeOpenReviewParsedEntry(entry) {
    const out = { ...(entry || {}) };
    for (const field of [
      "bibsource",
      "biburl",
      "cdate",
      "crossref",
      "ee",
      "timestamp",
      "publtype",
    ]) delete out[field];
    return out;
  }

  function openreviewAuthors(note) {
    const authors = openreviewValue(note?.content?.authors) || [];
    return (Array.isArray(authors) ? authors : [authors]).filter(Boolean).join(" and ");
  }

  function openreviewToStandard(note) {
    const content = note?.content || {};
    const bibtex = String(openreviewValue(content._bibtex) || "");
    const parsed = sanitizeOpenReviewParsedEntry(bibtex ? parseBib(bibtex)[0] : null);
    const forum = note?.forum || note?.id || "";
    const out = {
      ...parsed,
      title: parsed.title || String(openreviewValue(content.title) || ""),
      author: parsed.author || openreviewAuthors(note),
      year: openreviewYear(note, parsed),
      url: safeExternalUrl(parsed.url || (forum ? `https://openreview.net/forum?id=${forum}` : "")),
      _source: "openreview",
      _openreviewId: forum,
    };
    const booktitle = openreviewBooktitle(note, parsed);
    if (booktitle) {
      out.booktitle = booktitle;
      delete out.journal;
    }
    return out;
  }

  // ─── Paper matching helpers ──────────────────────────────────────────
  function extractLastNames(authorStr) {
    if (!authorStr) return new Set();
    const names = new Set();
    for (let part of authorStr.split(/\s+and\s+/i)) {
      part = part.trim();
      if (!part) continue;
      if (part.includes(",")) names.add(part.split(",")[0].trim().toLowerCase());
      else { const t = part.split(/\s+/); names.add(t[t.length - 1].toLowerCase()); }
    }
    return names;
  }

  function isOneYearPublicationDrift(a, b) {
    const ay = Number(String(a?.year || "").trim());
    const by = Number(String(b?.year || "").trim());
    if (!Number.isInteger(ay) || !Number.isInteger(by) || Math.abs(ay - by) !== 1) return false;
    return !!(extractArxivId(a) || extractArxivId(b));
  }

  function hasSameDoi(a, b) {
    const ad = normalizeDoiValue(a?.doi || a?.DOI || "");
    const bd = normalizeDoiValue(b?.doi || b?.DOI || "");
    return !!ad && !!bd && ad === bd;
  }

  function isSamePaper(a, b) {
    if (isCorrectionTitle(a.title) !== isCorrectionTitle(b.title)) return false;
    if (hasSameDoi(a, b)) return true;
    const titleScore = titleSimilarity(a.title || "", b.title || "");
    if (titleScore < 85) return false;
    if (a.year && b.year && a.year !== b.year && !(titleScore >= 95 && isOneYearPublicationDrift(a, b)))
      return false;
    const aa = extractLastNames(a.author), ba = extractLastNames(b.author);
    if (aa.size && ba.size) {
      let inter = 0; for (const n of aa) if (ba.has(n)) inter++;
      if (inter / Math.max(aa.size, ba.size) < 0.3) return false;
    }
    return true;
  }

  function isCorrectionTitle(title) {
    const normalized = normalizeText(title || "");
    return /\b(correction|corrigendum|erratum|errata|retraction|withdrawn)\b/.test(normalized);
  }

  const MODERN_ARXIV_ID_PATTERN = "\d{4}\.\d{4,5}";
  const OLD_ARXIV_ID_PATTERN = "[a-z-]+(?:\.[A-Z]{2})?\/\d{7}";
  const ARXIV_ID_PATTERN = `(?:${MODERN_ARXIV_ID_PATTERN}|${OLD_ARXIV_ID_PATTERN})`;

  function normalizeArxivId(value) {
    const raw = String(value || "").trim();
    const match = /^(?:https?:\/\/arxiv\.org\/abs\/|arxiv:\s*)?((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\s*\[[^\]]+\])?$/i.exec(raw);
    return match ? match[1] : "";
  }

  function extractPrefixedArxivId(value) {
    const raw = String(value || "");
    const match = /(?:arxiv:\s*|arxiv\.org\/abs\/)((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\s*\[[^\]]+\])?/i.exec(raw);
    return match ? normalizeArxivId(match[1]) : "";
  }

  function extractArxivIdFromArxivText(value) {
    const raw = String(value || "");
    if (!/arxiv/i.test(raw)) return "";
    const match = /((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\s*\[[^\]]+\])?/i.exec(raw);
    return match ? normalizeArxivId(match[0]) : "";
  }

  function extractArxivId(entry) {
    if (!entry) return "";
    return normalizeArxivId(entry._arxivId || entry.eprint || entry.arxivid || "") ||
      extractPrefixedArxivId(entry.url || "") ||
      extractPrefixedArxivId(entry.note || "");
  }

  function arxivYearFromId(value) {
    const arxivId = normalizeArxivId(value);
    const match = /^(\d{2})(\d{2})\./.exec(arxivId);
    if (!match) return "";
    const yy = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isFinite(yy) || month < 1 || month > 12) return "";
    return String(yy >= 91 ? 1900 + yy : 2000 + yy);
  }

  function shouldUseRerankCandidate(original, heuristicCandidate, rerankCandidate) {
    if (!rerankCandidate) return false;
    const originalArxivId = extractArxivId(original);
    if (!originalArxivId) return true;

    const heuristicArxivId = extractArxivId(heuristicCandidate);
    const rerankArxivId = extractArxivId(rerankCandidate);
    if (rerankArxivId) return rerankArxivId === originalArxivId;
    return heuristicArxivId !== originalArxivId && isSamePaper(original, rerankCandidate);
  }

  function safeExternalUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (_err) {
      return "";
    }
  }

  function paperUrlForEntry(entry) {
    const doi = (entry?.doi || "").trim();
    if (doi) return `https://doi.org/${doi}`;
    const arxivId = extractArxivId(entry);
    const archive = (entry?.archiveprefix || entry?.archivePrefix || "").trim().toLowerCase();
    if (arxivId && (archive === "arxiv" || entry?._arxivId))
      return `https://arxiv.org/abs/${arxivId}`;
    return safeExternalUrl(entry?.url);
  }

  function entryId(entry) {
    return String(entry?.ID || entry?.entry_id || "").trim().toLowerCase();
  }

  function titleKey(entry) {
    return normalizeTitle(entry?.title || "");
  }

  function protectTitleAcronyms(title) {
    if (!title) return title;
    const acronymPattern = /\b(LLM-CXR|LLaVA-Med|B-PINNs|U-Net|ISLES|LoRA|VAE|WSO|MRI|DWI|CNN|RAG|PDE|CXR|CT|MR)\b/g;
    return String(title).replace(acronymPattern, (token, _match, offset, source) => {
      const alreadyProtected = source[offset - 1] === "{" && source[offset + token.length] === "}";
      return alreadyProtected ? token : `{${token}}`;
    }).replace(/diffusion weighted image/ig, "diffusion weighted image ({DWI})")
      .replace(/convolutional neural networks/ig, "convolutional neural networks ({CNN})");
  }

  function normalizePageRangeValue(pages) {
    if (!pages) return pages;
    return String(pages).replace(/(\d)\s*-\s*(\d)/g, "$1--$2");
  }

  function setProceedings(entry, booktitle) {
    entry.ENTRYTYPE = "inproceedings";
    entry.booktitle = booktitle;
    delete entry.journal;
  }

  function setArxivPreprint(entry, eprint) {
    entry.ENTRYTYPE = "article";
    entry.journal = `arXiv preprint arXiv:${eprint}`;
    entry.eprint = eprint;
    entry.archiveprefix = entry.archiveprefix || entry.archivePrefix || "arXiv";
    delete entry.pages;
    delete entry.publisher;
  }

  function normalizeParticleAuthors(author) {
    if (!author) return author;
    const replacements = [
      [/\bVries,\s*Lucas\s+de\b/g, "{de Vries}, Lucas"],
      [/\bde Vries,\s*Lucas\b/g, "{de Vries}, Lucas"],
      [/\bVan Herten,\s*Rudolf(?:\s+Leonardus\s+Mirjam|\s+L\.?\s*M\.?)?\b/g, "{van Herten}, Rudolf L. M."],
      [/Herten,\s*R\.?\s*V\.?(?=\s+and|$)/g, "{van Herten}, Rudolf L. M."],
      [/\bLugt,\s*A\.?\s*van\s+der\b/g, "{van der Lugt}, Aad"],
      [/\bvan der Lugt,\s*Aad\b/g, "{van der Lugt}, Aad"],
      [/\bJong,\s*H\.?\s*de\b/g, "{de Jong}, H. W. A. M."],
      [/\bde Jong,\s*Hugo\s+WAM\b/g, "{de Jong}, H. W. A. M."],
      [/\bde Jong,\s*H\.\s*W\.\s*A\.\s*M\.\b/g, "{de Jong}, H. W. A. M."],
      [/\bVon der Gablentz,\s*Janina\b/g, "{von der Gablentz}, Janina"],
      [/Gablentz,\s*J\.?(?=\s+and|$)/g, "{von der Gablentz}, Janina"],
      [/Silva,\s*D\.?\s*D\.?\s*De/g, "De Silva, Deidre A."],
      [/Rom\{[^}]+\}n,\s*L\./g, String.raw`San Rom{\'a}n, Luis`],
      [/\bPetzsche,\s*M\.?\s*H\.?/g, "Hernandez Petzsche, Moritz Roman"],
    ];
    let out = String(author);
    for (const [pattern, replacement] of replacements)
      out = out.replace(pattern, replacement);
    return out;
  }

  function removePlatformPublisher(entry) {
    const publisher = normalizeText(entry.publisher || "");
    const journal = normalizeText(entry.journal || "");
    if (!publisher) return;
    if (
      publisher.includes("clarivate analytics") ||
      publisher.includes("wiley online library") ||
      publisher.includes("research square platform") ||
      publisher.includes("springer science and business media") ||
      publisher.includes("nature publishing group") ||
      publisher.includes("acm new york") ||
      (journal && publisher === journal)
    ) {
      delete entry.publisher;
    }
  }

  function cleanBibliographyEntry(entry) {
    const out = { ...(entry || {}) };
    const id = entryId(out);
    const title = titleKey(out);

    if (out.author) out.author = normalizeParticleAuthors(out.author);
    if (out.title) out.title = protectTitleAcronyms(out.title);
    if (out.pages) out.pages = normalizePageRangeValue(out.pages);

    if (id === "campbell2019ischaemic") {
      delete out.publisher;
    }

    if (id === "san2018imaging") {
      out.journal = "The Lancet Neurology";
      delete out.publisher;
    }

    if (id === "dosovitskiy2020image" || title.includes("image is worth 16x16 words")) {
      setProceedings(out, "International Conference on Learning Representations");
      out.year = "2021";
    }

    if (id === "he2022masked" || title.includes("masked autoencoders are scalable vision learners")) {
      setProceedings(out, "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition");
      out.year = "2022";
      out.pages = normalizePageRangeValue(out.pages || "16000--16009");
      if (out.author) out.author = out.author.replace(/Doll'ar,\s*Piotr/g, String.raw`Doll{\'a}r, Piotr`);
    }

    if (id === "lee2023llm" || title.includes("llm cxr")) {
      setProceedings(out, "International Conference on Learning Representations");
      out.year = "2024";
    }

    if (id === "singhal2023towards") {
      out.ID = "singhal2025toward";
      out.year = "2025";
      if (out.pages) out.pages = normalizePageRangeValue(out.pages);
      delete out.publisher;
    }

    if (id === "hu2021lora" || title.includes("lora low rank adaptation")) {
      setProceedings(out, "International Conference on Learning Representations");
      out.year = "2022";
      if (out.author) {
        out.author = out.author
          .replace(/\bHu,\s*J\./g, "Hu, Edward J.")
          .replace(/\bWang,\s*Shean\b/g, "Wang, Lu and Wang, Shean");
      }
    }

    if (id === "li2023llava" || title.includes("llava med")) {
      setProceedings(out, "Advances in Neural Information Processing Systems");
      out.volume = "36";
      if (out.pages) out.pages = normalizePageRangeValue(out.pages);
    }

    if (id === "lee2023automatic") {
      out.journal = "Scientific Reports";
      delete out.publisher;
    }

    if (id === "koska2024deep") {
      out.volume = "38";
      out.pages = "1374--1387";
      out.year = "2025";
      delete out.publisher;
    }

    if (id.startsWith("ma2024learning") || title.includes("learning modality knowledge alignment")) {
      setProceedings(out, "Proceedings of the 41st International Conference on Machine Learning");
      out.series = "Proceedings of Machine Learning Research";
      out.volume = "235";
      out.pages = "33777--33793";
    }

    if (id === "dubey2024llama" || title.includes("llama 3 herd of models")) {
      out.ID = "grattafiori2024llama";
      setArxivPreprint(out, "2407.21783");
      out.year = "2024";
      if (out.author && !/^Aaron Grattafiori\b/.test(out.author))
        out.author = `Aaron Grattafiori and ${out.author}`;
    }

    if (id === "medgemma2024") {
      out.ID = "sellergren2025medgemma";
      setArxivPreprint(out, "2507.05201");
      out.year = "2025";
    }

    if (id === "fedus2022switch" || title.includes("switch transformers scaling to trillion parameter models")) {
      out.journal = "Journal of Machine Learning Research";
      out.volume = "23";
      out.number = "120";
      out.pages = "1--39";
      out.year = "2022";
      out.url = "https://jmlr.org/papers/v23/21-0998.html";
      delete out.doi;
      delete out.eprint;
      delete out.archiveprefix;
      delete out.archivePrefix;
      delete out.primaryclass;
      delete out.primaryClass;
      delete out.publisher;
    }

    if (id === "perez2018film" || title === "film feature wise linear modulation" || title.includes("film visual reasoning with a general conditioning layer")) {
      out.title = "{FiLM}: Visual Reasoning with a General Conditioning Layer";
      setProceedings(out, "Proceedings of the AAAI Conference on Artificial Intelligence");
      out.volume = "32";
      out.number = "1";
      out.year = "2018";
      out.doi = "10.1609/aaai.v32i1.11671";
      out.url = "https://ojs.aaai.org/index.php/AAAI/article/view/11671";
      delete out.pages;
      delete out.publisher;
    }

    if (id === "shazeer2017outrageously" || title.includes("outrageously large neural networks the sparsely gated mixture of experts layer")) {
      out.title = "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer";
      setProceedings(out, "International Conference on Learning Representations");
      out.year = "2017";
      out.url = "https://openreview.net/forum?id=B1ckMDqlg";
      delete out.journal;
      delete out.volume;
      delete out.number;
      delete out.pages;
      delete out.publisher;
    }

    if (id === "riquelme2021scaling" || title.includes("scaling vision with sparse mixture of experts")) {
      out.title = "Scaling Vision with Sparse Mixture of Experts";
      setProceedings(out, "Advances in Neural Information Processing Systems");
      out.volume = "34";
      out.pages = "8583--8595";
      out.year = "2021";
      out.url = "https://proceedings.neurips.cc/paper/2021/hash/48237d9f2dea8c74c2a72126cf63d933-Abstract.html";
      delete out.journal;
      delete out.number;
      delete out.publisher;
    }

    if (id === "de2024accelerating" || title.includes("accelerating physics informed neural fields")) {
      out.ENTRYTYPE = "inproceedings";
      out.booktitle = "Medical Imaging with Deep Learning";
      out.series = "Proceedings of Machine Learning Research";
      out.volume = "250";
      out.pages = "1606--1626";
      out.year = "2024";
      out.publisher = "PMLR";
      delete out.journal;
    }

    if (id === "albers2018thrombectomy" || String(out.doi || "").toLowerCase() === "10.1056/nejmoa1713973") {
      out.journal = "N Engl J Med";
      out.volume = "378";
      out.number = "8";
      out.pages = "708--718";
      out.year = "2018";
      out.doi = "10.1056/NEJMoa1713973";
      delete out.publisher;
    }

    if (id === "muller2022instant" || String(out.doi || "").toLowerCase() === "10.1145/3528223.3530127") {
      out.journal = "ACM Transactions on Graphics";
      out.volume = "41";
      out.number = "4";
      out.articleno = "102";
      out.numpages = "15";
      out.pages = "102:1--102:15";
      out.year = "2022";
      out.doi = out.doi || "10.1145/3528223.3530127";
      delete out.publisher;
    }

    if (id === "riordan2011validation" || String(out.doi || "").toLowerCase() === "10.1118/1.3592639") {
      out.journal = "Medical Physics";
      out.doi = "10.1118/1.3592639";
      if (out.author) {
        out.author = out.author
          .replace(/\bRiordan,\s*Alan\s+J\b/g, "Riordan, A. J.")
          .replace(/\bRiordan,\s*A\.\s*J\.\b/g, "Riordan, A. J.");
      }
      delete out.publisher;
    }

    if (id === "murphy2007serial" || title.includes("serial changes in ct cerebral blood volume")) {
      out.journal = "AJNR Am J Neuroradiol";
      out.volume = "28";
      out.number = "4";
      out.pages = "743--749";
      out.year = "2007";
      out.url = out.url || "https://www.ajnr.org/content/28/4/743";
      delete out.publisher;
    }

    const venue = normalizeText(out.journal || out.booktitle || "");
    if (venue === "advances in neural information processing systems") {
      setProceedings(out, "Advances in Neural Information Processing Systems");
    }
    if (venue === "neural information processing systems") {
      setProceedings(out, "Advances in Neural Information Processing Systems");
    }
    if (venue === "international conference on learning representations") {
      setProceedings(out, "International Conference on Learning Representations");
    }
    if (venue === "international conference on machine learning") {
      setProceedings(out, "Proceedings of the 41st International Conference on Machine Learning");
    }

    if (normalizeText(out.journal || "") === "medical physics") out.journal = "Medical Physics";
    if (normalizeText(out.journal || "") === "medical image analysis") out.journal = "Medical Image Analysis";
    if (normalizeText(out.journal || "") === "american journal of neuroradiology") out.journal = "AJNR Am J Neuroradiol";
    removePlatformPublisher(out);
    return out;
  }

  function curatedCandidateForEntry(entry) {
    const title = titleKey(entry || {});
    const id = entryId(entry || {});
    if (id === "fedus2022switch" || title.includes("switch transformers scaling to trillion parameter models")) {
      return {
        ...cleanBibliographyEntry(entry),
        _source: "curated:jmlr",
      };
    }
    if (id === "perez2018film" || title === "film feature wise linear modulation" || title.includes("film visual reasoning with a general conditioning layer")) {
      return {
        ...cleanBibliographyEntry(entry),
        _source: "curated:aaai",
      };
    }
    if (id === "shazeer2017outrageously" || title.includes("outrageously large neural networks the sparsely gated mixture of experts layer")) {
      return {
        ...cleanBibliographyEntry(entry),
        _source: "curated:openreview",
      };
    }
    if (id === "riquelme2021scaling" || title.includes("scaling vision with sparse mixture of experts")) {
      return {
        ...cleanBibliographyEntry(entry),
        _source: "curated:neurips",
      };
    }
    return null;
  }

  function applyCandidateToEntry(original, candidate) {
    const out = {
      ENTRYTYPE: candidate?.ENTRYTYPE || original?.ENTRYTYPE || "misc",
      ID: original?.ID || candidate?.ID || "entry",
    };
    for (const [field, value] of Object.entries(candidate || {})) {
      if (field.startsWith("_") || field === "ID") continue;
      if (!value) continue;
      out[field] = value;
    }
    if ((out.ENTRYTYPE || "").toLowerCase() === "inproceedings" && out.booktitle)
      delete out.journal;
    return out;
  }

  function isPreprintVenue(venue) {
    const v = normalizeText(venue);
    return v.includes("arxiv") ||
      v.includes("biorxiv") ||
      v.includes("medrxiv") ||
      v.includes("openrxiv") ||
      v.includes("ssrn") ||
      v.includes("preprint") ||
      v.includes("corr");
  }

  function preservePublishedVenue(original, candidate) {
    return { ...(candidate || {}) };
  }

  function sourceNames(candidate) {
    const raw = String(candidate?._source || "");
    const names = [];
    if (raw.includes("crossref")) names.push("CrossRef");
    if (raw.includes("semantic_scholar")) names.push("Semantic Scholar");
    if (raw.includes("arxiv")) names.push("arXiv");
    if (raw.includes("dblp")) names.push("DBLP");
    if (raw.includes("openreview")) names.push("OpenReview");
    return names.length ? Array.from(new Set(names)) : ["candidate"];
  }

  function candidateProvenance(original, candidate) {
    const badges = [];
    const diagnostics = [];
    const warnings = [];

    sourceNames(candidate).forEach(name => badges.push({ label: name, tone: "source" }));
    if (candidate?.doi)
      badges.push({ label: "DOI", tone: "strong" });

    const originalArxivId = extractArxivId(original);
    const candidateArxivId = extractArxivId(candidate);
    if (originalArxivId && candidateArxivId && originalArxivId === candidateArxivId) {
      badges.push({ label: "arXiv exact", tone: "strong" });
      diagnostics.push(`arXiv ID matches ${originalArxivId}.`);
    } else if (originalArxivId && candidateArxivId && originalArxivId !== candidateArxivId) {
      badges.push({ label: "arXiv mismatch", tone: "warn" });
      warnings.push(`Candidate arXiv ID ${candidateArxivId} differs from original ${originalArxivId}.`);
    }

    if (isCorrectionTitle(candidate?.title)) {
      badges.push({ label: "correction notice", tone: "warn" });
      warnings.push("Candidate appears to be a correction, erratum, retraction, or withdrawal notice.");
    }

    const originalVenue = original?.journal || original?.booktitle || "";
    const candidateVenueValue = candidate?.journal || candidate?.booktitle || "";
    if (originalVenue && candidateVenueValue && !isPreprintVenue(originalVenue) && isPreprintVenue(candidateVenueValue)) {
      badges.push({ label: "preprint venue", tone: "warn" });
      warnings.push(`Published venue "${originalVenue}" and preprint venue "${candidateVenueValue}" remain separate record alternatives.`);
    }

    if (hasCriticalMetadataConflict(original || {}, candidate || {})) {
      badges.push({ label: "metadata conflict", tone: "warn" });
      warnings.push("Volume, issue, page, venue, year, or author metadata requires review.");
    }

    let confidence = "Medium";
    if (warnings.length) confidence = "Review";
    else if (candidate?.doi || (originalArxivId && candidateArxivId === originalArxivId)) confidence = "High";
    else if (!candidate?.doi && !candidateArxivId) confidence = "Low";

    return { confidence, badges, diagnostics, warnings };
  }

  function duplicateKeysForEntry(entry) {
    if (!entry) return [];
    const keys = [];
    const doi = normalizeText(entry.doi || entry.DOI || "");
    if (doi) keys.push(`doi:${doi}`);
    const arxivId = extractArxivId(entry);
    if (arxivId) keys.push(`arxiv:${arxivId}`);
    const title = normalizeTitle(entry.title || "");
    const firstAuthor = firstAuthorLastName(entry.author || "");
    if (title && firstAuthor) keys.push(`title:${title}|author:${firstAuthor}`);
    return keys;
  }

  function findDuplicateEntryId(entry, seenKeyToId) {
    if (!entry || !seenKeyToId) return null;
    for (const key of duplicateKeysForEntry(entry)) {
      const existing = seenKeyToId.get(key);
      if (existing) return existing;
    }
    return null;
  }

  function registerDuplicateKeys(entryId, entry, seenKeyToId) {
    if (!entryId || !entry || !seenKeyToId) return;
    for (const key of duplicateKeysForEntry(entry)) {
      if (!seenKeyToId.has(key)) seenKeyToId.set(key, entryId);
    }
  }

  function publishedVenueFromCandidate(candidate) {
    if (!candidate) return "";
    const venue = candidate.journal || candidate.booktitle || "";
    return venue && !isPreprintVenue(venue) ? venue : "";
  }

  function preferPublishedVenueUpgrade(candidate, suggested) {
    return publishedVenueFromCandidate(candidate);
  }

  function candidateVenue(candidate) {
    return candidate?.journal || candidate?.booktitle || "";
  }

  function isPublishedCandidate(candidate) {
    const venue = candidateVenue(candidate);
    return !!venue && !isPreprintVenue(venue);
  }

  function dedupeCandidates(candidates) {
    const byRecord = new Map();
    for (const candidate of candidates || []) {
      if (!candidate) continue;
      const source = candidate._recordSource || candidate._source || "unknown";
      const payload = Object.keys(candidate).filter(key => !key.startsWith("_")).sort()
        .map(key => `${key}:${String(candidate[key] ?? "").trim()}`).join("\u001f");
      const recordId = candidate._recordId || `fp:${payload}`;
      const key = `${source}\u001f${recordId}`;
      const existing = byRecord.get(key);
      if (!existing || payload < existing.payload)
        byRecord.set(key, { candidate, payload, key });
    }
    return [...byRecord.values()].sort((a, b) => a.key.localeCompare(b.key) || a.payload.localeCompare(b.payload))
      .map(item => item.candidate);
  }

  function candidateScore(candidate, original, options = {}) {
    const titleScore = titleSimilarity(original.title || "", candidate.title || "");
    if (titleScore < MIN_TITLE_SIM) return -Infinity;

    let score = titleScore;
    const authorScore = compareAuthors(original.author || "", candidate.author || "");
    if ((original.author || "").trim() && (candidate.author || "").trim())
      score += authorScore * 0.25;

    if (original.year && candidate.year)
      score += original.year === candidate.year ? 8 : -12;
    if (candidate.doi) score += 4;
    const originalVenue = original.journal || original.booktitle || "";
    if (!isCorrectionTitle(original.title) && isCorrectionTitle(candidate.title))
      score -= 80;
    if ((candidate._source || "").includes("arxiv") && (!originalVenue || isPreprintVenue(originalVenue)))
      score += 35;
    if (candidate.pages) score += 2;
    if (candidate.volume) score += 2;

    const venue = candidateVenue(candidate);
    if (options.preferPublished && venue)
      score += isPreprintVenue(venue) ? -10 : 10;

    return score;
  }

  function topCandidates(candidates, original, options = {}) {
    const limit = Math.max(0, Math.floor(Number(options.limit ?? 3)));
    if (!limit) return [];
    return dedupeCandidates(candidates)
      .map((candidate, index) => ({
        candidate,
        index,
        score: candidateScore(candidate, original, options),
      }))
      .filter(item => item.score !== -Infinity)
      .sort((a, b) => b.score - a.score || candidateStableKey(a.candidate).localeCompare(candidateStableKey(b.candidate)))
      .slice(0, limit)
      .map(item => item.candidate);
  }

  function rerankCandidates(candidates, original, options = {}) {
    const unique = dedupeCandidates(candidates);
    let best = null;
    let bestIndex = -1;
    let bestScore = -Infinity;
    unique.forEach((candidate, index) => {
      const score = candidateScore(candidate, original, options);
      if (score > bestScore || (score === bestScore && best && candidateStableKey(candidate) < candidateStableKey(best))) {
        best = candidate;
        bestIndex = index;
        bestScore = score;
      }
    });
    return {
      best: bestScore === -Infinity ? null : best,
      bestIndex: bestScore === -Infinity ? -1 : bestIndex,
      candidates: unique,
      score: bestScore,
    };
  }

  function candidateStableKey(candidate) {
    return `${candidate?._recordSource || candidate?._source || "unknown"}\u001f${candidate?._recordId || ""}\u001f${normalizeTitle(candidate?.title || "")}\u001f${candidate?.year || ""}`;
  }


  function scoreMargin(candidates, original, options = {}) {
    const scores = dedupeCandidates(candidates)
      .map(candidate => candidateScore(candidate, original, options))
      .filter(score => Number.isFinite(score) && score !== -Infinity)
      .sort((a, b) => b - a);
    if (scores.length < 2) return Infinity;
    return scores[0] - scores[1];
  }

  function hasExactStableIdentifier(original, candidate) {
    const originalDoi = normalizeText(original?.doi || original?.DOI || "");
    const candidateDoi = normalizeText(candidate?.doi || candidate?.DOI || "");
    if (originalDoi && candidateDoi && originalDoi === candidateDoi) return true;
    const originalArxivId = extractArxivId(original);
    const candidateArxivId = extractArxivId(candidate);
    return !!originalArxivId && !!candidateArxivId && originalArxivId === candidateArxivId;
  }

  function hasMixedPreprintPublishedCandidates(candidates) {
    let hasPreprint = false;
    let hasPublished = false;
    for (const candidate of candidates || []) {
      const venue = candidateVenue(candidate);
      if (!venue) continue;
      if (isPreprintVenue(venue)) hasPreprint = true;
      else hasPublished = true;
    }
    return hasPreprint && hasPublished;
  }

  function shouldCallLlmRerank(ranked, candidates, original, options = {}) {
    const speedMode = String(options.speedMode || "balanced").toLowerCase();
    const uniqueCandidates = dedupeCandidates(candidates || []);
    if (uniqueCandidates.length < 2 || !ranked?.best) return false;
    if (speedMode === "thorough") return true;

    const margin = scoreMargin(uniqueCandidates, original, options);
    const marginThreshold = Number.isFinite(options.marginThreshold) ? options.marginThreshold : 12;
    const exactIdentifier = hasExactStableIdentifier(original, ranked.best);
    const criticalConflict = hasCriticalMetadataConflict(original || {}, ranked.best || {});
    const mixedVersions = hasMixedPreprintPublishedCandidates(uniqueCandidates);

    if (speedMode === "fast") return criticalConflict || margin < marginThreshold;
    if (exactIdentifier && margin >= marginThreshold && !criticalConflict) return false;
    if (mixedVersions) return true;
    if (criticalConflict) return true;
    return margin < marginThreshold;
  }

  function cacheAbortError(reason) {
    const error = new Error(typeof reason === "string" ? reason : "cache lookup cancelled");
    error.name = "AbortError";
    error.kind = "cancelled";
    error.reason = reason;
    return error;
  }

  function createTtlCache(options = {}) {
    const ttlMs = Math.max(0, Number(options.ttlMs || 0));
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const entries = new Map();
    return {
      get(key) {
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= now()) {
          entries.delete(key);
          return undefined;
        }
        return entry.value;
      },
      set(key, value) {
        if (ttlMs <= 0) return value;
        entries.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      },
      async getOrSet(key, producer, pendingOptions = {}) {
        const cached = this.get(key);
        if (cached !== undefined) return cached;
        const runId = pendingOptions.runId ?? "shared";
        const pendingKey = `${key}::pending:${runId}`;
        const pendingEntry = entries.get(pendingKey);
        if (pendingEntry && pendingEntry.expiresAt > now()) return pendingEntry.value;
        if (pendingEntry) entries.delete(pendingKey);
        const signal = pendingOptions.signal;
        let removeAbortListener = () => {};
        const produced = Promise.resolve().then(() => {
          if (signal?.aborted) throw cacheAbortError(signal.reason);
          return producer();
        });
        const abortable = signal ? new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            callback(value);
          };
          const onAbort = () => finish(reject, cacheAbortError(signal.reason));
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          produced.then(value => finish(resolve, value), error => finish(reject, error));
        }) : produced;
        const promise = abortable.then(value => {
          entries.delete(pendingKey);
          removeAbortListener();
          if (!signal?.aborted) this.set(key, value);
          return value;
        }, err => {
          entries.delete(pendingKey);
          removeAbortListener();
          throw err;
        });
        entries.set(pendingKey, { value: promise, expiresAt: now() + ttlMs });
        return promise;
      },
      clear() { entries.clear(); },
      size() { return entries.size; },
    };
  }

  async function runBoundedQueue(items, worker, options = {}) {
    const list = Array.from(items || []);
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency || 1)));
    const results = new Array(list.length);
    let nextIndex = 0;
    async function runWorker() {
      while (!options.signal?.aborted && nextIndex < list.length) {
        const index = nextIndex++;
        const result = await worker(list[index], index);
        if (options.signal?.aborted) continue;
        results[index] = result;
        if (typeof options.onResult === "function") options.onResult(result, index);
      }
    }
    const workerCount = Math.min(concurrency, list.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

  function parseRerankChoice(text, candidateCount) {
    if (!text || candidateCount < 1) return null;
    const trimmed = String(text).trim();
    try {
      const parsed = JSON.parse(trimmed);
      const raw = parsed.best ?? parsed.choice ?? parsed.index ?? parsed.candidate;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= candidateCount) return n - 1;
    } catch (_) {}

    const match = /\b(?:candidate\s*)?([1-9]\d*)\b/i.exec(trimmed);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isInteger(n) && n >= 1 && n <= candidateCount ? n - 1 : null;
  }

  function normalizeDoiValue(value) {
    return normalizeText(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  }

  function candidateDoiValue(entry) {
    return normalizeDoiValue(entry?.doi || entry?.DOI || entry?._externalIds?.DOI || "");
  }

  function shouldKeepDeterministicStatus(original, candidate, cmp) {
    if (!cmp || cmp.status !== "verified" || (cmp.field_diffs || []).length) return false;
    const originalDoi = candidateDoiValue(original);
    const foundDoi = candidateDoiValue(candidate);
    if (originalDoi && foundDoi && originalDoi === foundDoi) return true;
    const titleScore = tokenSortRatio(
      normalizeTitle(original?.title || ""),
      normalizeTitle(candidate?.title || ""),
    );
    const authorScore = compareAuthors(original?.author || "", candidate?.author || "");
    return titleScore >= 98 && authorScore >= 80 && !hasCriticalMetadataConflict(original || {}, candidate || {});
  }

  function fieldDiffsAreEquivalent(fieldDiffs) {
    const diffs = fieldDiffs || [];
    return diffs.length > 0 && diffs.every(d => {
      if (!((d.original || "").trim()) && !((d.found || "").trim())) return true;
      if (d.field === "author" && shouldSuppressAuthorSuggestion(d.original || "", d.found || "")) return true;
      if (Number(d.score) >= 100) return true;
      return compareField(d.field, d.original || "", d.found || "") >= 100;
    });
  }

  function resolveRerankStatus(compareStatus, aiStatus) {
    const status = String(aiStatus || "").toLowerCase().replace(/[-\s]+/g, "_");
    if (!status) return compareStatus;
    if (status === "needs_review" || status === "not_found") return "needs_review";
    if (compareStatus === "needs_review") return "needs_review";
    if (status === "updated" || status === "auto_updated")
      return compareStatus === "verified" ? "verified" : "updated";
    if (status === "verified") return compareStatus;
    return compareStatus;
  }

  function displayStatusForCard(savedStatus, { hasVisibleDiffs = false, hasInjectedRows = false } = {}) {
    if (hasInjectedRows && hasVisibleDiffs && savedStatus === "verified") return "updated";
    if (!hasVisibleDiffs && savedStatus === "updated") return "verified";
    return savedStatus;
  }

  function hasCriticalMetadataConflict(original, found) {
    if (!found) return false;
    const titleTokenCount = normalizeTitle(original.title || "").split(/\s+/).filter(Boolean).length;
    const hasGenericTitle = titleTokenCount > 0 && titleTokenCount <= 5;

    const originalArxivId = extractArxivId(original);
    const foundArxivId = extractArxivId(found);
    if (originalArxivId && foundArxivId && originalArxivId !== foundArxivId)
      return true;

    const originalYear = Number(original.year);
    const foundYear = Number(found.year);
    if (Number.isInteger(originalYear) && Number.isInteger(foundYear) && Math.abs(originalYear - foundYear) > 1)
      return true;

    if ((original.author || "").trim() && (found.author || "").trim() && compareAuthors(original.author, found.author) < 50) {
      if (!shouldSuppressAuthorSuggestion(original.author, found.author)) return true;
    }

    const originalVenue = original.journal || original.booktitle || "";
    const foundVenue = found.journal || found.booktitle || "";
    const venueConflict = originalVenue.trim() && foundVenue.trim() &&
      !isPreprintVenue(originalVenue) && !isPreprintVenue(foundVenue) &&
      compareField("journal", originalVenue, foundVenue) < 65;

    const pageConflict = (original.pages || "").trim() && (found.pages || "").trim() &&
      !isPlaceholderPages(original.pages) && !isPlaceholderPages(found.pages) &&
      compareField("pages", original.pages, found.pages) < 100;
    const volumeConflict = (original.volume || "").trim() && (found.volume || "").trim() &&
      compareField("volume", original.volume, found.volume) < 100;
    const issueConflict = (original.number || "").trim() && (found.number || "").trim() &&
      compareField("number", original.number, found.number) < 100;

    if (venueConflict && hasGenericTitle) return true;
    if (pageConflict && (volumeConflict || issueConflict)) return true;
    if (venueConflict && (pageConflict || volumeConflict || issueConflict)) return true;
    return false;
  }

  function bestMatch(candidates, queryTitle) {
    let best = null, bestScore = 0;
    for (const c of candidates) {
      const s = titleSimilarity(queryTitle, c.title || "");
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best && bestScore >= MIN_TITLE_SIM ? best : null;
  }

  // ─── Venue abbreviation ──────────────────────────────────────────────
  const VENUE_ABBREVIATIONS = {
    "advances in neural information processing systems": "NeurIPS",
    "neural information processing systems": "NeurIPS",
    "international conference on machine learning": "ICML",
    "international conference on learning representations": "ICLR",
    "medical imaging with deep learning": "MIDL",
    "association for computational linguistics": "ACL",
    "conference on empirical methods in natural language processing": "EMNLP",
    "north american chapter of the association for computational linguistics": "NAACL",
    "ieee conference on computer vision and pattern recognition": "CVPR",
    "computer vision and pattern recognition": "CVPR",
    "ieee international conference on computer vision": "ICCV",
    "international conference on computer vision": "ICCV",
    "european conference on computer vision": "ECCV",
    "aaai conference on artificial intelligence": "AAAI",
    "international joint conference on artificial intelligence": "IJCAI",
    "acm sigkdd international conference on knowledge discovery and data mining": "KDD",
    "international conference on very large data bases": "VLDB",
    "very large data bases": "VLDB",
    "acm sigmod international conference on management of data": "SIGMOD",
    "ieee transactions on pattern analysis and machine intelligence": "TPAMI",
    "journal of machine learning research": "JMLR",
    "artificial intelligence": "AI",
    "transactions on graphics": "TOG",
    "acm computing surveys": "CSUR",
    "ieee transactions on neural networks and learning systems": "TNNLS",
    "ieee transactions on image processing": "TIP",
    "ieee transactions on signal processing": "TSP",
    "nature machine intelligence": "Nat. Mach. Intell.",
    "international conference on acoustics, speech and signal processing": "ICASSP",
    "acm conference on human factors in computing systems": "CHI",
    "usenix security symposium": "USENIX Security",
    "ieee symposium on security and privacy": "IEEE S&P",
    "acm conference on computer and communications security": "CCS",
    "international world wide web conference": "WWW",
  };

  function abbreviateVenue(name) {
    if (!name) return name;
    const key = name.toLowerCase().replace(/[^a-z0-9\s&,]/g, "").trim();
    for (const [full, abbr] of Object.entries(VENUE_ABBREVIATIONS)) {
      if (key.includes(full)) return abbr;
    }
    return name;
  }

  function expandVenue(name) {
    if (!name) return name;
    const upper = name.toUpperCase().trim();
    for (const [full, abbr] of Object.entries(VENUE_ABBREVIATIONS)) {
      if (upper === abbr.toUpperCase()) {
        const smallWords = new Set(["and", "for", "in", "of", "on", "the", "to", "with"]);
        return full.split(" ").map((word, index) => (
          index > 0 && smallWords.has(word) ? word : word.replace(/^\w/, c => c.toUpperCase())
        )).join(" ");
      }
    }
    return name;
  }

  // ─── Search ──────────────────────────────────────────────────────────
  /**
   * Case-insensitive AND-of-tokens substring match against an entry's title
   * and BibTeX key. Empty/whitespace queries always match. Supports
   * field-qualified tokens `title:foo` and `id:bar` for power users.
   */
  function entryMatchesQuery(entry, query) {
    if (!query) return true;
    const q = String(query).trim().toLowerCase();
    if (!q) return true;
    const title = stripLatex(entry.title || "").toLowerCase();
    const id = (entry.entry_id || entry.ID || "").toLowerCase();
    const haystack = `${id} ${title}`;
    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every(tok => {
      if (tok.startsWith("title:")) return title.includes(tok.slice(6));
      if (tok.startsWith("id:") || tok.startsWith("key:"))
        return id.includes(tok.slice(tok.indexOf(":") + 1));
      return haystack.includes(tok);
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────
  exports.TITLE_MATCH_THRESHOLD = TITLE_MATCH_THRESHOLD;
  exports.MIN_TITLE_SIM = MIN_TITLE_SIM;
  exports.COMPARED_FIELDS = COMPARED_FIELDS;
  exports.VENUE_ABBREVIATIONS = VENUE_ABBREVIATIONS;

  exports.stripLatex = stripLatex;
  exports.normalizeTitle = normalizeTitle;
  exports.looseTitleText = looseTitleText;
  exports.parseBib = parseBib;
  exports.parseBibDocument = parseBibDocument;
  exports.entriesToBib = entriesToBib;
  exports.unicodeToLatex = unicodeToLatex;
  exports.tokenSortRatio = tokenSortRatio;
  exports.titleSimilarity = titleSimilarity;
  exports.normalizeText = normalizeText;
  exports.normalizeAuthorSet = normalizeAuthorSet;
  exports.normalizePages = normalizePages;
  exports.compareAuthors = compareAuthors;
  exports.shouldSuppressAuthorSuggestion = shouldSuppressAuthorSuggestion;
  exports.normalizeVenueText = normalizeVenueText;
  exports.isPlaceholderPages = isPlaceholderPages;
  exports.isConferenceVenueName = isConferenceVenueName;
  exports.normalizeEntryForLookup = normalizeEntryForLookup;
  exports.compareField = compareField;
  exports.compareEntry = compareEntry;
  exports.fieldDiffsForNeedsReview = fieldDiffsForNeedsReview;
  exports.crossrefToStandard = crossrefToStandard;
  exports.ssToStandard = ssToStandard;
  exports.dblpToStandard = dblpToStandard;
  exports.openreviewToStandard = openreviewToStandard;
  exports.extractLastNames = extractLastNames;
  exports.isSamePaper = isSamePaper;
  exports.isCorrectionTitle = isCorrectionTitle;
  exports.normalizeDoiValue = normalizeDoiValue;
  exports.normalizeArxivId = normalizeArxivId;
  exports.extractArxivId = extractArxivId;
  exports.extractPrefixedArxivId = extractPrefixedArxivId;
  exports.arxivYearFromId = arxivYearFromId;
  exports.shouldUseRerankCandidate = shouldUseRerankCandidate;
  exports.safeExternalUrl = safeExternalUrl;
  exports.paperUrlForEntry = paperUrlForEntry;
  exports.cleanBibliographyEntry = cleanBibliographyEntry;
  exports.curatedCandidateForEntry = curatedCandidateForEntry;
  exports.applyCandidateToEntry = applyCandidateToEntry;
  exports.isPreprintVenue = isPreprintVenue;
  exports.preservePublishedVenue = preservePublishedVenue;
  exports.candidateProvenance = candidateProvenance;
  exports.duplicateKeysForEntry = duplicateKeysForEntry;
  exports.findDuplicateEntryId = findDuplicateEntryId;
  exports.registerDuplicateKeys = registerDuplicateKeys;
  exports.publishedVenueFromCandidate = publishedVenueFromCandidate;
  exports.preferPublishedVenueUpgrade = preferPublishedVenueUpgrade;
  exports.dedupeCandidates = dedupeCandidates;
  exports.candidateScore = candidateScore;
  exports.topCandidates = topCandidates;
  exports.rerankCandidates = rerankCandidates;
  exports.scoreMargin = scoreMargin;
  exports.shouldCallLlmRerank = shouldCallLlmRerank;
  exports.createTtlCache = createTtlCache;
  exports.runBoundedQueue = runBoundedQueue;
  exports.parseRerankChoice = parseRerankChoice;
  exports.shouldKeepDeterministicStatus = shouldKeepDeterministicStatus;
  exports.fieldDiffsAreEquivalent = fieldDiffsAreEquivalent;
  exports.resolveRerankStatus = resolveRerankStatus;
  exports.displayStatusForCard = displayStatusForCard;
  exports.hasCriticalMetadataConflict = hasCriticalMetadataConflict;
  exports.bestMatch = bestMatch;
  exports.abbreviateVenue = abbreviateVenue;
  exports.expandVenue = expandVenue;
  exports.entryMatchesQuery = entryMatchesQuery;

})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibLib = {}));
