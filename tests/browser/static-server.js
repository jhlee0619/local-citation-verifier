#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const host = "127.0.0.1";
const port = Number(process.env.BROWSER_TEST_PORT || 4173);
const root = path.resolve(__dirname, "../../docs");
const sockets = new Set();

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
});

function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function resolveAsset(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname.startsWith("/__hang/")) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method Not Allowed");
    return;
  }

  const file = resolveAsset(url.pathname);
  if (!file) {
    send(response, 403, "Forbidden");
    return;
  }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) {
      send(response, 404, "Not Found");
      return;
    }
    const type = contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": type,
      "Content-Length": stat.size,
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(file).pipe(response);
  });
});

server.on("connection", socket => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

function close() {
  server.close(() => process.exit(0));
  sockets.forEach(socket => socket.destroy());
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
server.listen(port, host, () => process.stdout.write(`fixture server: http://${host}:${port}\n`));
