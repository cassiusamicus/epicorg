// Regenerate the sample HTML export (docs/Outline.html, served on GitHub
// Pages) from examples/Outline.org, using the same generateExportHtml code
// the app's "Export to HTML" button runs — so the sample always matches what
// a real export looks like.
//
// Usage: node scripts/export-sample.mjs <base-url> <org-file> <out.html>
// Normally run through scripts/export-sample.sh (or `make export-sample`),
// which starts a private epicorg server for the examples/ workspace first.

import { writeFileSync } from "node:fs";
import * as tree from "../internal/server/web/tree.js";
import { generateExportHtml } from "../internal/server/web/export.js";

const [base, file, out] = process.argv.slice(2);
if (!base || !file || !out) {
  console.error("usage: node scripts/export-sample.mjs <base-url> <org-file> <out.html>");
  process.exit(2);
}

// Export settings used for the published sample.
const THEME = "dark";
const ACCENT = "#166534";
const OUTLINE_FORMAT = "bullets";
const LEVEL_FORMATS = {};

async function get(path) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Same as fetchMissingTransclusions in app.js: fetch every cross-file
// TRANSCLUDE source up front so the export is complete.
async function fetchTransclusions(nodes, currentFile) {
  const refs = [];
  const scan = (list) => {
    for (const n of list || []) {
      const ref = n.properties?.TRANSCLUDE;
      if (ref) {
        const parsed = tree.parseTranscludeRef(ref);
        if (parsed?.file && parsed.file !== currentFile) refs.push(parsed);
      }
      if (n.children?.length) scan(n.children);
    }
  };
  scan(nodes);
  const cache = {};
  for (const r of refs) {
    const key = `${r.file}::${r.id}`;
    if (key in cache) continue;
    try {
      const data = await get(`/api/transclude?file=${encodeURIComponent(r.file)}&id=${encodeURIComponent(r.id)}`);
      cache[key] = data.node;
    } catch {
      cache[key] = "missing";
    }
  }
  return cache;
}

const doc = await get("/api/doc/" + encodeURIComponent(file));
const cache = await fetchTransclusions(doc.nodes || [], file);
const resolved = tree.applyTransclusions(doc.nodes || [], file, cache);
const html = generateExportHtml(resolved, doc.preamble || "", file, THEME, ACCENT, OUTLINE_FORMAT, LEVEL_FORMATS);
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
