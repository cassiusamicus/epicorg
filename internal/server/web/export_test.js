import { parseMdToNodes } from "./export.js";

// --- Minimal test runner (mirrors tree_test.js) ---

let _pass = 0, _fail = 0;
const _failures = [];

function assert(cond, msg = "") {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(a, b, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function test(name, fn) {
  try {
    fn();
    _pass++;
  } catch (e) {
    _fail++;
    _failures.push({ name, error: e.message });
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function report() {
  console.log(`\n${_pass + _fail} tests, ${_pass} passed, ${_fail} failed`);
  const el = document.getElementById("results");
  if (el) {
    let html = `<h2>${_pass + _fail} tests, <span style="color:green">${_pass} passed</span>`;
    if (_fail > 0) html += `, <span style="color:red">${_fail} failed</span>`;
    html += `</h2>`;
    for (const f of _failures) {
      html += `<div style="color:red;margin:4px 0"><b>${f.name}</b>: ${f.error}</div>`;
    }
    if (_fail === 0) html += `<div style="color:green;margin-top:8px">All tests passed.</div>`;
    el.innerHTML = html;
  }
}

// --- parseMdToNodes ---

test("parseMdToNodes: converts heading depths to nested outline levels", () => {
  const md = "# Top\n\n## Sub\n\n### Deep\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes.length, 1);
  assertEqual(nodes[0].title, "Top");
  assertEqual(nodes[0].children[0].title, "Sub");
  assertEqual(nodes[0].children[0].children[0].title, "Deep");
});

test("parseMdToNodes: a heading back at a shallower depth becomes a new root, not a child", () => {
  const md = "# First\n\n## Child\n\n# Second\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes.length, 2);
  assertEqual(nodes[0].children.length, 1);
  assertEqual(nodes[1].children.length, 0);
});

test("parseMdToNodes: converts a markdown link to an org link", () => {
  const md = "# H\n\nSee [the site](https://example.com) for more.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "See [[https://example.com][the site]] for more.");
});

test("parseMdToNodes: converts bold and italic without corrupting each other", () => {
  const md = "# H\n\nThis is **bold** and this is *italic*.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "This is *bold* and this is /italic/.");
});

test("parseMdToNodes: converts bold and italic together in the same line", () => {
  const md = "# H\n\n**bold** then *italic* then **bold again**.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "*bold* then /italic/ then *bold again*.");
});

test("parseMdToNodes: converts strikethrough and inline code", () => {
  const md = "# H\n\n~~gone~~ and `code`.\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "+gone+ and =code=.");
});

test("parseMdToNodes: preserves text before the first heading as preamble", () => {
  const md = "Some intro text.\n\n# H\n\nBody.\n";
  const { nodes, preamble } = parseMdToNodes(md);
  assertEqual(preamble, "Some intro text.");
  assertEqual(nodes[0].title, "H");
});

test("parseMdToNodes: converts a fenced code block to a #+BEGIN_SRC block", () => {
  const md = "# H\n\n```js\nconst x = 1;\n```\n";
  const { nodes } = parseMdToNodes(md);
  assertEqual(nodes[0].body, "#+BEGIN_SRC js\nconst x = 1;\n#+END_SRC");
});

report();
