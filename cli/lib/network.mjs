/*
 * lcv's network side. docs/core/providers.js asks the local proxy's /api/*
 * paths, as on a localhost page. In Node there is no proxy, so this module
 * answers those paths the way server/vllm_proxy_server.py and
 * server/proxy_core.py do: the same upstreams, allowed path prefixes,
 * User-Agent and Semantic Scholar API key header, arXiv BibTeX wrapped as
 * { id, bibtex }, and Crossref's rate-limit headers passed through so the
 * providers' pacers learn the live limits. PubMed (NCBI E-utilities) and
 * DataCite (/dois/) are asked directly, as on every page origin. An official
 * proceedings page (/api/page?url=…, docs/core/pages.js) is fetched only
 * from its allowlisted host, and answered as its <meta> tags. Any other
 * host is refused.
 *
 * Successful GET answers (HTTP 200, no error body) are kept in a disk cache,
 * keyed by the canonical upstream URL; errors are never cached.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAGE_HOSTS, proceedingsPage } from "../../docs/core/pages.js";

// The page origin the providers resolve /api/* paths against. ".invalid"
// never resolves, so a request that bypassed this module could not leave.
export const LCV_ORIGIN = "http://lcv.invalid";
// providers.js reads window.location when it is imported (to choose the
// proxy paths) and on every request (to resolve them).
globalThis.window ??= { location: new URL(`${LCV_ORIGIN}/`) };

export const USER_AGENT = "local-citation-verifier/1.0";
export const MAX_METADATA_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_ARXIV_BIBTEX_BYTES = 1024 * 1024;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PUBMED_ORIGIN = "https://eutils.ncbi.nlm.nih.gov";
// DataCite's DOI records (DOI and arXiv ID existence), asked directly too.
export const DATACITE_ORIGIN = "https://api.datacite.org";

// server/vllm_proxy_server.py: route prefix, upstream base, allowed prefixes.
export const PROXY_ROUTES = Object.freeze([
  Object.freeze({
    route: "/api/semanticscholar/",
    upstream: "https://api.semanticscholar.org/",
    allowed: Object.freeze(["graph/v1/paper/search", "graph/v1/paper/search/match", "graph/v1/paper/"]),
  }),
  Object.freeze({ route: "/api/crossref/", upstream: "https://api.crossref.org/", allowed: Object.freeze(["works"]) }),
  Object.freeze({ route: "/api/dblp/", upstream: "https://dblp.org/", allowed: Object.freeze(["search/publ/api"]) }),
  Object.freeze({ route: "/api/openreview/", upstream: "https://api2.openreview.net/", allowed: Object.freeze(["notes/search"]) }),
]);
export const ARXIV_ROUTE = "/api/arxiv/bibtex";
export const PAGE_ROUTE = "/api/page";
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const HEALTH_ROUTE = "/api/health";
export const APP_SIGNATURE = Object.freeze({ app: "local-citation-verifier", ok: true });
// proxy_core.FORWARDED_UPSTREAM_HEADERS, plus NCBI's limit for the PubMed pacer.
const FORWARDED_HEADERS = ["Retry-After", "X-Rate-Limit-Limit", "X-Rate-Limit-Interval", "X-Concurrency-Limit"];
const PUBMED_HEADERS = ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"];
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(?:v\d+)?$/;

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
  }
}

class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamError";
  }
}

// proxy_core.validate_proxy_path: no "..", and the path is one of the
// allowed prefixes or below it.
export function validateProxyPath(rawPath, allowedPrefixes) {
  const normalized = String(rawPath).replace(/^\/+/, "");
  let decoded = normalized;
  try { decoded = decodeURIComponent(normalized); } catch { /* keep the raw path, like urllib's unquote */ }
  if (!normalized || decoded.split("/").includes("..")) throw new BadRequestError("proxy path is invalid");
  const allowed = allowedPrefixes.some(prefix => {
    const base = prefix.replace(/\/+$/, "");
    return normalized === base || normalized.startsWith(`${base}/`);
  });
  if (!allowed) throw new BadRequestError("proxy path is not allowed");
  return normalized;
}

// proxy_core.parse_arxiv_id: a new-style arXiv ID, version dropped.
export function parseArxivId(value) {
  const id = String(value ?? "").trim();
  if (!ARXIV_ID_RE.test(id)) throw new BadRequestError("id must be an arXiv identifier like 2407.21783");
  return id.replace(/v\d+$/, "");
}

