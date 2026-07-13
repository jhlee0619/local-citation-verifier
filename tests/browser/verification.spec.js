"use strict";

const { test, expect } = require("@playwright/test");
const {
  preparePage,
  verifyBib,
  downloadBib,
  expectCleanNetwork,
} = require("./harness.js");
const { semanticPaper, crossrefItem } = require("./fixtures.js");

const ESCAPED_BIB = String.raw`@article{escape2026,
  title = "Using \\LaTeX and H{\\\"a}ni",
  author = "Tester, T.",
  year = "2026",
}`;

const CONFLICT_BIB = `@article{atomic2022,
  title = {Atomic Metadata Example},
  author = {Original, Alice},
  year = {2022},
  doi = {10.1000/atomic},
  eprint = {2401.12345},
  archiveprefix = {arXiv},
}`;

test("loads only local assets and keeps WebGPU disabled by default", async ({ page, baseURL }) => {
  const state = await preparePage(page, baseURL);
  await expect(page.locator("#btn-verify-paste")).toBeVisible();
  await expect(page.locator("#opt-local-gpu-rerank")).not.toBeChecked();
  expectCleanNetwork(state);
});

test("preserves quoted escapes in the downloaded bibliography", async ({ page, baseURL }) => {
  const state = await preparePage(page, baseURL);
  await verifyBib(page, ESCAPED_BIB);

  await expect(page.locator('.entry-card[data-index="0"]')).toHaveAttribute("data-status", "not_found");
  const downloaded = await downloadBib(page);
  expect(downloaded).toContain(String.raw`Using \\LaTeX and H{\\\"a}ni`);
  expectCleanNetwork(state);
});

test("keeps a conflicting atomic candidate as review-only until explicit selection", async ({ page, baseURL }) => {
  const crossref = crossrefItem({
    title: ["Atomic Metadata Example: Published"],
    author: [{ family: "CrossRef", given: "Carol" }],
    "published-print": { "date-parts": [[2024]] },
  });
  const state = await preparePage(page, baseURL, {
    ssMatch: { data: [semanticPaper()] },
    ssSearch: { data: [semanticPaper({ paperId: "ss-search" })] },
    crossrefSearch: { message: { items: [crossref] } },
    crossrefDoi: { message: crossref },
    arxiv: {
      id: "2401.12345",
      bibtex: `@article{arxiv,
        title = {Atomic Metadata Example Preprint},
        author = {Archive, Alex},
        year = {2023},
        eprint = {2401.12345},
        archiveprefix = {arXiv}
      }`,
    },
  });
  await verifyBib(page, CONFLICT_BIB);

  const card = page.locator('.entry-card[data-index="0"]');
  await expect(card).toHaveAttribute("data-status", "needs_review");
  await expect(card.locator(".candidate-option-btn")).toHaveCount(3);
  const original = await downloadBib(page);
  expect(original).toContain("title = {Atomic Metadata Example}");
  expect(original).toContain("author = {Original, Alice}");
  expect(original).toContain("year = {2022}");

  const first = card.locator('.candidate-option-btn[data-candidate-index="0"]');
  await expect(first).toHaveAttribute("data-record-source", "crossref_doi");
  await expect(first).toHaveAttribute("data-record-id", "10.1000/atomic");
  await first.click();
  const selected = await downloadBib(page);
  expect(selected).toContain("title = {Atomic Metadata Example: Published}");
  expect(selected).toContain("author = {CrossRef, Carol}");
  expect(selected).toContain("year = {2024}");
  expect(selected).not.toContain("author = {Original, Alice}");
  const provenance = await card.locator(".field-provenance").allTextContents();
  expect(provenance.length).toBeGreaterThan(0);
  expect(provenance.every(text => text.includes("crossref_doi") && text.includes("10.1000/atomic"))).toBe(true);
  expect(state.requests.some(request => request.endpoint === "arxiv")).toBe(true);
  expectCleanNetwork(state);
});

