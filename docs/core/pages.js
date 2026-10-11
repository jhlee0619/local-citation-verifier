/*
 * Official proceedings pages. An entry's URL on a proceedings site (NeurIPS,
 * PMLR, JMLR, the ACL Anthology, CVF Open Access, IJCAI) names one paper,
 * the way a DOI does, and the page's citation_* meta tags (the Highwire
 * Press tags Google Scholar reads) are the publisher's own record of it.
 * Only these sites are ever fetched, through the local proxy or lcv
 * (/api/page?url=…, which answer the page's <meta> tags).
 */
import { parseYear } from "./text.js?v=20261012-s18";

// One paper per page: the site's paper id from the URL path, and the URL the
// page is fetched from. type: the entry type of a paper the page lists under
// citation_journal_title (NeurIPS names its proceedings that way).
const SITES = Object.freeze([
  {
    site: "neurips", type: "inproceedings",
    hosts: ["proceedings.neurips.cc", "papers.neurips.cc", "papers.nips.cc"],
    // …/paper[_files/paper]/2020/hash/<32 hex>-Abstract[-Conference].html (or -Paper.pdf, -Bibtex.bib)
    match: path => /^\/paper(?:_files\/paper)?\/(\d{4})\/(?:hash|file)\/([0-9a-f]{32})-(Abstract|Paper|Bibtex|Supplemental)(-[\w]+)?\.(?:html|pdf|bib)$/i.exec(path),
    id: m => m[2].toLowerCase(),
    // The conference year: the page dates the proceedings' publication
    // (2026-04-23 for NeurIPS 2025), which Crossref and citations do not use.
    year: m => m[1],
    url: m => `https://proceedings.neurips.cc/paper_files/paper/${m[1]}/hash/${m[2].toLowerCase()}-Abstract${m[4] || ""}.html`,
  },
  {
    site: "pmlr", type: "inproceedings",
    hosts: ["proceedings.mlr.press"],
    // /v267/li25bc.html, /v267/li25bc/li25bc.pdf
    match: path => /^\/(v\d+)\/([\w-]+?)(?:\.html|\/\2\.pdf)$/.exec(path),
    id: m => `${m[1]}/${m[2]}`,
    url: m => `https://proceedings.mlr.press/${m[1]}/${m[2]}.html`,
  },
  {
    site: "jmlr", type: "article",
    hosts: ["jmlr.org", "www.jmlr.org"],
    // /papers/v23/21-0998.html, /papers/volume23/21-0998/21-0998.pdf
    match: path => /^\/papers\/(?:v(\d+)\/([\w.-]+?)\.(?:html|bib)|volume(\d+)\/([\w.-]+)\/[\w.-]+\.pdf)$/.exec(path),
    id: m => `v${m[1] || m[3]}/${m[2] || m[4]}`,
    url: m => `https://jmlr.org/papers/v${m[1] || m[3]}/${m[2] || m[4]}.html`,
  },
  {
    site: "acl", type: "inproceedings",
    hosts: ["aclanthology.org", "www.aclanthology.org", "www.aclweb.org", "aclweb.org"],
    // /W04-1013/, /2024.findings-emnlp.21.pdf, /anthology/P17-1141
    match: path => /^\/(?:anthology\/)?([A-Z]\d{2}-\d{4}|\d{4}\.[a-z0-9-]+\.\d+)(?:\.pdf|\.bib|\/)?$/i.exec(path),
    id: m => m[1],
    url: m => `https://aclanthology.org/${m[1]}/`,
  },
  {
    site: "cvf", type: "inproceedings",
    hosts: ["openaccess.thecvf.com"],
    // /content_cvpr_2016/html/<name>_paper.html, /content/CVPR2023/papers/<name>_paper.pdf
    match: path => /^\/(content[\w/]*?)\/(?:html|papers)\/([\w-]+_paper)\.(?:html|pdf)$/.exec(path),
    id: m => `${m[1]}/${m[2]}`,
    url: m => `https://openaccess.thecvf.com/${m[1]}/html/${m[2]}.html`,
  },
  {
    site: "ijcai", type: "inproceedings",
    hosts: ["www.ijcai.org", "ijcai.org"],
    // /proceedings/2025/69
    match: path => /^\/proceedings\/(\d{4})\/(\d+)\/?$/.exec(path),
    id: m => `${m[1]}/${Number(m[2])}`,
    url: m => `https://www.ijcai.org/proceedings/${m[1]}/${Number(m[2])}`,
  },
]);

export const PAGE_HOSTS = Object.freeze(SITES.flatMap(site => site.hosts));

// The proceedings page a URL names: { site, key, url, type, year } (key
// "<site>:<id>", url the page to fetch, year the conference year when the
// URL names it), else null.
export function proceedingsPage(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const site = SITES.find(item => item.hosts.includes(host));
  const match = site?.match(url.pathname);
  if (!match) return null;
  return { site: site.site, key: `${site.site}:${site.id(match)}`, url: site.url(match), type: site.type, year: site.year?.(match) || "" };
}

// The page an entry's url field names.
export function entryPage(entry) {
  return proceedingsPage(entry?.url);
}

// ─── citation_* meta tags ───────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// The <meta> tags of a page (or the tags /api/page answers): every
// citation_* name with its values in page order. Attributes may come in any
// order, quoted or not (the ACL Anthology writes content="…" name=citation_title).
export function citationMeta(html) {
  const meta = new Map();
  for (const tag of String(html ?? "").match(/<meta\b[^>]*>/gi) || []) {
    const attributes = {};
    for (const [, name, double, single, bare] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g))
      attributes[name.toLowerCase()] = decodeEntities(double ?? single ?? bare ?? "");
    const name = String(attributes.name || attributes.property || "").toLowerCase();
    if (!name.startsWith("citation_") || attributes.content === undefined) continue;
    const value = attributes.content.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (!meta.has(name)) meta.set(name, []);
    meta.get(name).push(value);
  }
  return meta;
}

// The publisher's record of the paper on a page, as a BibTeX-shaped entry,
// or null when the page carries no title and authors (a bot check, a portal).
export function pageRecord(page, meta) {
  const first = name => meta.get(name)?.[0] || "";
  const title = first("citation_title");
  const authors = meta.get("citation_author") || [];
  if (!title || !authors.length) return null;
  const dated = ["citation_publication_date", "citation_date", "citation_online_date", "citation_year"]
    .map(name => parseYear(first(name))).find(Number.isInteger);
  const year = page.year ? Number(page.year) : dated;
  const conference = first("citation_conference_title");
  const journal = first("citation_journal_title") || first("citation_inbook_title");
  const proceedings = !!conference || page.type === "inproceedings";
  const venue = conference || journal;
  const firstPage = first("citation_firstpage"), lastPage = first("citation_lastpage");
  const record = {
    ENTRYTYPE: proceedings ? "inproceedings" : "article",
    title,
    author: authors.join(" and "),
    year: Number.isInteger(year) ? String(year) : "",
    volume: first("citation_volume"),
    number: first("citation_issue"),
    pages: firstPage && lastPage ? `${firstPage}--${lastPage}` : "",
    doi: first("citation_doi").toLowerCase(),
    publisher: first("citation_publisher"),
    url: page.url,
    _source: "proceedings",
  };
  if (proceedings) record.booktitle = venue;
  else record.journal = venue;
  // The page's own date, when the URL names another year (records'
  // alternative year, accepted next to year by the year rules).
  if (Number.isInteger(dated) && dated !== year) record._onlineYear = String(dated);
  return record;
}
