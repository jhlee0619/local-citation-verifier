"use strict";

const EMPTY_PAYLOADS = Object.freeze({
  ssMatch: { data: [] },
  ssSearch: { data: [] },
  crossrefSearch: { message: { items: [] } },
  crossrefDoi: { message: null },
  dblp: { result: { hits: { hit: [] } } },
  openreview: { notes: [] },
  arxiv: { bibtex: "" },
  vllmHealth: { ready: false },
  vllm: { output: "" },
});

const LOADER_REVISION = "158f16ae0f672943ca304d59c47c8e3a264e399e";
const MODEL_REVISION = "9fcec64df66cb1e4d972fc5cdc142afb25b2362c";
const LOADER_URL = `https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/resolve/${LOADER_REVISION}/gemma-4-e2b.js`;

function endpointFor(url, request) {
  const path = url.pathname;
  if (path === "/api/rerank/vllm/health") return "vllmHealth";
  if (path === "/api/rerank/vllm") return "vllm";
  if (path === "/api/semanticscholar/graph/v1/paper/search/match") return "ssMatch";
  if (path === "/api/semanticscholar/graph/v1/paper/search") return "ssSearch";
  if (path === "/api/crossref/works") return "crossrefSearch";
  if (path.startsWith("/api/crossref/works/")) return "crossrefDoi";
  if (path === "/api/dblp/search/publ/api") return "dblp";
  if (path === "/api/openreview/notes/search") return "openreview";
  if (path === "/api/arxiv/bibtex") return "arxiv";
  if (path.startsWith("/api/")) return `unhandled:${request.method()}:${path}`;
  return null;
}

function responseFor(value, context) {
  const resolved = typeof value === "function" ? value(context) : value;
  if (resolved && typeof resolved === "object" && ("status" in resolved || "body" in resolved || "kind" in resolved))
    return resolved;
  return { status: 200, body: resolved };
}

async function installFixtureRoutes(page, baseURL, scenario = {}) {
  const state = {
    browserErrors: [],
    externalRequests: [],
    failedLocalAssets: [],
    requests: [],
    unhandledRequests: [],
  };
  const base = new URL(baseURL);

  page.on("pageerror", error => state.browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") state.browserErrors.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    if (url.origin !== base.origin) return;
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__hang/")) return;
    state.failedLocalAssets.push(`${request.method()} ${url.pathname}: ${request.failure()?.errorText || "failed"}`);
  });

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === LOADER_URL && scenario.hfLoader) {
      state.requests.push({ endpoint: "hfLoader", url: url.href, method: request.method() });
      const loader = responseFor(scenario.hfLoader, { url, request, state });
      await route.fulfill({
        status: loader.status || 200,
        contentType: "text/javascript; charset=utf-8",
        headers: { "Access-Control-Allow-Origin": "*", ...(loader.headers || {}) },
        body: String(loader.body || ""),
      });
      return;
    }
    if (url.origin !== base.origin) {
      state.externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }

    const endpoint = endpointFor(url, request);
    if (!endpoint) {
      await route.continue();
      return;
    }
    state.requests.push({ endpoint, url: url.href, method: request.method(), body: request.postData() || "" });
    if (endpoint.startsWith("unhandled:")) {
      state.unhandledRequests.push(endpoint);
      await route.fulfill({ status: 599, body: "unhandled fixture route" });
      return;
    }

    const configured = endpoint in scenario ? scenario[endpoint] : EMPTY_PAYLOADS[endpoint];
    const response = responseFor(configured, { endpoint, url, request, state });
    if (response.kind === "hang") {
      const suffix = `${endpoint}/${state.requests.length}`;
      await route.continue({ url: `${base.origin}/__hang/${suffix}` });
      return;
    }
    await route.fulfill({
      status: response.status || 200,
      contentType: response.contentType || "application/json; charset=utf-8",
      headers: response.headers,
      body: typeof response.body === "string" ? response.body : JSON.stringify(response.body),
    });
  });
  return state;
}

function semanticPaper(overrides = {}) {
  return {
    paperId: "ss-fixture",
    title: "Atomic Metadata Example",
    authors: [{ name: "Alice Original" }],
    year: 2022,
    venue: "Fixture Journal",
    publicationVenue: { name: "Fixture Journal" },
    externalIds: { DOI: "10.1000/atomic" },
    ...overrides,
  };
}

function crossrefItem(overrides = {}) {
  return {
    title: ["Atomic Metadata Example"],
    author: [{ family: "Original", given: "Alice" }],
    "published-print": { "date-parts": [[2022]] },
    "container-title": ["Fixture Journal"],
    DOI: "10.1000/atomic",
    URL: "https://doi.org/10.1000/atomic",
    type: "journal-article",
    ...overrides,
  };
}

module.exports = {
  EMPTY_PAYLOADS,
  LOADER_REVISION,
  MODEL_REVISION,
  LOADER_URL,
  installFixtureRoutes,
  semanticPaper,
  crossrefItem,
};
