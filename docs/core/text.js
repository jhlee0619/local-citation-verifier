/*
 * Text normalisation shared by every core module: LaTeX/Unicode tables, the
 * ASCII-folded query form (foldText) and the Unicode comparison form
 * (matchFold) with the keys built on it (title, surname, venue), the one DOI
 * normaliser, the one anchored arXiv extractor, the one year parser, the one
 * core signature, and fuzzy similarity. DOM-free.
 *
 * The side-effect import installs the vendored fuzzball bundle as
 * globalThis.fuzzball, which tokenSortRatio reads.
 */
import "../vendor/fuzzball-2.2.3.umd.min.js?v=20261012-s17";

  // ─── Matching thresholds ───────────────────────────────────────────
  const TITLE_MATCH_THRESHOLD = 85;
  const MIN_TITLE_SIM = 70;
  // ─── LaTeX ⇄ Unicode ───────────────────────────────────────────────
  // One table, read in both directions: stripLatex (comparison, matching,
  // search queries) turns LaTeX into Unicode text; unicodeToLatex (the
  // export's LaTeX-escape setting) turns Unicode into LaTeX commands.
  const LATEX_ACCENTS = {
    "`": "̀", "'": "́", "^": "̂", "~": "̃", "=": "̄", u: "̆", ".": "̇",
    '"': "̈", r: "̊", H: "̋", v: "̌", d: "̣", c: "̧", k: "̨", b: "̱",
    textcommabelow: "̦",
  };
  const LATEX_LETTERS = {
    ss: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", o: "ø", O: "Ø", l: "ł", L: "Ł",
    dj: "đ", DJ: "Đ", dh: "ð", DH: "Ð", th: "þ", TH: "Þ", ng: "ŋ", NG: "Ŋ", i: "ı", j: "ȷ",
  };
  // Named symbols, including the escapes bibtex.js writes. Where several
  // names share a glyph, the first is the one unicodeToLatex writes.
  const LATEX_SYMBOLS = Object.fromEntries((
    "ldots … dots … textellipsis … textendash – textemdash — textquoteleft ‘ textquoteright ’ " +
    "textquotedblleft “ textquotedblright ” guillemotleft « guillemotright » textexclamdown ¡ " +
    "textquestiondown ¿ textbackslash \\ textbraceleft { textbraceright } textasciitilde ~ " +
    "textasciicircum ^ textunderscore _ textdollar $ textless < textgreater > textbar | " +
    "textregistered ® texttrademark ™ copyright © textcopyright © textdegree ° S § textsection § " +
    "P ¶ textparagraph ¶ dag † textdagger † ddag ‡ textdaggerdbl ‡ textbullet • textmu µ " +
    "pounds £ textsterling £ texteuro € euro € textyen ¥ textcent ¢ textperthousand ‰ " +
    "times × pm ± mp ∓ div ÷ cdot · leq ≤ le ≤ geq ≥ ge ≥ neq ≠ approx ≈ sim ∼ simeq ≃ equiv ≡ " +
    "ll ≪ gg ≫ propto ∝ infty ∞ to → rightarrow → leftarrow ← leftrightarrow ↔ Rightarrow ⇒ " +
    "Leftrightarrow ⇔ ell ℓ hbar ℏ partial ∂ nabla ∇ sum ∑ prod ∏ int ∫ sqrt √ in ∈ notin ∉ " +
    "subset ⊂ subseteq ⊆ cup ∪ cap ∩ forall ∀ exists ∃ emptyset ∅ neg ¬ wedge ∧ vee ∨ perp ⊥ " +
    "oplus ⊕ otimes ⊗ prime ′ " +
    "alpha α beta β gamma γ delta δ varepsilon ε epsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι " +
    "kappa κ lambda λ mu μ nu ν xi ξ pi π rho ρ varrho ϱ sigma σ varsigma ς tau τ upsilon υ " +
    "varphi φ phi φ chi χ psi ψ omega ω Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ " +
    "Upsilon Υ Phi Φ Psi Ψ Omega Ω"
  ).split(" ").flatMap((word, index, words) => index % 2 ? [] : [[word, words[index + 1]]]));
  // Logos are words: the space after them stays.
  const LATEX_LOGOS = { LaTeX: "LaTeX", LaTeXe: "LaTeX2e", TeX: "TeX", BibTeX: "BibTeX", XeTeX: "XeTeX", LuaTeX: "LuaTeX", AmS: "AMS" };
  // Literal characters produced mid-way are parked in the private-use area so
  // the later brace, math, tilde and command passes leave them alone.
  const PARKED = { "\\": "", "{": "", "}": "", "$": "", "~": "" };
  const park = ch => PARKED[ch] || ch;
  const UNPARKED = Object.fromEntries(Object.entries(PARKED).map(([ch, parked]) => [parked, ch]));
  // An accent's base: {x}, a bare letter, or a dotless \i / \j, which (as a
  // control word) takes the following space with it.
  const SYMBOL_ACCENT = /\\([`'^"~=.])\s*(?:\{\s*(\\[ij](?![A-Za-z])|\p{L})\s*\}|(\\[ij])(?![A-Za-z]) ?|(\p{L}))/gu;
  const LETTER_ACCENT = /\\([uvHckrdb])(?:\s*\{\s*(\\[ij](?![A-Za-z])|\p{L})\s*\}|\s+(\\[ij])(?![A-Za-z]) ?|\s+(\p{L}))/gu;
  const WORD_ACCENT = /\\(textcommabelow)\s*\{\s*(\\[ij](?![A-Za-z])|\p{L})\s*\}/gu;
  const LETTER_COMMAND = new RegExp(`\\\\(${Object.keys(LATEX_LETTERS).join("|")})(?![A-Za-z])\\s*(?:\\{\\})?`, "g");
  const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

  function accented(_match, accent, braced, dotless, bare) {
    const base = braced || dotless || bare;
    return ((base === "\\i" ? "i" : base === "\\j" ? "j" : base) + LATEX_ACCENTS[accent]).normalize("NFC");
  }

  // The index of the brace closing the one at `open`, or -1.
  function matchingBrace(s, open) {
    for (let i = open, depth = 0; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) return i;
    }
    return -1;
  }

  // \href{target}{text} reads as its text.
  function dropHrefTargets(s) {
    let out = "";
    let cursor = 0;
    for (const match of s.matchAll(/\\href\s*\{/g)) {
      if (match.index < cursor) continue;
      const close = matchingBrace(s, match.index + match[0].length - 1);
      if (close < 0) break;
      out += s.slice(cursor, match.index);
      cursor = close + 1;
    }
    return out + s.slice(cursor);
  }

  // LaTeX → readable Unicode text for comparison: every accent spelling
  // (\"{u}, {\"u}, \"u, \'{\i}, \c c, \textcommabelow{s} …), special letters
  // (\o, \ss, \aa, \ng …), escaped specials, dashes, ~, named symbols and
  // Greek (a mapped control word takes one following space, as in TeX),
  // logos, \href text; $…$ delimiters are dropped but math stays readable;
  // other commands and braces are removed.
  function stripLatex(text) {
    if (!text) return "";
    let s = dropHrefTargets(String(text)).replace(/\\\\/g, " ")
      .replace(/\\([&%#_${}])/g, (_match, ch) => park(ch));
    for (let pass = 0; pass < 4; pass++) {
      const next = s.replace(SYMBOL_ACCENT, accented).replace(LETTER_ACCENT, accented).replace(WORD_ACCENT, accented);
      if (next === s) break;
      s = next;
    }
    s = s.replace(LETTER_COMMAND, (_match, name) => LATEX_LETTERS[name])
      .replace(/\\([A-Za-z]+)(\{\}| )?/g, (match, name, after) =>
        has(LATEX_LOGOS, name) ? LATEX_LOGOS[name] + (after === " " ? " " : "")
          : has(LATEX_SYMBOLS, name) ? park(LATEX_SYMBOLS[name]) : match)
      .replace(/\\([~^])\{\}/g, (_match, ch) => park(ch))
      .replace(/\$/g, "")
      .replace(/\\[a-zA-Z]+\s*/g, "")
      .replace(/\\[-/]/g, "")
      .replace(/\\[^]?/g, " ")
      .replace(/---/g, "—").replace(/--/g, "–").replace(/``/g, "“").replace(/''/g, "”")
      .replace(/~/g, " ")
      .replace(/[{}]/g, "")
      .replace(/[-]/g, ch => UNPARKED[ch]);
    return s.replace(/\s+/g, " ").trim();
  }

  // Non-ASCII codepoints become LaTeX (the export's LaTeX-escape setting):
  // accented letters → accent commands (\"{u}, \textcommabelow{s}), special
  // letters → {\o}, punctuation → --, ``, ~ …, and the table's symbols →
  // text commands (\textdegree{}, \texteuro{}, \S{} …) or, for Greek letters
  // and math symbols, \ensuremath{\alpha}, valid in text and math alike.
  // Anything else (CJK, Greek capitals without a command, rare symbols) stays
  // UTF-8. BibTeX specials are escaped by bibtex.js, not here.
  const LATEX_COMBINING_MAP = Object.fromEntries(
    Object.entries(LATEX_ACCENTS).map(([command, mark]) => [mark, `\\${command}`]));
  const LATEX_SPECIAL_MAP = Object.fromEntries(
    Object.entries(LATEX_LETTERS).map(([command, letter]) => [letter, `{\\${command}}`]));

  const LATEX_PUNCT_MAP = {
    "–": "--", "—": "---",
    "‘": "`", "’": "'", "“": "``", "”": "''",
    "…": "\\ldots{}", " ": "~", "­": "", " ": " ", " ": " ",
  };
  const TEXT_SYMBOL_COMMANDS = new Set(["S", "P", "dag", "ddag", "pounds", "copyright", "guillemotleft", "guillemotright"]);
  const LATEX_SYMBOL_MAP = {};
  for (const [name, glyph] of Object.entries(LATEX_SYMBOLS)) {
    if (glyph.codePointAt(0) <= 127 || has(LATEX_SYMBOL_MAP, glyph) || has(LATEX_PUNCT_MAP, glyph)) continue;
    LATEX_SYMBOL_MAP[glyph] = name.startsWith("text") || TEXT_SYMBOL_COMMANDS.has(name) ? `\\${name}{}` : `\\ensuremath{\\${name}}`;
  }

  function unicodeCharToLatex(ch) {
    if (LATEX_SPECIAL_MAP[ch]) return LATEX_SPECIAL_MAP[ch];
    if (LATEX_PUNCT_MAP[ch] !== undefined) return LATEX_PUNCT_MAP[ch];
    if (LATEX_SYMBOL_MAP[ch]) return LATEX_SYMBOL_MAP[ch];
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

  // options.quoted: the text sits in a "…" BibTeX value, where a bare '"'
  // would end the value, so a command holding \" is braced: {\"{\~{o}}}.
  function unicodeToLatex(text, options = {}) {
    let out = "";
    for (const ch of String(text || "").normalize("NFC")) {
      if (ch.codePointAt(0) <= 127) { out += ch; continue; }
      const latex = unicodeCharToLatex(ch);
      out += options.quoted && latex.includes('\\"') ? `{${latex}}` : latex;
    }
    return out;
  }

  // ─── HTML / JATS / MathML ──────────────────────────────────────────
  // Named entities that occur in bibliographic metadata: every Latin-1 and
  // Latin Extended-A letter (generated from its base letter and accent:
  // eacute, ccaron, odblac …), the Latin-1 signs, Greek letters, and common
  // punctuation and symbols. Numeric entities are decoded separately.
  const ENTITY_ACCENTS = {
    "̀": "grave", "́": "acute", "̂": "circ", "̃": "tilde", "̄": "macr", "̆": "breve",
    "̇": "dot", "̈": "uml", "̊": "ring", "̋": "dblac", "̌": "caron", "̧": "cedil", "̨": "ogon",
  };
  const GREEK_ENTITY_NAMES = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - " +
    "Sigma Tau Upsilon Phi Chi Psi Omega";
  const HTML_NAMED_ENTITIES = (() => {
    const table = {};
    const pairs = list => list.split(" ").forEach((word, index, words) => { if (!(index % 2)) table[word] = words[index + 1]; });
    // U+00A0–U+00BF in code point order.
    ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 " +
      "acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest")
      .split(" ").forEach((name, index) => { table[name] = String.fromCharCode(0xa0 + index); });
    for (let code = 0xc0; code <= 0x17f; code++) {
      const ch = String.fromCharCode(code);
      const [base, mark, extra] = ch.normalize("NFD");
      if (mark && !extra && ENTITY_ACCENTS[mark] && /[A-Za-z]/.test(base)) table[base + ENTITY_ACCENTS[mark]] ??= ch;
    }
    GREEK_ENTITY_NAMES.split(" ").forEach((name, index) => {
      if (name === "-") return;
      table[name] = String.fromCharCode(0x391 + index);
      table[name.toLowerCase()] = String.fromCharCode(0x3b1 + index);
    });
    pairs("amp & lt < gt > quot \" apos ' AElig Æ aelig æ ETH Ð eth ð THORN Þ thorn þ szlig ß Oslash Ø oslash ø " +
      "times × divide ÷ Dstrok Đ dstrok đ Hstrok Ħ hstrok ħ imath ı inodot ı IJlig Ĳ ijlig ĳ kgreen ĸ Lmidot Ŀ " +
      "lmidot ŀ Lstrok Ł lstrok ł napos ŉ ENG Ŋ eng ŋ OElig Œ oelig œ Tstrok Ŧ tstrok ŧ fnof ƒ " +
      "sigmaf ς thetasym ϑ vartheta ϑ upsih ϒ piv ϖ varpi ϖ epsiv ϵ varepsilon ϵ epsi ε phiv ϕ varphi ϕ " +
      "straightphi ϕ kappav ϰ rhov ϱ varrho ϱ varsigma ς " +
      "ensp   emsp   thinsp   hairsp   zwnj ‌ zwj ‍ lrm ‎ rlm ‏ " +
      "dash ‐ hyphen ‐ ndash – mdash — horbar ― lsquo ‘ rsquo ’ sbquo ‚ ldquo “ rdquo ” bdquo „ dagger † Dagger ‡ " +
      "bull • bullet • hellip … mldr … permil ‰ prime ′ Prime ″ lsaquo ‹ rsaquo › oline ‾ frasl ⁄ euro € " +
      "trade ™ TRADE ™ copy © COPY © reg ® REG ® larr ← uarr ↑ rarr → darr ↓ harr ↔ lArr ⇐ rArr ⇒ hArr ⇔ " +
      "minus − mnplus ∓ pm ± lowast ∗ radic √ infin ∞ le ≤ leq ≤ ge ≥ geq ≥ ne ≠ asymp ≈ approx ≈ equiv ≡ " +
      "sim ∼ sime ≃ cong ≅ ll ≪ gg ≫ sdot ⋅ sum ∑ prod ∏ part ∂ nabla ∇ isin ∈ notin ∉ ni ∋ cap ∩ cup ∪ " +
      "int ∫ there4 ∴ prop ∝ ang ∠ and ∧ or ∨ sub ⊂ sup ⊃ sube ⊆ supe ⊇ oplus ⊕ otimes ⊗ perp ⊥ " +
      "lceil ⌈ rceil ⌉ lfloor ⌊ rfloor ⌋ lang ⟨ rang ⟩ loz ◊ spades ♠ clubs ♣ hearts ♥ diams ♦ circ ˆ " +
      "tilde ˜ forall ∀ exist ∃ empty ∅ alefsym ℵ weierp ℘ image ℑ real ℜ ell ℓ hbar ℏ planck ℏ angst Å " +
      "ohm Ω star ☆ starf ★ check ✓ cross ✗ bsol \\ lowbar _ num # percnt % dollar $ excl ! quest ? " +
      "commat @ lpar ( rpar ) lsqb [ rsqb ] lbrack [ rbrack ] lcub { rcub } lbrace { rbrace } colon : semi ; " +
      "comma , period . sol / ast * plus + equals = verbar | vert | Hat ^ grave `");
    return Object.freeze(table);
  })();

  // Entity names are case-sensitive (&Eacute; ≠ &eacute;); an unknown
  // spelling falls back to its lower-case form (&AMP;, &Nbsp;).
  function decodeHtmlEntities(text) {
    return String(text || "").replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (match, body) => {
      if (body.startsWith("#")) {
        const key = body.toLowerCase();
        const n = key.startsWith("#x") ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return match;
        return String.fromCodePoint(n);
      }
      if (has(HTML_NAMED_ENTITIES, body)) return HTML_NAMED_ENTITIES[body];
      const lower = body.toLowerCase();
      return has(HTML_NAMED_ENTITIES, lower) ? HTML_NAMED_ENTITIES[lower] : match;
    });
  }

  // Crossref titles, container titles and names can carry HTML, JATS and
  // MathML markup (<i>, <sub>, <scp>, <italic>, <mml:mi>, <mi> …) and
  // entities; records store the text. A formula (<inline-formula>,
  // <disp-formula>, <alternatives>) keeps its <tex-math> when it has one,
  // else its MathML text, never both; MathML annotations are dropped.
  const PREFIX = "(?:[A-Za-z][\\w.-]*:)?";
  const MARKUP_TAG = new RegExp("<\\/?(?:[A-Za-z][\\w.-]*:[\\w.-]+|" +
    "i|b|em|strong|sub|sup|scp|sc|u|tt|span|font|br|p|div|small|big|a|abbr|cite|code|q|s|mark|wbr|" +
    "italic|bold|underline|overline|monospace|roman|sans-serif|strike|styled-content|named-content|" +
    "ext-link|uri|xref|label|break|email|inline-formula|disp-formula|alternatives|tex-math|" +
    "inline-graphic|graphic|math|mi|mo|mn|ms|mtext|mrow|msub|msup|msubsup|mfrac|msqrt|mroot|mover|" +
    "munder|munderover|mstyle|mspace|mpadded|mphantom|menclose|mfenced|mtable|mtr|mtd|mlabeledtr|" +
    "mmultiscripts|mprescripts|none|semantics|merror|mglyph)(?:\\s[^<>]*)?\\/?>", "gi");
  const FORMULA = new RegExp(`<(${PREFIX}(?:inline-formula|disp-formula|alternatives))\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, "gi");
  const TEX_MATH = new RegExp(`<${PREFIX}tex-math\\b[^>]*>([\\s\\S]*?)<\\/${PREFIX}tex-math\\s*>`, "gi");
  const ANNOTATION = new RegExp(`<(${PREFIX}annotation(?:-xml)?)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi");

  // TeX from <tex-math>: the body of a \documentclass wrapper, as $…$ math.
  function texMath(tex) {
    const body = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(tex);
    const s = (body ? body[1] : tex).trim();
    const wrapped = /^(?:\$\$([\s\S]*)\$\$|\\\[([\s\S]*)\\\]|\\\(([\s\S]*)\\\))$/.exec(s);
    if (wrapped) return `$${(wrapped[1] ?? wrapped[2] ?? wrapped[3]).trim()}$`;
    return !s || s.includes("$") ? s : `$${s}$`;
  }

  function formulaText(inner) {
    TEX_MATH.lastIndex = 0;
    const tex = TEX_MATH.exec(inner);
    return tex ? texMath(tex[1]) : inner.replace(ANNOTATION, " ");
  }

  function htmlToText(value) {
    const s = String(value ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(FORMULA, (_match, _tag, inner) => formulaText(inner))
      .replace(TEX_MATH, (_match, tex) => texMath(tex))
      .replace(ANNOTATION, " ")
      .replace(MARKUP_TAG, "");
    return decodeHtmlEntities(s).replace(/\s+/g, " ").trim();
  }

  // ─── Generic text ──────────────────────────────────────────────────
  function present(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  // Letters that NFD does not decompose into a base letter plus a mark.
  const FOLDED_LETTERS = { "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i", "ȷ": "j", "ŋ": "ng" };

  // The folded query form (the provider query builders and other ASCII
  // keys): LaTeX → Unicode (stripLatex), diacritics and special letters
  // folded to ASCII, lower-case, whitespace collapsed. Punctuation is kept.
  // Frozen: external tools reproduce the queries built on it. Comparisons use
  // matchFold.
  function foldText(value) {
    if (value === null || value === undefined) return "";
    return stripLatex(String(value)).normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[øßæœłđðþıȷŋ]/g, ch => FOLDED_LETTERS[ch])
      .replace(/\s+/g, " ").trim();
  }

  // Combining marks of the diacritic blocks (Latin, Greek, Cyrillic
  // accents). Other scripts' marks (Devanagari vowel signs, Hebrew points,
  // kana voicing marks) are part of their letters and stay.
  const DIACRITIC_MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;

  // The one comparison form: LaTeX → Unicode (stripLatex), compatibility
  // forms decomposed (NFKD: ligatures, full-width and superscript forms),
  // diacritics removed and special letters folded as in foldText,
  // lower-case, recomposed (NFC: Hangul syllables, kana), whitespace
  // collapsed. Letters of every script are kept, so Latin text folds as
  // before while Korean, Chinese, Cyrillic or Greek text keeps its words.
  function matchFold(value) {
    if (value === null || value === undefined) return "";
    return stripLatex(String(value)).normalize("NFKD").replace(DIACRITIC_MARKS, "")
      .toLowerCase().replace(/[øßæœłđðþıȷŋ]/g, ch => FOLDED_LETTERS[ch])
      .normalize("NFC").replace(/\s+/g, " ").trim();
  }

  // Runs of characters other than letters, digits and their marks.
  const NON_WORD = /[^\p{L}\p{N}\p{M}]+/gu;

  function normalizeEvidenceLanguage(value) {
    const lang = String(value || "").toLowerCase();
    return lang === "ko" || lang === "kor" || lang === "korean" ? "ko" : "en";
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

  // ─── Titles and notices ────────────────────────────────────────────
  // Greek letters (as LaTeX turns them into Unicode) become their names, so
  // "β-VAE" and "\beta-VAE" and "beta-VAE" share a key.
  const GREEK_NAMES = new Map();
  for (const [name, glyph] of Object.entries(LATEX_SYMBOLS)) {
    const lower = glyph.toLowerCase();
    if (/^\p{Script=Greek}$/u.test(lower) && !GREEK_NAMES.has(lower))
      GREEK_NAMES.set(lower, ` ${name.toLowerCase().replace(/^var/, "")} `);
  }

  // A Greek letter standing alone or in a pair (β-VAE, Aβ, γδ T cells) is a
  // symbol and is named; longer Greek runs are words and stay words.
  const GREEK_SYMBOL = /(?<!\p{Script=Greek})\p{Script=Greek}{1,2}(?!\p{Script=Greek})/gu;

  // The one title key (title comparison, duplicate keys, core signatures,
  // record fingerprints, cache keys): matchFold, Greek symbols named, every
  // run of characters other than letters, digits and marks collapsed to one
  // space. "β-VAE", "$\beta$-VAE" and "beta-VAE" share a key; a Korean or
  // Chinese title keeps its words.
  function titleKey(value) {
    return matchFold(value).replace(GREEK_SYMBOL, run => [...run].map(ch => GREEK_NAMES.get(ch) || " ").join(""))
      .replace(NON_WORD, " ").trim();
  }

  // The search-query title key (DBLP and OpenReview queries): foldText,
  // Greek letters named, every run of characters other than [a-z0-9]
  // collapsed to one space. Kept with the queries; comparisons use titleKey.
  function queryTitleKey(value) {
    return foldText(value).replace(/\p{Script=Greek}/gu, ch => GREEK_NAMES.get(ch) || " ")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }

  // A title that may be evidence on its own (same work, strong match,
  // duplicate): its key has a letter and at least two words. "2024",
  // "Introduction" or one unbroken run of Chinese characters needs an
  // identifier.
  function titleIsSpecific(title) {
    const key = titleKey(title);
    return /\p{L}/u.test(key) && key.split(" ").length >= 2;
  }

  function searchTitleTokens(title, options = {}) {
    const minLength = Number.isInteger(options.minLength) ? options.minLength : 3;
    const maxTokens = Number.isInteger(options.maxTokens) ? options.maxTokens : 8;
    const hyphenated = String(title || "").match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/g) || [];
    const loose = queryTitleKey(title).split(/\s+/).filter(Boolean);
    const seen = new Set();
    const tokens = [];
    for (const token of [...hyphenated, ...loose]) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      if (!token.includes("-") && token.length < minLength) continue;
      if (token.length < 2) continue;
      seen.add(key);
      tokens.push(token);
      if (tokens.length >= maxTokens) break;
    }
    return tokens;
  }

  // "retraction" | "correction" | "regular": the one notice classifier.
  function noticeClass(title) {
    const key = titleKey(title);
    if (/\b(retraction|withdrawn)\b/.test(key)) return "retraction";
    if (/\b(correction|corrigendum|erratum|errata)\b/.test(key)) return "correction";
    return "regular";
  }

  function isCorrectionTitle(title) {
    return noticeClass(title) !== "regular";
  }

  // ─── Similarity (fuzzball) ─────────────────────────────────────────
  function tokenSortRatio(a, b) {
    return globalThis.fuzzball.token_sort_ratio(a, b);
  }

  // Token-sort similarity of two keys that are already processed (titleKey):
  // fuzzball's own processing is skipped, so every script compares as it is.
  function keySimilarity(a, b) {
    return globalThis.fuzzball.token_sort_ratio(a, b, { full_process: false });
  }

  // Token-sort similarity of the two title keys (0–100).
  function titleSimilarity(a, b) {
    return keySimilarity(titleKey(a), titleKey(b));
  }

  // ─── Years and pages ───────────────────────────────────────────────
  const YEAR_PATTERN = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/;

  // The one year parser: the first plausible four-digit year, else NaN.
  function parseYear(value) {
    const match = String(value ?? "").match(YEAR_PATTERN);
    return match ? Number(match[1]) : NaN;
  }

  function normalizePages(p) { return String(p ?? "").trim().replace(/\s*[-–—]+\s*/g, "-"); }

  function isPlaceholderPages(pages) {
    return /arxiv|preprint|e-?print|forthcoming|in\s+press/i.test(String(pages || ""));
  }

  // ─── Authors ───────────────────────────────────────────────────────
  // Name particles: part of the family name as written ("van der Maaten"),
  // dropped from the comparison key so every spelling compares alike.
  const NAME_PARTICLES = new Set([
    "al", "d", "da", "das", "de", "del", "della", "den", "der", "di", "dos", "du",
    "la", "le", "t", "te", "ten", "ter", "van", "von", "zu", "zum", "zur",
  ]);
  const AND_SEPARATOR = /\s+and\s+/iy;

  // Author names split at top-level " and " (an "and" inside braces belongs
  // to a corporate name such as {Barnes and Noble}).
  function authorParts(authorStr) {
    const text = String(authorStr || "");
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (!depth && /\s/.test(ch)) {
        AND_SEPARATOR.lastIndex = i;
        const match = AND_SEPARATOR.exec(text);
        if (match) {
          parts.push(text.slice(start, i));
          start = i + match[0].length;
          i = start - 1;
        }
      }
    }
    parts.push(text.slice(start));
    return parts.map(part => part.trim()).filter(Boolean);
  }

  // The German umlaut transliterations inside a word after a consonant
  // ("Schuetze", "Boehm", "Gaertner") fold like the umlaut itself (matchFold:
  // ü → u), so "Sch\"{u}tze", "Schütze", "Schutze" and "Schuetze" share a
  // key; ß is already "ss". A final "ue" ("Hue") or one after a vowel
  // ("Bauer") is not an umlaut.
  const UMLAUT_SPELLING = /(?<=\p{L})(?<![aeiouy])([aou])e(?=\p{L})/gu;

  // Comparison key of a family name: matchFold, apostrophes and hyphens
  // joined, umlaut spellings folded, leading particles dropped (the last
  // token always stays).
  function surnameKey(family) {
    const tokens = matchFold(family).replace(/['’`-]/g, "").split(NON_WORD).filter(Boolean)
      .map(token => token.replace(UMLAUT_SPELLING, "$1"));
    let start = 0;
    while (start < tokens.length - 1 && NAME_PARTICLES.has(tokens[start])) start++;
    return tokens.slice(start).join(" ");
  }

  function isBracedWhole(raw) {
    if (!raw.startsWith("{") || !raw.endsWith("}")) return false;
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}" && --depth === 0 && i < raw.length - 1) return false;
    }
    return depth === 0;
  }

  // One BibTeX name: { family (as written, LaTeX stripped), given, key
  // (surnameKey), others }. "Last, First" keeps trailing particles of the
  // given part with the family; "First von Last" takes the particles before
  // the last token; a fully braced name is one corporate family name.
  function parseName(part) {
    const raw = String(part || "").trim();
    const text = stripLatex(raw).trim();
    if (!text) return null;
    if (/^(?:others|et\.?\s*al\.?)$/i.test(text)) return { family: "", given: "", key: "", others: true };
    let family;
    let given;
    if (isBracedWhole(raw)) {
      family = text;
      given = "";
    } else if (text.includes(",")) {
      const [head, ...rest] = text.split(",");
      const givenTokens = rest.join(" ").trim().split(/\s+/).filter(Boolean);
      const moved = [];
      while (givenTokens.length > 1 && NAME_PARTICLES.has(givenTokens[givenTokens.length - 1].toLowerCase()))
        moved.unshift(givenTokens.pop());
      family = [...moved, head.trim()].join(" ").trim();
      given = givenTokens.join(" ");
    } else {
      const tokens = text.split(/\s+/);
      let start = tokens.length - 1;
      while (start > 0 && NAME_PARTICLES.has(tokens[start - 1].toLowerCase())) start--;
      family = tokens.slice(start).join(" ");
      given = tokens.slice(0, start).join(" ");
    }
    return { family, given, key: surnameKey(family), others: false };
  }

  // The one author parser: every name of a BibTeX author list.
  function authorNames(authorStr) {
    return authorParts(authorStr).map(parseName).filter(Boolean);
  }

  // Surname keys of the named authors ("others" excluded), in order.
  function authorKeys(authorStr) {
    return authorNames(authorStr).filter(name => !name.others && name.key).map(name => name.key);
  }

  function firstAuthorSurname(authorStr) {
    const first = authorNames(authorStr)[0];
    return first && !first.others ? first.key : "";
  }

  // The first author's family name as written (LaTeX stripped, case kept),
  // for search queries.
  function firstAuthorSearchToken(original) {
    const first = authorNames(original?.author)[0];
    return first && !first.others ? first.family.replace(/\s+/g, " ").trim() : "";
  }

  // Scripts whose single letter is a whole given name, never an initial.
  const WHOLE_SYLLABLE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

  // Given-name tokens, folded (matchFold): { text, initial }. Hyphens split
  // like spaces ("Jean-Pierre" = "Jean Pierre"); a single letter or a word
  // followed by "." is an initial or abbreviation ("J.", "Chr."); an
  // upper-case run of two or three letters is initials ("JA" = "J. A.").
  function givenTokens(given) {
    const tokens = [];
    for (const [, word, dot] of stripLatex(given).normalize("NFC").matchAll(/([\p{L}\p{M}\p{N}'’]+)(\.)?/gu)) {
      if (/^\p{Lu}{2,3}$/u.test(word)) {
        for (const letter of word) tokens.push({ text: matchFold(letter), initial: true });
        continue;
      }
      const text = matchFold(word).replace(/['’]/g, "");
      if (text) tokens.push({ text, initial: !!dot || ([...text].length === 1 && !WHOLE_SYLLABLE.test(text)) });
    }
    return tokens;
  }

  // An initial or abbreviation matches a word it begins; two full words
  // must be equal.
  function givenTokenMatch(a, b) {
    if (a.initial || b.initial) return a.text.startsWith(b.text) || b.text.startsWith(a.text);
    return a.text === b.text;
  }

  // Whether every token of `shorter` matches, in order, a token of `longer`
  // from index `from` on (match: givenTokenMatch, or equal full words only).
  function givenSubsequence(shorter, longer, from, match) {
    let next = from;
    for (const token of shorter) {
      while (next < longer.length && !match(token, longer[next])) next++;
      if (next >= longer.length) return false;
      next++;
    }
    return true;
  }

  // Given names agree when either is missing, when they spell one name
  // ("Xiaoming" = "Xiao-Ming"), when the first tokens match and the other
  // tokens of the shorter form match, in order, tokens of the longer one
  // (extra middle names or initials are allowed): "J." = "John" = "John A.",
  // or when the shorter form's full names are, in order, full names of the
  // longer one (a first name left out: "Pete" = "Evan Pete"). "John" ≠
  // "James", "John A." ≠ "John B.", and "John" ≠ "Mary J." (a left-out
  // first name never matches through an initial).
  function givensCompatible(a, b) {
    const left = givenTokens(a);
    const right = givenTokens(b);
    if (!left.length || !right.length) return true;
    const spelled = list => (list.some(token => token.initial) ? null : list.map(token => token.text).join(""));
    if (spelled(left) !== null && spelled(left) === spelled(right)) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    if (givenTokenMatch(left[0], right[0])) return givenSubsequence(shorter.slice(1), longer, 1, givenTokenMatch);
    const fullWords = (x, y) => !x.initial && !y.initial && x.text === y.text;
    return givenSubsequence(shorter, longer, 0, fullWords);
  }

  // One person: the same surname key and compatible given names.
  function samePerson(a, b) {
    return !!a && !!b && !a.others && !b.others && !!a.key && a.key === b.key && givensCompatible(a.given, b.given);
  }

  // The first authors of two lists are the same person.
  function firstAuthorsCompatible(a, b) {
    return samePerson(authorNames(a)[0], authorNames(b)[0]);
  }

  function hasTruncatedAuthorMarker(authorStr) {
    return /(^|\s+and\s+)(others|et\s+al\.?)\b|\.\.\./i.test(String(authorStr || ""));
  }

  // Same people in the same order: equal counts with equal surname keys and
  // compatible given names, or a list truncated with "others" whose named
  // part is a prefix of the other list.
  function authorListsEquivalent(a, b) {
    const left = authorNames(a);
    const right = authorNames(b);
    const named = list => list.filter(name => !name.others);
    const leftNamed = named(left);
    const rightNamed = named(right);
    if (!leftNamed.length || !rightNamed.length) return false;
    const truncated = list => list.some(name => name.others) || false;
    const prefixOf = (shorter, longer) => shorter.length <= longer.length &&
      shorter.every((name, index) => samePerson(name, longer[index]));
    if (leftNamed.length === rightNamed.length && prefixOf(leftNamed, rightNamed)) return true;
    if (truncated(left) && prefixOf(leftNamed, rightNamed)) return true;
    if (truncated(right) && prefixOf(rightNamed, leftNamed)) return true;
    return false;
  }

  // Strong-match author count: equal counts, or the shorter list is a prefix
  // of the longer one (the same people: samePerson) or ends with "others".
  function authorCountsCompatible(a, b) {
    const left = authorNames(a);
    const right = authorNames(b);
    const leftNamed = left.filter(name => !name.others);
    const rightNamed = right.filter(name => !name.others);
    if (!leftNamed.length || !rightNamed.length) return false;
    if (leftNamed.length === rightNamed.length) return true;
    const [shorter, longer, shorterList] = leftNamed.length < rightNamed.length
      ? [leftNamed, rightNamed, left] : [rightNamed, leftNamed, right];
    if (shorterList.some(name => name.others)) return true;
    return shorter.every((name, index) => samePerson(name, longer[index]));
  }

  function authorIntegrityIssues(authorStr) {
    const parts = authorParts(authorStr);
    if (!parts.length) return [];
    const issues = [];
    if (parts.some(part => !/[\p{L}\p{N}]/u.test(stripLatex(part))))
      issues.push({ code: "author_punctuation", field: "author", message: "The author list contains a punctuation-only name and is structurally invalid." });

    const normalized = parts.map(part => foldText(part));
    if (new Set(normalized).size !== normalized.length)
      issues.push({ code: "author_duplicates", field: "author", message: "The author list contains duplicate names and may have been corrupted during conversion." });

    const isSingleToken = part => /^[\p{L}.'’-]+$/u.test(stripLatex(part).trim());
    if (parts.length >= 20 && parts.some((part, index) => isSingleToken(part) && isSingleToken(parts[index + 1] || "")))
      issues.push({ code: "author_split_fragments", field: "author", message: "Adjacent one-token author fragments suggest that a name was split at a BibTeX 'and' separator." });
    return issues;
  }

  function shouldSuppressAuthorSuggestion(originalAuthor, foundAuthor) {
    const original = authorNames(originalAuthor);
    const found = authorNames(foundAuthor);
    if (!original.length || !found.length) return false;
    if (authorIntegrityIssues(originalAuthor).length || authorIntegrityIssues(foundAuthor).length) return false;
    if (hasTruncatedAuthorMarker(originalAuthor) || hasTruncatedAuthorMarker(foundAuthor)) {
      const originalFirst = firstAuthorSurname(originalAuthor);
      const foundFirst = firstAuthorSurname(foundAuthor);
      return !originalFirst || !foundFirst || originalFirst === foundFirst;
    }
    if (original.length === found.length && authorListsEquivalent(originalAuthor, foundAuthor)) return true;
    return found.length >= 30 && original.length <= 6;
  }

  // Overlap of two author lists, 0–100: the share of people (samePerson:
  // surname key and compatible given names) both lists name.
  function compareAuthors(a, b) {
    const left = authorNames(a).filter(name => !name.others && name.key);
    const right = authorNames(b).filter(name => !name.others && name.key);
    if (!left.length && !right.length) return 100;
    if (!left.length || !right.length) return 0;
    const unused = right.slice();
    let shared = 0;
    for (const name of left) {
      const index = unused.findIndex(other => samePerson(name, other));
      if (index >= 0) { unused.splice(index, 1); shared++; }
    }
    return (shared / Math.max(left.length, right.length)) * 100;
  }

  // ─── Venues ────────────────────────────────────────────────────────
  // The entry's venue: booktitle first for proceedings types, else journal first.
  function entryVenue(entry) {
    const type = String(entry?.ENTRYTYPE || "").toLowerCase();
    const venue = type === "inproceedings" || type === "conference" || type === "proceedings"
      ? entry?.booktitle || entry?.journal
      : entry?.journal || entry?.booktitle;
    return String(venue || "").trim();
  }

  function venueText(text) {
    return matchFold(text).replace(/&/g, " and ").replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
  }

  // A spelled-out ordinal ("thirteenth", "thirty-eighth", "twenty first").
  const SPELLED_ORDINAL = new RegExp("^(?:(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\\s-]+)?" +
    "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|tenth|eleventh|twelfth|thirteenth|fourteenth|" +
    "fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|" +
    "seventieth|eightieth|ninetieth|hundredth)\\s+(?=\\S+\\s+\\S)");

  // Venue lookup key: venueText without parentheticals, years, ordinals
  // ("13th" anywhere; a spelled-out one at the start when at least two
  // words follow: "The Thirteenth International Conference on …"), a
  // leading "Proceedings of (the)" / "Proc." and punctuation.
  function venueKey(text) {
    return venueText(text)
      .replace(/\([^()]*\)/g, " ")
      .replace(/\b(?:1[5-9]|20)\d{2}\b|\b\d+(?:st|nd|rd|th)\b/g, " ")
      .trim()
      .replace(/^(?:proceedings|proc\.?)(?:\s+of)?(?:\s+the)?\s+/, "")
      .replace(/^the\s+/, "")
      .replace(SPELLED_ORDINAL, "")
      .replace(NON_WORD, " ")
      .trim();
  }

  // venueKey without organiser and event words, for venues the table lacks.
  const VENUE_STOP_WORDS = /\b(?:proceedings|proc|of|the|acm|ieee|cvf|springer|international|conference|symposium|workshop|on|sigkdd)\b/g;

  function venueCore(text) {
    const key = venueKey(text);
    const core = key.replace(VENUE_STOP_WORDS, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
    return core || key;
  }

  // Journal-style names: "Transactions of the Association for Computational
  // Linguistics" (TACL) names a conference organiser, but is a journal.
  const JOURNAL_VENUE = /^(?:transactions|journal) of\b|\b(?:journal|transactions|letters|reviews?)\b/;

  function isConferenceVenueName(venue) {
    const v = venueText(venue);
    if (JOURNAL_VENUE.test(v)) return false;
    if (/^proceedings of (?:the )?(?:national academy of sciences|ieee)\b/.test(v)) return false;
    return /(?:^|\s)(?:neurips|icml|iclr|colm|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|kdd|chi|icassp|usenix|sigmod|vldb)(?:\s|$)/.test(v) ||
      /conference on learning representations|conference on language modeling|conference on machine learning|computer vision and pattern recognition|neural information processing systems|association for computational linguistics|world wide web conference|the web conference/.test(v);
  }

  // Book and proceedings series (S17). A name that is always a series:
  const SERIES_NAME = new RegExp("^(?:lecture notes in |lecture notes of the institute for computer sciences|" +
    "communications in computer and information science$|proceedings of machine learning research$|lipics\\b|" +
    "leibniz international proceedings in informatics|ceur workshop proceedings$|ifip advances in |" +
    "acm international conference proceeding series$|smart innovation systems and technologies$|" +
    "studies in computational intelligence$|advances in intelligent systems and computing$|" +
    "frontiers in artificial intelligence and applications$|electronic proceedings in theoretical computer science$|" +
    "springer proceedings in )");
  // Among a work's several container titles, these name the series too.
  const SERIES_TITLE = /^(?:lecture notes\b|advances in (?!neural information processing)|studies in |springer (?:proceedings|series)\b|series\b)/;

  // Whether a venue name is a book or proceedings series ("Lecture Notes in
  // Computer Science"). options.among: the name is one of several container
  // titles, where "Advances in …" and "Studies in …" series count as well.
  function isSeriesVenue(name, options = {}) {
    const text = venueText(name).replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!text) return false;
    return SERIES_NAME.test(text) || (options.among === true && SERIES_TITLE.test(text));
  }

  function isPreprintVenue(venue) {
    return /\b(arxiv|biorxiv|medrxiv|openrxiv|ssrn|preprint|corr)\b/i.test(foldText(venue));
  }

  // Full venue names and their abbreviations. Lookups compare whole venue
  // keys, never substrings (so Nature is not Nature Communications, and
  // Artificial Intelligence in Medicine is not the journal Artificial
  // Intelligence).
  const VENUE_ABBREVIATIONS = {
    "advances in neural information processing systems": "NeurIPS",
    "neural information processing systems": "NeurIPS",
    "nips": "NeurIPS",
    "international conference on machine learning": "ICML",
    "international conference on learning representations": "ICLR",
    "conference on language modeling": "COLM",
    "second conference on language modeling": "COLM",
    "medical imaging with deep learning": "MIDL",
    "association for computational linguistics": "ACL",
    "annual meeting of the association for computational linguistics": "ACL",
    "conference on empirical methods in natural language processing": "EMNLP",
    "north american chapter of the association for computational linguistics": "NAACL",
    "ieee conference on computer vision and pattern recognition": "CVPR",
    "ieee cvf conference on computer vision and pattern recognition": "CVPR",
    "computer vision and pattern recognition": "CVPR",
    "ieee international conference on computer vision": "ICCV",
    "ieee cvf international conference on computer vision": "ICCV",
    "international conference on computer vision": "ICCV",
    "european conference on computer vision": "ECCV",
    "aaai conference on artificial intelligence": "AAAI",
    "international joint conference on artificial intelligence": "IJCAI",
    "acm sigkdd international conference on knowledge discovery and data mining": "KDD",
    "knowledge discovery and data mining": "KDD",
    "international conference on very large data bases": "VLDB",
    "very large data bases": "VLDB",
    "acm sigmod international conference on management of data": "SIGMOD",
    "ieee transactions on pattern analysis and machine intelligence": "TPAMI",
    "journal of machine learning research": "JMLR",
    "artificial intelligence": "AI",
    "transactions on graphics": "TOG",
    "acm transactions on graphics": "TOG",
    "acm computing surveys": "CSUR",
    "ieee transactions on neural networks and learning systems": "TNNLS",
    "ieee transactions on image processing": "TIP",
    "ieee transactions on signal processing": "TSP",
    "nature machine intelligence": "Nat. Mach. Intell.",
    "international conference on acoustics, speech and signal processing": "ICASSP",
    "ieee international conference on acoustics, speech and signal processing": "ICASSP",
    "acm conference on human factors in computing systems": "CHI",
    "chi conference on human factors in computing systems": "CHI",
    "usenix security symposium": "USENIX Security",
    "ieee symposium on security and privacy": "IEEE S&P",
    "acm conference on computer and communications security": "CCS",
    "international world wide web conference": "WWW",
    "the web conference": "WWW",
  };

  const VENUE_BY_KEY = new Map();
  for (const [full, abbr] of Object.entries(VENUE_ABBREVIATIONS)) {
    VENUE_BY_KEY.set(venueKey(full), abbr);
    if (!VENUE_BY_KEY.has(venueKey(abbr))) VENUE_BY_KEY.set(venueKey(abbr), abbr);
  }

  // The abbreviation for a known venue (whole-key match), else null.
  function knownVenue(name) {
    return VENUE_BY_KEY.get(venueKey(name)) || null;
  }

  // The one venue identity: the known abbreviation, else the core key.
  function canonicalVenue(name) {
    if (!present(name)) return "";
    if (isPreprintVenue(name)) return "preprint";
    return knownVenue(name) || venueCore(name);
  }

  // Two venues name the same publication venue (both preprint servers count
  // as one, R22). Absent venues are not equivalent to anything.
  function venueEquivalent(a, b) {
    if (!present(a) || !present(b)) return false;
    const left = canonicalVenue(a);
    return !!left && left === canonicalVenue(b);
  }

  function abbreviateVenue(name) {
    if (!name) return name;
    return knownVenue(name) || name;
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

  // ─── DOI ───────────────────────────────────────────────────────────
  // The one DOI normaliser (every DOI comparison and cache key): BibTeX
  // escapes and braces removed, https://(dx.)doi.org/ and doi: prefixes
  // stripped, whitespace removed, lower-cased.
  function normalizeDoi(value) {
    return String(value ?? "")
      .replace(/\\([_%&#$])/g, "$1").replace(/[{}]/g, "").trim()
      .replace(/^(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function entryDoi(entry) {
    return normalizeDoi(entry?.doi || entry?.DOI || entry?._externalIds?.DOI || "");
  }

  // ─── PubMed identifiers ────────────────────────────────────────────
  // A PMID field ("33288961", "PMID: 33288961") as its digits, else "".
  function normalizePmid(value) {
    const match = /^\s*(?:pmid\s*:?\s*)?0*(\d{1,9})\s*$/i.exec(String(value ?? ""));
    return match ? match[1] : "";
  }

  // A PMCID field ("PMC7604555", "pmcid: PMC7604555", "7604555") as
  // "PMC" + digits, else "".
  function normalizePmcid(value) {
    const match = /^\s*(?:pmcid\s*:?\s*)?(?:pmc)?\s*0*(\d{1,9})\s*$/i.exec(String(value ?? ""));
    return match ? `PMC${match[1]}` : "";
  }

  // A PMID inside free text: "PMID: n" (note) or a PubMed URL.
  function pmidInText(value) {
    const text = String(value ?? "");
    const match = /\bPMID\s*:?\s*(\d{1,9})\b/i.exec(text) ||
      /(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{1,9})\b/i.exec(text);
    return match ? normalizePmid(match[1]) : "";
  }

  // A PMCID inside free text: "PMCID: PMCn" (note) or a PMC article URL.
  function pmcidInText(value) {
    const text = String(value ?? "");
    const match = /\bPMCID\s*:?\s*(PMC\d{1,9})\b/i.exec(text) ||
      /(?:ncbi\.nlm\.nih\.gov\/pmc\/articles|pmc\.ncbi\.nlm\.nih\.gov\/articles)\/(PMC\d{1,9})\b/i.exec(text);
    return match ? normalizePmcid(match[1]) : "";
  }

  // The entry's PMID: the pmid field, else "PMID: n" in note or url.
  function entryPmid(entry) {
    if (!entry) return "";
    return normalizePmid(entry.pmid ?? entry.PMID ?? "") || pmidInText(entry.note) || pmidInText(entry.url);
  }

  // The entry's PMCID: the pmcid field, else "PMCID: PMCn" in note or url.
  function entryPmcid(entry) {
    if (!entry) return "";
    return normalizePmcid(entry.pmcid ?? entry.PMCID ?? "") || pmcidInText(entry.note) || pmcidInText(entry.url);
  }

  // ─── arXiv ─────────────────────────────────────────────────────────
  // The one arXiv pattern: new-style 2101.00001 or old-style hep-th/9901001
  // (math.GT/0309136), after an "arXiv:" prefix, an arxiv.org/abs|pdf/ URL or
  // a 10.48550/arXiv. DOI. A version suffix, ".pdf" and a "[cs.CL]" class are
  // dropped. Free text is only searched after one of those prefixes, so the
  // digits of other DOIs and URLs never become arXiv IDs.
  const ARXIV_ID = String.raw`(\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)?(?:\.[a-z]{2})?\/\d{7})(?!\d)`;
  const ARXIV_PREFIX = String.raw`(?:arxiv:\s*|(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/|(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.48550\/arxiv\.)`;
  const ARXIV_SUFFIX = String.raw`(?:v\d+)?(?:\.pdf)?(?:\s*\[[^\]]+\])?`;
  const ARXIV_VALUE = new RegExp(`^${ARXIV_PREFIX}?${ARXIV_ID}${ARXIV_SUFFIX}$`, "i");
  const ARXIV_IN_TEXT = new RegExp(`${ARXIV_PREFIX}${ARXIV_ID}`, "i");

  // New-style IDs as they are; old-style archive lower-case, subject class upper-case.
  function canonicalArxivId(id) {
    const match = /^([a-z]+(?:-[a-z]+)?)(?:\.([a-z]{2}))?\/(\d{7})$/i.exec(id);
    if (!match) return id;
    return `${match[1].toLowerCase()}${match[2] ? `.${match[2].toUpperCase()}` : ""}/${match[3]}`;
  }

  // A field that holds an arXiv identifier (eprint, _arxivId): the whole
  // value must be one, optionally prefixed.
  function normalizeArxivId(value) {
    const match = ARXIV_VALUE.exec(String(value ?? "").trim());
    return match ? canonicalArxivId(match[1]) : "";
  }

  // An arXiv identifier inside free text (url, doi, note, journal), only
  // after an anchored prefix.
  function arxivIdInText(value) {
    const match = ARXIV_IN_TEXT.exec(String(value ?? ""));
    return match ? canonicalArxivId(match[1]) : "";
  }

  // The entry's arXiv identifier: identifier fields first, then prefixed
  // forms in url, doi, note, journal and howpublished.
  function extractArxivId(entry) {
    if (!entry) return "";
    for (const value of [entry._arxivId, entry._externalIds?.ArXiv, entry.eprint, entry.arxivid]) {
      const id = normalizeArxivId(value);
      if (id) return id;
    }
    for (const value of [entry.url, entry.doi, entry.DOI, entry.note, entry.journal, entry.howpublished]) {
      const id = arxivIdInText(value);
      if (id) return id;
    }
    return "";
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

  // ─── URLs ──────────────────────────────────────────────────────────
  function extractOpenReviewForumId(value) {
    if (value && typeof value === "object") {
      const direct = String(value._openreviewId || "").trim();
      if (/^[A-Za-z0-9_-]+$/.test(direct)) return direct;
      return extractOpenReviewForumId(value.url || "");
    }
    const match = /openreview\.net\/(?:forum|attachment|pdf)(?:\.html)?\?(?:[^#]*&)?id=([A-Za-z0-9_-]+)/i
      .exec(String(value || ""));
    return match ? match[1] : "";
  }

  function canonicalPaperUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      let path = url.pathname.replace(/\/+$/, "").toLowerCase();
      path = path
        .replace(/-abstract\.html$/i, "")
        .replace(/-paper\.pdf$/i, "")
        .replace(/\.html$/i, "")
        .replace(/\.pdf$/i, "");
      const forumId = extractOpenReviewForumId(raw);
      if (forumId && /(^|\.)openreview\.net$/.test(host))
        return `${host}${path}?id=${forumId}`;
      return `${host}${path}`;
    } catch (_err) {
      return "";
    }
  }

  function sameCanonicalPaperUrl(left, right) {
    const a = canonicalPaperUrl(left);
    const b = canonicalPaperUrl(right);
    return !!a && a === b;
  }

  // ─── Core signature ────────────────────────────────────────────────
  // The one same-work core signature: title key, sorted author surname keys
  // (duplicates kept, "others" dropped), parsed year and notice class.
  function coreSignature(entry) {
    const year = parseYear(entry?.year);
    return [
      titleKey(entry?.title),
      authorKeys(entry?.author).sort().join("|"),
      Number.isInteger(year) ? String(year) : "",
      noticeClass(entry?.title),
    ].join("\u001f");
  }

export {
  TITLE_MATCH_THRESHOLD,
  MIN_TITLE_SIM,
  VENUE_ABBREVIATIONS,
  matchingBrace,
  stripLatex,
  unicodeToLatex,
  decodeHtmlEntities,
  htmlToText,
  present,
  foldText,
  matchFold,
  normalizeEvidenceLanguage,
  safeExternalUrl,
  titleKey,
  queryTitleKey,
  titleIsSpecific,
  searchTitleTokens,
  noticeClass,
  isCorrectionTitle,
  tokenSortRatio,
  keySimilarity,
  titleSimilarity,
  parseYear,
  normalizePages,
  isPlaceholderPages,
  authorParts,
  authorNames,
  authorKeys,
  firstAuthorSurname,
  firstAuthorSearchToken,
  givensCompatible,
  firstAuthorsCompatible,
  authorListsEquivalent,
  authorCountsCompatible,
  authorIntegrityIssues,
  hasTruncatedAuthorMarker,
  shouldSuppressAuthorSuggestion,
  compareAuthors,
  entryVenue,
  venueKey,
  venueEquivalent,
  isConferenceVenueName,
  isSeriesVenue,
  isPreprintVenue,
  abbreviateVenue,
  expandVenue,
  normalizeDoi,
  entryDoi,
  normalizePmid,
  normalizePmcid,
  pmidInText,
  pmcidInText,
  entryPmid,
  entryPmcid,
  normalizeArxivId,
  arxivIdInText,
  extractArxivId,
  arxivYearFromId,
  extractOpenReviewForumId,
  canonicalPaperUrl,
  sameCanonicalPaperUrl,
  coreSignature,
};
