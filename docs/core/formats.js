/*
 * Reference-manager inputs: RIS and MEDLINE / PubMed (.nbib) exports are
 * detected on paste or upload and converted to BibTeX entries, which the
 * normal pipeline then verifies and exports as BibTeX. DOM-free.
 */
import { entriesToBib } from "./bibtex.js?v=20261011-s14";
import { pubmedAuthorName, pubmedPages, pubmedTitle, significantTitleWords } from "./pubmed.js?v=20261011-s14";
import {
  authorNames, foldText, normalizeDoi, normalizePmcid, normalizePmid, parseYear, pmcidInText, pmidInText,
} from "./text.js?v=20261011-s14";

  // ─── Detection ─────────────────────────────────────────────────────
  // RIS: a "TY  - " line; MEDLINE: a "PMID- " line. Text with a BibTeX entry
  // (@type{ or @type( at a line start) is BibTeX whatever else it holds.
  function detectFormat(text) {
    const source = String(text ?? "").replace(/^﻿/, "");
    if (/^\s*@[A-Za-z]+\s*[{(]/m.test(source)) return "";
    if (/^TY {2}- /m.test(source)) return "ris";
    if (/^PMID- /m.test(source)) return "medline";
    return "";
  }

  // ─── Tagged records ────────────────────────────────────────────────
  // Each record as [tag, value] pairs in order. A line without a tag
  // continues the previous value (MEDLINE indents continuations by six
  // spaces; RIS rarely wraps).
  function taggedRecords(text, tagLine, starts, ends) {
    const records = [];
    let current = null;
    for (const raw of String(text ?? "").replace(/^﻿/, "").split(/\r\n?|\n/)) {
      const match = tagLine.exec(raw);
      if (match) {
        const [, tag, value = ""] = match;
        if (tag === starts) {
          current = [];
          records.push(current);
        }
        if (!current) continue;
        if (ends && tag === ends) {
          current = null;
          continue;
        }
        current.push([tag, value.trim()]);
      } else if (current?.length && raw.trim()) {
        const last = current.at(-1);
        last[1] = `${last[1]} ${raw.trim()}`.trim();
      }
    }
    return records.filter(record => record.length);
  }

  const values = (record, ...tags) => record.filter(([tag]) => tags.includes(tag)).map(([, value]) => value).filter(Boolean);
  const first = (record, ...tags) => {
    for (const tag of tags) {
      const value = values(record, tag)[0];
      if (value) return value;
    }
    return "";
  };

  // ─── RIS ───────────────────────────────────────────────────────────
  const RIS_TYPES = {
    JOUR: "article", JFULL: "article", EJOUR: "article", MGZN: "article", NEWS: "article", ABST: "article", INPR: "article",
    CONF: "inproceedings", CPAPER: "inproceedings",
    BOOK: "book", EBOOK: "book", EDBOOK: "book",
    CHAP: "incollection", ECHAP: "incollection",
    THES: "phdthesis", RPRT: "techreport", UNPB: "unpublished",
  };

  function parseRis(text) {
    return taggedRecords(text, /^([A-Z][A-Z0-9]) {2}-(?: (.*))?$/, "TY", "ER");
  }

  // "Smith JA" (PubMed style, no comma) → "Smith, J. A."; other names as written.
  function risAuthor(name) {
    return !name.includes(",") && /\s\p{Lu}{1,4}$/u.test(name) ? pubmedAuthorName(name) : name;
  }

  function risPages(record) {
    const start = first(record, "SP");
    const end = first(record, "EP");
    if (start && end && start !== end) return pubmedPages(`${start}-${end}`);
    return start ? pubmedPages(start) : "";
  }

  function risToEntry(record) {
    const type = RIS_TYPES[first(record, "TY").toUpperCase()] || "misc";
    const container = first(record, "T2", "JF", "JO", "JA", "J2", "J1", "BT");
    const notes = values(record, "N1", "M1", "M2", "AN", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "UR", "L1", "L2").join(" ");
    const database = first(record, "DB", "DP");
    const accession = first(record, "AN");
    return {
      ENTRYTYPE: type,
      title: first(record, "TI", "T1", "CT"),
      author: values(record, "AU", "A1").map(risAuthor).join(" and "),
      ...(type === "inproceedings" || type === "incollection" ? { booktitle: container } : { journal: container }),
      year: yearText(first(record, "PY", "Y1", "DA")),
      volume: first(record, "VL"),
      number: first(record, "IS"),
      pages: risPages(record),
      doi: normalizeDoi(first(record, "DO")),
      pmid: pmidInText(notes) || (/pubmed|medline/i.test(database) ? normalizePmid(accession) : ""),
      pmcid: pmcidInText(notes) || normalizePmcid(/\bPMC\d+\b/.exec(notes)?.[0]),
    };
  }

  // ─── MEDLINE / PubMed (.nbib) ──────────────────────────────────────
  function parseMedline(text) {
    return taggedRecords(text, /^([A-Z][A-Z0-9]{0,3}) *- (.*)$/, "PMID", "");
  }

  // Authors in order: full names (FAU) when the record has them, else the
  // short form (AU, "Smith JA"); collective names (CN) braced.
  function medlineAuthors(record) {
    const full = record.some(([tag]) => tag === "FAU");
    return record.filter(([tag]) => tag === "CN" || tag === (full ? "FAU" : "AU"))
      .map(([tag, value]) => tag === "CN" ? pubmedAuthorName(value, true) : full ? value : pubmedAuthorName(value))
      .filter(Boolean).join(" and ");
  }

  function medlineDoi(record) {
    const tagged = values(record, "AID", "LID").find(value => /\[doi\]\s*$/i.test(value));
    return tagged ? normalizeDoi(tagged.replace(/\s*\[doi\]\s*$/i, "")) : "";
  }

  function medlineToEntry(record) {
    const types = values(record, "PT").map(type => type.toLowerCase());
    const book = !first(record, "TI") && !!first(record, "BTI");
    return {
      ENTRYTYPE: book || types.includes("book") ? "book" : "article",
      title: pubmedTitle(first(record, "TI", "BTI")),
      author: medlineAuthors(record),
      journal: book ? "" : first(record, "JT", "TA"),
      year: yearText(first(record, "DP")),
      volume: first(record, "VI"),
      number: first(record, "IP"),
      pages: pubmedPages(first(record, "PG")),
      doi: medlineDoi(record),
      pmid: normalizePmid(first(record, "PMID")),
      pmcid: normalizePmcid(first(record, "PMC")),
    };
  }

  // ─── Citation keys ─────────────────────────────────────────────────
  function yearText(value) {
    const year = parseYear(value);
    return Number.isInteger(year) ? String(year) : "";
  }

  // The folded first-author family name + year + the first significant
  // title word (pubmed.significantTitleWords), e.g. "isensee2021nnu".
  function baseKey(entry) {
    const author = authorNames(entry.author).find(name => !name.others);
    const family = foldText(author?.family).replace(/[^a-z0-9]+/g, "");
    const word = significantTitleWords(entry.title)[0] || "";
    return `${family || "anon"}${entry.year || ""}${word}`;
  }

  // Keys de-duplicated with a/b/… suffixes on every repeat of a base key.
  function assignKeys(entries) {
    const bases = entries.map(baseKey);
    const counts = new Map();
    bases.forEach(base => counts.set(base, (counts.get(base) || 0) + 1));
    const seen = new Map();
    return entries.map((entry, index) => {
      const base = bases[index];
      if (counts.get(base) === 1) return { ...entry, ID: base };
      const position = seen.get(base) || 0;
      seen.set(base, position + 1);
      return { ...entry, ID: `${base}${suffix(position)}` };
    });
  }

  // 0 → "a", 25 → "z", 26 → "aa", …
  function suffix(position) {
    let out = "";
    for (let n = position; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(97 + (n % 26)) + out;
    return out;
  }

  // ─── Conversion ────────────────────────────────────────────────────
  const FIELD_ORDER = ["title", "author", "journal", "booktitle", "year", "volume", "number", "pages", "doi", "pmid", "pmcid"];

  function withoutEmptyFields(entry) {
    const out = { ENTRYTYPE: entry.ENTRYTYPE, ID: entry.ID };
    for (const field of FIELD_ORDER) if (String(entry[field] ?? "").trim()) out[field] = String(entry[field]).trim();
    return out;
  }

  // RIS or MEDLINE text → { format, count, entries, text } (text: BibTeX
  // from the BibTeX serializer, values written as plain text, i.e.
  // LaTeX-escaped outside identifier fields), or null for any other input
  // or one without a record that has a title.
  function convertToBibtex(text) {
    const format = detectFormat(text);
    if (!format) return null;
    const records = format === "ris" ? parseRis(text).map(risToEntry) : parseMedline(text).map(medlineToEntry);
    const entries = assignKeys(records.filter(entry => entry.title)).map(withoutEmptyFields);
    if (!entries.length) return null;
    // `original: {}` marks every value as converted plain text, not the user's LaTeX.
    return { format, count: entries.length, entries, text: entriesToBib(entries, { original: {} }) };
  }

export {
  detectFormat,
  parseRis,
  parseMedline,
  risToEntry,
  medlineToEntry,
  assignKeys,
  convertToBibtex,
};
