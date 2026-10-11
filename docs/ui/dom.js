/*
 * DOM helpers. This is the only module that assigns innerHTML: markup is
 * built with the html`` tag, which escapes every interpolated value unless it
 * is markup html`` built itself or raw() marks as trusted.
 */
import { safeExternalUrl } from "../core/text.js?v=20261012-s17";

class Markup {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// HTML-escapes text for element content and quoted attribute values.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

// Trusted markup, inserted as is. Never pass text that came from input,
// providers, the LLM or storage.
function raw(markup) {
  return new Markup(String(markup ?? ""));
}

function piece(value) {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(piece).join("");
  if (value === null || value === undefined || value === false) return "";
  return esc(value);
}

// html`<p>${text}</p>`: interpolated values are escaped; nested html``
// results and arrays of them are inserted as markup; null, undefined and
// false render nothing.
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += piece(values[i]) + strings[i + 1];
  return new Markup(out);
}

function setHTML(element, markup) {
  element.innerHTML = piece(markup);
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export { esc, raw, html, setHTML, $, $$, safeExternalUrl as safeUrl };