// What answers a request the providers make: { kind: "health" }, { kind:
// "arxiv", id, url }, { kind: "page", url }, { kind: "proxy", url } (a
// metadata route) or { kind: "direct", url } (PubMed, DataCite /dois/). BadRequestError for a path the
// proxy refuses; an Error for any other host.
export function upstreamFor(requestUrl, origin = globalThis.window?.location?.origin || LCV_ORIGIN) {
  const url = new URL(String(requestUrl));
  if (url.origin === PUBMED_ORIGIN) return { kind: "direct", url: url.href };
  if (url.origin === DATACITE_ORIGIN && url.pathname.startsWith("/dois/")) return { kind: "direct", url: url.href };
  if (url.origin !== origin) throw new Error(`lcv refuses a request to ${url.origin}`);
  if (url.pathname === HEALTH_ROUTE) return { kind: "health" };
  if (url.pathname === PAGE_ROUTE) {
    const page = proceedingsPage(url.searchParams.get("url") ?? "");
    if (!page) throw new BadRequestError("url must be an official proceedings page");
    return { kind: "page", url: page.url };
  }
  if (url.pathname.startsWith(ARXIV_ROUTE)) {
    const id = parseArxivId(url.searchParams.get("id") ?? "");
    return { kind: "arxiv", id, url: `https://arxiv.org/bibtex/${id}` };
  }
  for (const route of PROXY_ROUTES) {
    if (!url.pathname.startsWith(route.route)) continue;
    const suffix = validateProxyPath(url.pathname.slice(route.route.length), route.allowed);
    return { kind: "proxy", url: `${route.upstream}${suffix}${url.search}` };
  }
  throw new BadRequestError(`lcv has no route for ${url.pathname}`);
}

// proxy_core.upstream_headers: the User-Agent, and the Semantic Scholar API
// key only for api.semanticscholar.org.
export function upstreamHeaders(url, env = process.env) {
  const headers = { "User-Agent": USER_AGENT };
  if (new URL(url).host.toLowerCase() === "api.semanticscholar.org") {
    const key = String(env.SEMANTIC_SCHOLAR_API_KEY ?? "").trim();
    if (key) headers["x-api-key"] = key;
  }
  return headers;
}

