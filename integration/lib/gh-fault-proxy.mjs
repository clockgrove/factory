#!/usr/bin/env node
// Pass-through GitHub API proxy that can fail, slow or reshape chosen requests.
// Usage: node gh-fault-proxy.mjs <port> <log.jsonl> <rules-file>
//
// The rules file is re-read per request, so the suite turns faults on and off
// by writing it. One rule per line:
//
//   METHOD PATH_REGEX [status=N] [times=N] [until=EPOCH_S] [delay=MS]
//                     [body=RE] [h:NAME=VALUE]...
//
// A request matches when its method and path match, `body=` (a regex) matches
// its request body, the rule has fired fewer than `times` times and the clock
// is before `until`. A matching rule answers `status` (default 502) with a
// JSON error and the `h:` headers, without reaching GitHub. With `delay=` and
// no `status=`, the request waits that long and then passes through. A line
// with only METHOD and PATH_REGEX is a plain 502, as before.
//
// Headers (and so the token) and bodies are never logged.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, logFile, rulesFile] = process.argv.slice(2);
const UPSTREAM = "https://api.github.com";
const DROP = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
]);
/** How many times each rule line has fired, by its text. */
const fired = new Map();

function rules() {
  let text;
  try {
    text = readFileSync(rulesFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const [m, re, ...opts] = line.split(/\s+/);
      const rule = { line, m, re: new RegExp(re), headers: {} };
      for (const o of opts) {
        const at = o.indexOf("=");
        const k = o.slice(0, at);
        const v = o.slice(at + 1);
        if (k.startsWith("h:")) rule.headers[k.slice(2)] = v;
        else if (k === "body") rule.body = new RegExp(v);
        else rule[k] = Number(v);
      }
      if (rule.status === undefined && rule.delay === undefined)
        rule.status = 502;
      return rule;
    });
}

function pick(method, path, body) {
  const now = Date.now() / 1000;
  return rules().find(
    (r) =>
      r.m === method &&
      r.re.test(path) &&
      (r.body === undefined || r.body.test(body)) &&
      (r.times === undefined || (fired.get(r.line) ?? 0) < r.times) &&
      (r.until === undefined || now < r.until),
  );
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const start = Date.now();
  const path = req.url.split("?")[0];
  let status = 0;
  let fault = "";
  const rule = pick(req.method, path, body.toString("utf8"));
  if (rule) {
    fired.set(rule.line, (fired.get(rule.line) ?? 0) + 1);
    fault =
      rule.status !== undefined
        ? `status ${rule.status}`
        : `delay ${rule.delay}`;
    if (rule.delay) await new Promise((r) => setTimeout(r, rule.delay));
  }
  if (rule && rule.status !== undefined) {
    status = rule.status;
    res.writeHead(status, {
      "content-type": "application/json",
      ...rule.headers,
    });
    res.end(JSON.stringify({ message: `drill fault: ${status}` }));
  } else {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !DROP.has(k)),
    );
    try {
      const up = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers,
        redirect: "manual",
        ...(body.length ? { body } : {}),
      });
      status = up.status;
      const out = Buffer.from(await up.arrayBuffer());
      const h = {};
      up.headers.forEach((v, k) => {
        if (
          ![
            "content-encoding",
            "transfer-encoding",
            "content-length",
            "connection",
          ].includes(k)
        )
          h[k] = v;
      });
      h["content-length"] = String(out.length);
      res.writeHead(up.status, h);
      res.end(out);
    } catch (error) {
      status = 599;
      res.writeHead(502);
      res.end(String(error));
    }
  }
  appendFileSync(
    logFile,
    `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path, status, ms: Date.now() - start, ...(fault ? { fault } : {}) })}\n`,
  );
}).listen(Number(port), "127.0.0.1");