test("does not auto-apply a generic-title fuzzy match", async ({ page, baseURL }) => {
  const input = `@article{intro,
  title = {Introduction},
  author = {Original, Olivia},
  year = {2020},
}`;
  const candidate = semanticPaper({
    paperId: "generic-introduction",
    title: "Introduction",
    authors: [{ name: "Different Researcher" }],
    year: 2017,
    externalIds: {},
  });
  const state = await preparePage(page, baseURL, { ssMatch: { data: [candidate] } });
  await verifyBib(page, input);

  await expect(page.locator('.entry-card[data-index="0"]')).toHaveAttribute("data-status", "needs_review");
  const downloaded = await downloadBib(page);
  expect(downloaded).toContain("author = {Original, Olivia}");
  expect(downloaded).toContain("year = {2020}");
  expect(downloaded).not.toContain("Different, Researcher");
  expectCleanNetwork(state);
});

async function permutationResult(browser, baseURL, papers) {
  const page = await browser.newPage();
  const input = `@article{permutation,
  title = {Permutation Stable Study},
  author = {Stable, Sam},
  year = {2021},
  doi = {10.1000/permutation},
}`;
  const state = await preparePage(page, baseURL, { ssSearch: { data: papers } });
  await verifyBib(page, input);
  const ids = await page.locator('.entry-card[data-index="0"] .candidate-option-btn').evaluateAll(buttons =>
    buttons.map(button => `${button.dataset.recordSource}:${button.dataset.recordId}`));
  const status = await page.locator('.entry-card[data-index="0"]').getAttribute("data-status");
  expectCleanNetwork(state);
  await page.close();
  return { ids, status };
}

test("keeps candidate ordering stable across provider permutations", async ({ browser, baseURL }) => {
  const a = semanticPaper({
    paperId: "ss-a",
    title: "Permutation Stable Study",
    authors: [{ name: "Sam Stable" }],
    year: 2021,
    externalIds: { DOI: "10.1000/permutation" },
  });
  const b = semanticPaper({
    paperId: "ss-b",
    title: "Permutation Stable Study",
    authors: [{ name: "Bailey Conflict" }],
    year: 2022,
    externalIds: { DOI: "10.1000/permutation" },
  });
  const forward = await permutationResult(browser, baseURL, [a, b]);
  const reverse = await permutationResult(browser, baseURL, [b, a]);
  expect(reverse).toEqual(forward);
  expect(forward.status).toBe("needs_review");
});

test("keeps an LLM-selected candidate atomic and attributable", async ({ page, baseURL }) => {
  const first = semanticPaper({
    paperId: "llm-a",
    title: "LLM Atomic Choice",
    authors: [{ name: "Alice Alpha" }],
    year: 2020,
    externalIds: {},
  });
  const second = semanticPaper({
    paperId: "llm-b",
    title: "LLM Atomic Choice Revised",
    authors: [{ name: "Bob Beta" }],
    year: 2021,
    externalIds: {},
  });
  const state = await preparePage(page, baseURL, {
    ssSearch: { data: [first, second] },
    vllm: {
      output: JSON.stringify({
        best: 2,
        status: "needs_review",
        confidence: 0.8,
        risk_flags: ["year_mismatch"],
        reason: "fixture chose the second atomic record",
      }),
    },
  });
  await page.evaluate(() => {
    const provider = document.querySelector("#opt-rerank-provider");
    const speed = document.querySelector("#opt-speed-mode");
    const enabled = document.querySelector("#opt-local-gpu-rerank");
    provider.value = "vllm";
    speed.value = "thorough";
    enabled.checked = true;
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    speed.dispatchEvent(new Event("change", { bubbles: true }));
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const input = `@article{llm,
  title = {LLM Atomic Choice},
  author = {Original, Olga},
  year = {2019},
}`;
  await verifyBib(page, input);
  const card = page.locator('.entry-card[data-index="0"]');
  const chosen = card.locator('.candidate-option-btn[data-candidate-index="0"]');
  await expect(chosen).toHaveAttribute("data-record-id", "llm-b");
  await chosen.click();

  const downloaded = await downloadBib(page);
  expect(downloaded).toContain("title = {LLM Atomic Choice Revised}");
  expect(downloaded).toContain("author = {Beta, Bob}");
  expect(downloaded).toContain("year = {2021}");
  expect(downloaded).not.toContain("Alpha, Alice");
  expect(state.requests.filter(request => request.endpoint === "vllm")).toHaveLength(1);
  expectCleanNetwork(state);
});