// proxy_core.canonical_cache_key: the URL with its query pairs sorted and
// no fragment.
export function canonicalCacheKey(rawUrl) {
  const url = new URL(String(rawUrl));
  const pairs = [...url.searchParams].sort((a, b) =>
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  url.search = new URLSearchParams(pairs).toString();
  url.hash = "";
  return url.href;
}

// ─── Disk cache ──────────────────────────────────────────────────────
export function defaultCacheDir(env = process.env) {
  return env.LCV_CACHE_DIR || path.join(os.homedir(), ".cache", "lcv");
}

// An answer worth keeping: HTTP 200, not an HTML page (a bot check or a
// portal answers 200 too) and, for JSON, a body that parses and reports no
// error (E-utilities can answer 200 with an error object).
export function isCacheable(status, contentType, body) {
  if (status !== 200) return false;
  const text = String(body ?? "");
  if (/^\s*<(?:!doctype\s+html|html)\b/i.test(text) || /html/i.test(String(contentType || ""))) return false;
  if (!/json/i.test(String(contentType || "")) && !/^\s*[{[]/.test(text)) return true;
  try {
    const data = JSON.parse(text);
    return !(data && typeof data === "object" && ("error" in data || data.esearchresult?.ERROR));
  } catch {
    return false;
  }
}

// One JSON file per canonical upstream URL (named by its SHA-256):
// { key, status, contentType, body, storedAt }. Unreadable or expired
// files are misses; write failures are ignored (the cache is best effort).
export function createDiskCache({ dir = defaultCacheDir(), ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
  const fileFor = key => path.join(dir, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
  return {
    dir,
    ttlMs,
    fileFor: url => fileFor(canonicalCacheKey(url)),
    get(url) {
      const key = canonicalCacheKey(url);
      try {
        const stored = JSON.parse(fs.readFileSync(fileFor(key), "utf8"));
        if (stored?.key !== key || typeof stored.body !== "string") return null;
        if (!(now() - Number(stored.storedAt) < ttlMs)) return null;
        return stored;
      } catch {
        return null;
      }
    },
    set(url, { status, contentType = "", body }) {
      if (!isCacheable(status, contentType, body)) return false;
      const key = canonicalCacheKey(url);
      const file = fileFor(key);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ key, status, contentType, body, storedAt: now() }));
        fs.renameSync(temp, file);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ─── fetch for the providers ─────────────────────────────────────────
function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// A Response with the upstream's status (a null-body status gets no body).
function upstreamResponse(status, body, headers) {
  return new Response([101, 204, 205, 304].includes(status) ? null : body, { status, headers });
}

function pickHeaders(headers, names) {
  const out = {};
  for (const name of names) {
    const value = headers?.get?.(name);
    if (typeof value === "string" && value.trim()) out[name] = value.trim();
  }
  return out;
}

/**
 * A fetch() for docs/core providers. options: transport (the real fetch),
 * cache (createDiskCache() or null), env (SEMANTIC_SCHOLAR_API_KEY), stats
 * ({ requests, cacheHits, hosts }, updated in place).
 */
export function createCliFetch({ transport = globalThis.fetch, cache = null, env = process.env, stats = null } = {}) {
  const counters = stats || { requests: 0, cacheHits: 0, hosts: {} };

  // One GET to an upstream (or its cached answer): { status, body, headers }.
  // A transport failure rejects; a body over `limit` is an UpstreamError.
  async function upstreamGet(url, { signal, limit, label }) {
    const cached = cache?.get(url);
    if (cached) {
      counters.cacheHits++;
      return { status: cached.status, body: cached.body, headers: new Headers({ "content-type": cached.contentType || "" }) };
    }
    counters.requests++;
    const host = new URL(url).host;
    counters.hosts[host] = (counters.hosts[host] || 0) + 1;
    const response = await transport(url, { headers: upstreamHeaders(url, env), signal, redirect: "follow" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new UpstreamError(`${label} response is too large`);
    const body = bytes.toString("utf8");
    const contentType = response.headers?.get?.("content-type") || "";
    if (response.status === 200) cache?.set(url, { status: 200, contentType, body });
    return { status: response.status, body, headers: response.headers };
  }

  // proxy_core.fetch_page_meta: the page's <meta> tags, { url, meta }, kept
  // in the cache under the /api/page URL (the page itself is HTML, which
  // the cache refuses). Each redirect is checked before it is followed (at
  // most three): one off the allowlisted hosts is refused.
  async function proceedingsMeta(url, signal) {
    const key = `${LCV_ORIGIN}${PAGE_ROUTE}?url=${encodeURIComponent(url)}`;
    const cached = cache?.get(key);
    if (cached) {
      counters.cacheHits++;
      return JSON.parse(cached.body);
    }
    let current = url;
    let response;
    for (let hop = 0; ; hop++) {
      counters.requests++;
      const host = new URL(current).host;
      counters.hosts[host] = (counters.hosts[host] || 0) + 1;
      response = await transport(current, { headers: upstreamHeaders(current, env), signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = new URL(response.headers?.get?.("location") || "", current);
      if (hop >= 2 || next.protocol !== "https:" || !PAGE_HOSTS.includes(next.hostname.toLowerCase()))
        throw new UpstreamError("the proceedings page redirected off its site");
      current = next.href;
    }
    if (response.status !== 200) throw new UpstreamError(`the proceedings page returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PAGE_BYTES) throw new UpstreamError("proceedings page response is too large");
    const answer = { url: current, meta: (bytes.toString("utf8").match(/<meta\b[^>]*>/gi) || []).join("\n") };
    cache?.set(key, { status: 200, contentType: "application/json", body: JSON.stringify(answer) });
    return answer;
  }

  return async function lcvFetch(input, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const signal = init.signal;
    let target;
    try {
      target = upstreamFor(typeof input === "string" ? input : input?.url ?? String(input));
    } catch (error) {
      if (error instanceof BadRequestError) return jsonResponse(400, { error: error.message });
      throw error;
    }
    if (method !== "GET") return jsonResponse(405, { error: "lcv only forwards GET requests" });
    if (target.kind === "health") return jsonResponse(200, { ...APP_SIGNATURE });

    if (target.kind === "direct") {
      // PubMed and DataCite: the page asks them itself, so a network error stays one.
      const answer = await upstreamGet(target.url, { signal, limit: MAX_METADATA_RESPONSE_BYTES, label: new URL(target.url).host });
      return upstreamResponse(answer.status, answer.body,
        { "content-type": answer.headers.get("content-type") || "text/plain", ...pickHeaders(answer.headers, PUBMED_HEADERS) });
    }

    try {
      if (target.kind === "page") return jsonResponse(200, await proceedingsMeta(target.url, signal));
      if (target.kind === "arxiv") {
        // proxy_core.fetch_arxiv_bibtex: any HTTP error is a 502.
        const answer = await upstreamGet(target.url, { signal, limit: MAX_ARXIV_BIBTEX_BYTES, label: "arXiv" });
        if (answer.status < 200 || answer.status >= 300) return jsonResponse(502, { error: `arXiv returned HTTP ${answer.status}` });
        return jsonResponse(200, { id: target.id, bibtex: answer.body });
      }
      // handle_metadata_proxy: status and body as the upstream sent them,
      // as JSON, with its rate-limit headers.
      const answer = await upstreamGet(target.url, { signal, limit: MAX_METADATA_RESPONSE_BYTES, label: "metadata upstream" });
      return upstreamResponse(answer.status, answer.body,
        { "content-type": "application/json; charset=utf-8", ...pickHeaders(answer.headers, FORWARDED_HEADERS) });
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof UpstreamError ? error.message : `upstream is unreachable: ${error?.message || error}`;
      return jsonResponse(502, { error: message });
    }
  };
}

// Replaces globalThis.fetch (the providers call it) until restore().
export function installFetch(fetchImpl) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => { globalThis.fetch = previous; };
}
