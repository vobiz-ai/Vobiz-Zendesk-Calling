#!/usr/bin/env node
/**
 * Refuses to let a credential into the repository.
 *
 * This exists because a sibling project shipped live credentials in a file
 * named `.env.example`, which its .gitignore did not cover — the pattern
 * `*.env` does not match a filename ending in `.example`.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set([
  "node_modules",
  ".git",
  "coverage",
  "dist",
  "tmp",
  "scripts",
]);

const RULES = [
  {
    name: "Vobiz auth ID",
    re: /\b(?:MA|SA)_[A-Z0-9]{8,}\b/g,
  },
  {
    name: "Vobiz auth token",
    re: /\b[A-Za-z0-9]{48,}\b/g,
  },
  {
    name: "real phone number",
    re: /\+\d{11,15}\b/g,
    allow: [/^\+919876543210$/, /^\+9111408481\d\d$/],
  },
  {
    name: "ephemeral tunnel hostname",
    re: /[a-z0-9-]+\.(?:trycloudflare\.com|ngrok(?:-free)?\.(?:io|app|dev))/g,
  },
  {
    name: "private key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
];

const PLACEHOLDER = /X{4,}|REPLACE|EXAMPLE|YOUR_|<[a-z ]+>/i;

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
}
walk(".");

let found = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  // Skip anything that looks binary.
  if (text.indexOf(String.fromCharCode(0)) !== -1) continue;

  const lines = text.split("\n");
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const hit = m[0];
      if (PLACEHOLDER.test(hit)) continue;
      if (rule.allow && rule.allow.some((a) => a.test(hit))) continue;
      const line = text.slice(0, m.index).split("\n").length;
      // A line that is clearly prose about the problem is not the problem.
      if (/^\s*(\*|\/\/|#|>)/.test(lines[line - 1] || "")) continue;
      console.error(
        `  ${f}:${line}  possible ${rule.name}: ${hit.slice(0, 14)}…`,
      );
      found++;
    }
  }
}

if (found) {
  console.error(
    `\n${found} possible secret(s) found. Remove them before committing.`,
  );
  process.exit(1);
}
console.log("No credentials, tokens, or real phone numbers found.");
