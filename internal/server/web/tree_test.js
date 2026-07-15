import * as tree from "./tree.js";

// --- Minimal test runner ---

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
  tree.resetIdCounter();
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

// --- Test fixtures ---

function node(id, title, children = []) {
  return { id, title, body: "", status: "", tags: [], properties: {}, children, collapsed: false };
}

// --- Tests ---

// flattenVisible
test("flattenVisible: flat list", () => {
  const t = [node("a", "A"), node("b", "B")];
  const flat = tree.flattenVisible(t);
  assertEqual(flat.length, 2);
  assertEqual(flat[0].id, "a");
  assertEqual(flat[1].id, "b");
});

test("flattenVisible: nested children visible", () => {
  const t = [node("a", "A", [node("a1", "A1"), node("a2", "A2")]), node("b", "B")];
  const flat = tree.flattenVisible(t);
  assertEqual(flat.length, 4);
  assertEqual(flat.map(n => n.id), ["a", "a1", "a2", "b"]);
});

test("flattenVisible: collapsed hides children", () => {
  const t = [{ ...node("a", "A", [node("a1", "A1")]), collapsed: true }, node("b", "B")];
  const flat = tree.flattenVisible(t);
  assertEqual(flat.length, 2);
  assertEqual(flat.map(n => n.id), ["a", "b"]);
});

test("flattenVisible: empty input", () => {
  assertEqual(tree.flattenVisible([]).length, 0);
  assertEqual(tree.flattenVisible(null).length, 0);
});

// findNode
test("findNode: root level", () => {
  const t = [node("a", "A"), node("b", "B")];
  assertEqual(tree.findNode(t, "b").title, "B");
});

test("findNode: nested", () => {
  const t = [node("a", "A", [node("a1", "A1", [node("deep", "Deep")])])];
  assertEqual(tree.findNode(t, "deep").title, "Deep");
});

test("findNode: not found returns null", () => {
  assertEqual(tree.findNode([node("a", "A")], "z"), null);
});

// findParentInfo
test("findParentInfo: root node", () => {
  const t = [node("a", "A"), node("b", "B")];
  const info = tree.findParentInfo(t, "b");
  assertEqual(info.parent, null);
  assertEqual(info.index, 1);
});

test("findParentInfo: nested node", () => {
  const t = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const info = tree.findParentInfo(t, "a2");
  assertEqual(info.parent.id, "a");
  assertEqual(info.index, 1);
});

// updateNodeField
test("updateNodeField: updates title at root", () => {
  const t = [node("a", "A"), node("b", "B")];
  const result = tree.updateNodeField(t, "b", "title", "B2");
  assertEqual(result[1].title, "B2");
  assertEqual(result[0].title, "A"); // unchanged
});

test("updateNodeField: updates nested node", () => {
  const t = [node("a", "A", [node("a1", "old")])];
  const result = tree.updateNodeField(t, "a1", "title", "new");
  assertEqual(result[0].children[0].title, "new");
});

test("updateNodeField: immutable — original unchanged", () => {
  const t = [node("a", "A")];
  const result = tree.updateNodeField(t, "a", "title", "X");
  assertEqual(t[0].title, "A");
  assertEqual(result[0].title, "X");
});

// insertSiblingAfter
test("insertSiblingAfter: at root level", () => {
  const t = [node("a", "A"), node("b", "B")];
  const { nodes: result, newId } = tree.insertSiblingAfter(t, "a");
  assertEqual(result.length, 3);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, newId);
  assertEqual(result[2].id, "b");
});

test("insertSiblingAfter: nested", () => {
  const t = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const { nodes: result } = tree.insertSiblingAfter(t, "a1");
  assertEqual(result[0].children.length, 3);
  assertEqual(result[0].children[0].id, "a1");
  assertEqual(result[0].children[2].id, "a2");
});

// removeNode
test("removeNode: removes from root", () => {
  const t = [node("a", "A"), node("b", "B"), node("c", "C")];
  const result = tree.removeNode(t, "b");
  assertEqual(result.length, 2);
  assertEqual(result.map(n => n.id), ["a", "c"]);
});

test("removeNode: removes nested", () => {
  const t = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const result = tree.removeNode(t, "a1");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "a2");
});

test("removeNode: preserves unrelated branches", () => {
  const t = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.removeNode(t, "a1");
  assertEqual(result.length, 2);
  assertEqual(result[1].id, "b");
});

// indentNode
test("indentNode: becomes child of previous sibling", () => {
  const t = [node("a", "A"), node("b", "B")];
  const result = tree.indentNode(t, "b");
  assertEqual(result.length, 1);
  assertEqual(result[0].id, "a");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "b");
});

test("indentNode: first child cannot indent", () => {
  const t = [node("a", "A"), node("b", "B")];
  const result = tree.indentNode(t, "a");
  assertEqual(result, t); // unchanged
});

test("indentNode: uncollapses new parent", () => {
  const t = [{ ...node("a", "A"), collapsed: true }, node("b", "B")];
  const result = tree.indentNode(t, "b");
  assertEqual(result[0].collapsed, false);
});

test("indentNode: appends to existing children", () => {
  const t = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.indentNode(t, "b");
  assertEqual(result[0].children.length, 2);
  assertEqual(result[0].children[0].id, "a1");
  assertEqual(result[0].children[1].id, "b");
});

// outdentNode
test("outdentNode: becomes sibling of parent", () => {
  const t = [node("a", "A", [node("a1", "A1")])];
  const result = tree.outdentNode(t, "a1");
  assertEqual(result.length, 2);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, "a1");
  assertEqual(result[0].children.length, 0);
});

test("outdentNode: root node cannot outdent", () => {
  const t = [node("a", "A")];
  const result = tree.outdentNode(t, "a");
  assertEqual(result, t); // unchanged
});

test("outdentNode: inserts after parent, not at end", () => {
  const t = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.outdentNode(t, "a1");
  assertEqual(result.length, 3);
  assertEqual(result.map(n => n.id), ["a", "a1", "b"]);
});

// moveNodeUp
test("moveNodeUp: swaps with previous sibling", () => {
  const t = [node("a", "A"), node("b", "B"), node("c", "C")];
  const result = tree.moveNodeUp(t, "b");
  assertEqual(result.map(n => n.id), ["b", "a", "c"]);
});

test("moveNodeUp: first node cannot move up", () => {
  const t = [node("a", "A"), node("b", "B")];
  const result = tree.moveNodeUp(t, "a");
  assertEqual(result, t);
});

test("moveNodeUp: works within nested children", () => {
  const t = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const result = tree.moveNodeUp(t, "a2");
  assertEqual(result[0].children.map(n => n.id), ["a2", "a1"]);
});

// moveNodeDown
test("moveNodeDown: swaps with next sibling", () => {
  const t = [node("a", "A"), node("b", "B"), node("c", "C")];
  const result = tree.moveNodeDown(t, "b");
  assertEqual(result.map(n => n.id), ["a", "c", "b"]);
});

test("moveNodeDown: last node cannot move down", () => {
  const t = [node("a", "A"), node("b", "B")];
  const result = tree.moveNodeDown(t, "b");
  assertEqual(result, t);
});

test("moveNodeDown: works within nested children", () => {
  const t = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const result = tree.moveNodeDown(t, "a1");
  assertEqual(result[0].children.map(n => n.id), ["a2", "a1"]);
});

// foldToLevel
test("foldToLevel 1: collapses all root nodes", () => {
  const t = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.foldToLevel(t, 1);
  assertEqual(result[0].collapsed, true);
  assertEqual(result[1].collapsed, false); // no children
});

test("foldToLevel 2: root visible, level 2 collapsed", () => {
  const t = [node("a", "A", [node("a1", "A1", [node("deep", "Deep")])])];
  const result = tree.foldToLevel(t, 2);
  assertEqual(result[0].collapsed, false); // depth 1 < level 2
  assertEqual(result[0].children[0].collapsed, true); // depth 2 >= level 2
});

test("foldToLevel: leaf nodes stay uncollapsed", () => {
  const t = [node("a", "A")];
  const result = tree.foldToLevel(t, 1);
  assertEqual(result[0].collapsed, false); // no children to collapse
});

// uncollapseToNode
test("uncollapseToNode: uncollapses ancestors", () => {
  const t = [{ ...node("a", "A", [{ ...node("a1", "A1", [node("deep", "Deep")]), collapsed: true }]), collapsed: true }];
  const result = tree.uncollapseToNode(t, "deep");
  assertEqual(result[0].collapsed, false);
  assertEqual(result[0].children[0].collapsed, false);
});

test("uncollapseToNode: doesn't change unrelated nodes", () => {
  const t = [
    { ...node("a", "A", [node("a1", "A1")]), collapsed: true },
    { ...node("b", "B", [node("b1", "B1")]), collapsed: true },
  ];
  const result = tree.uncollapseToNode(t, "a1");
  assertEqual(result[0].collapsed, false); // uncollapsed to reach a1
  assertEqual(result[1].collapsed, true);  // unrelated, stays collapsed
});

// formatOrgDate / parseOrgDate
test("formatOrgDate: formats ISO to org timestamp", () => {
  const result = tree.formatOrgDate("2026-04-15");
  assert(result.startsWith("<2026-04-15 "));
  assert(result.endsWith(">"));
});

test("formatOrgDate: empty input", () => {
  assertEqual(tree.formatOrgDate(""), "");
  assertEqual(tree.formatOrgDate(null), "");
});

test("parseOrgDate: extracts date from org timestamp", () => {
  assertEqual(tree.parseOrgDate("<2026-04-15 Wed>"), "2026-04-15");
});

test("parseOrgDate: handles bare date", () => {
  assertEqual(tree.parseOrgDate("2026-04-15"), "2026-04-15");
});

test("parseOrgDate: empty input", () => {
  assertEqual(tree.parseOrgDate(""), "");
  assertEqual(tree.parseOrgDate(null), "");
});

test("parseOrgDate roundtrip", () => {
  const iso = "2026-04-15";
  assertEqual(tree.parseOrgDate(tree.formatOrgDate(iso)), iso);
});

// nextStatus
test("nextStatus: cycles through statuses", () => {
  assertEqual(tree.nextStatus(""), "TODO");
  assertEqual(tree.nextStatus("TODO"), "NEXT");
  assertEqual(tree.nextStatus("NEXT"), "URGENT");
  assertEqual(tree.nextStatus("URGENT"), "WAITING");
  assertEqual(tree.nextStatus("WAITING"), "DONE");
  assertEqual(tree.nextStatus("DONE"), "CANCELLED");
  assertEqual(tree.nextStatus("CANCELLED"), "");
});

test("nextStatus: handles undefined", () => {
  assertEqual(tree.nextStatus(undefined), "TODO");
});

// --- Edge cases ---

test("indent then outdent is identity", () => {
  const t = [node("a", "A"), node("b", "B")];
  const indented = tree.indentNode(t, "b");
  const result = tree.outdentNode(indented, "b");
  assertEqual(result.length, 2);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, "b");
});

test("insert then remove is identity", () => {
  const t = [node("a", "A"), node("b", "B")];
  const { nodes: inserted, newId } = tree.insertSiblingAfter(t, "a");
  const result = tree.removeNode(inserted, newId);
  assertEqual(result.length, 2);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, "b");
});

test("moveUp then moveDown is identity", () => {
  const t = [node("a", "A"), node("b", "B"), node("c", "C")];
  const moved = tree.moveNodeUp(t, "b");
  const result = tree.moveNodeDown(moved, "b");
  assertEqual(result.map(n => n.id), ["a", "b", "c"]);
});

// formatFileSize
test("formatFileSize: bytes under 1024 shown as B", () => {
  assertEqual(tree.formatFileSize(500), "500 B");
  assertEqual(tree.formatFileSize(0), "0 B");
});

test("formatFileSize: kilobytes", () => {
  assertEqual(tree.formatFileSize(2048), "2.0 KB");
  assertEqual(tree.formatFileSize(1536), "1.5 KB");
});

test("formatFileSize: megabytes and gigabytes", () => {
  assertEqual(tree.formatFileSize(5 * 1024 * 1024), "5.0 MB");
  assertEqual(tree.formatFileSize(2 * 1024 * 1024 * 1024), "2.0 GB");
});

test("formatFileSize: large values drop decimal point", () => {
  assertEqual(tree.formatFileSize(123 * 1024), "123 KB");
});

test("formatFileSize: handles null/undefined", () => {
  assertEqual(tree.formatFileSize(null), "");
  assertEqual(tree.formatFileSize(undefined), "");
});

// formatFileDate
test("formatFileDate: formats a valid ISO date", () => {
  const result = tree.formatFileDate("2026-06-24T16:32:00-04:00");
  assert(result.includes("2026"), `expected year in ${result}`);
  assert(result.includes("Jun"), `expected month in ${result}`);
});

test("formatFileDate: handles empty/invalid input", () => {
  assertEqual(tree.formatFileDate(""), "");
  assertEqual(tree.formatFileDate("not a date"), "");
});

// matchesQuery
test("matchesQuery: empty query matches anything", () => {
  assertEqual(tree.matchesQuery("", "hello"), true);
  assertEqual(tree.matchesQuery("", ""), true);
});

test("matchesQuery: exact substring matches", () => {
  assertEqual(tree.matchesQuery("hello", "hello world"), true);
});

test("matchesQuery: non-contiguous characters do not match", () => {
  // Unlike a fuzzy/subsequence matcher, letters that merely appear in order
  // (with gaps) must NOT match — that's what caused unrelated paragraphs to
  // match short queries like "Walker".
  assertEqual(tree.matchesQuery("hwo", "hello world"), false);
  assertEqual(tree.matchesQuery("hlo", "hello"), false);
});

test("matchesQuery: missing characters do not match", () => {
  assertEqual(tree.matchesQuery("xyz", "hello"), false);
});

test("matchesQuery: case insensitive", () => {
  assertEqual(tree.matchesQuery("HELLO", "hello world"), true);
  assertEqual(tree.matchesQuery("hello", "HELLO WORLD"), true);
});

test("matchesQuery: handles null/undefined text", () => {
  assertEqual(tree.matchesQuery("a", null), false);
  assertEqual(tree.matchesQuery("a", undefined), false);
  assertEqual(tree.matchesQuery("", null), true);
});

// filterTree
test("filterTree: empty query returns original list", () => {
  const t = [node("a", "A"), node("b", "B")];
  assertEqual(tree.filterTree(t, ""), t);
});

test("filterTree: keeps matching root nodes, drops non-matches", () => {
  const t = [node("a", "alpha"), node("b", "beta"), node("c", "gamma")];
  const result = tree.filterTree(t, "alp");
  assertEqual(result.length, 1);
  assertEqual(result[0].id, "a");
});

test("filterTree: keeps ancestor when descendant matches", () => {
  const t = [node("a", "alpha", [node("a1", "needle in haystack")])];
  const result = tree.filterTree(t, "needle");
  assertEqual(result.length, 1);
  assertEqual(result[0].id, "a");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "a1");
});

test("filterTree: matching node still prunes non-matching children (sparse tree)", () => {
  const t = [node("a", "alpha", [node("a1", "x"), node("a2", "y")])];
  const result = tree.filterTree(t, "alpha");
  assertEqual(result[0].children.length, 0);
});

test("filterTree: matching node keeps its own matching descendants", () => {
  const t = [node("a", "alpha", [node("a1", "alpha junior"), node("a2", "y")])];
  const result = tree.filterTree(t, "alpha");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "a1");
});

test("filterTree: prunes non-matching siblings of descendant match", () => {
  const t = [node("a", "root", [node("a1", "needle"), node("a2", "haystack")])];
  const result = tree.filterTree(t, "need");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "a1");
});

test("filterTree: uncollapses matching branches", () => {
  const t = [{ ...node("a", "alpha", [node("a1", "needle")]), collapsed: true }];
  const result = tree.filterTree(t, "needle");
  assertEqual(result[0].collapsed, false);
});

test("filterTree: drops branches with no matches", () => {
  const t = [
    node("a", "alpha", [node("a1", "x")]),
    node("b", "beta", [node("b1", "needle")]),
  ];
  const result = tree.filterTree(t, "needle");
  assertEqual(result.length, 1);
  assertEqual(result[0].id, "b");
});

test("filterTree: immutable — original unchanged", () => {
  const t = [{ ...node("a", "A", [node("a1", "A1")]), collapsed: true }];
  tree.filterTree(t, "A1");
  assertEqual(t[0].collapsed, true);
});

test("filterTree: tag filter keeps nodes matching any selected tag", () => {
  const t = [
    { ...node("a", "alpha"), tags: ["work"] },
    { ...node("b", "beta"), tags: ["home"] },
    { ...node("c", "gamma"), tags: ["work", "urgent"] },
  ];
  const result = tree.filterTree(t, "", ["work"]);
  assertEqual(result.map((n) => n.id), ["a", "c"]);
});

test("filterTree: tag filter is OR across multiple selected tags", () => {
  const t = [
    { ...node("a", "alpha"), tags: ["work"] },
    { ...node("b", "beta"), tags: ["home"] },
    { ...node("c", "gamma"), tags: [] },
  ];
  const result = tree.filterTree(t, "", ["work", "home"]);
  assertEqual(result.map((n) => n.id), ["a", "b"]);
});

test("filterTree: text query and tag filter combine with AND", () => {
  const t = [
    { ...node("a", "alpha"), tags: ["work"] },
    { ...node("b", "alpha two"), tags: ["home"] },
  ];
  const result = tree.filterTree(t, "alpha", ["work"]);
  assertEqual(result.map((n) => n.id), ["a"]);
});

test("filterTree: tagged descendant keeps ancestor as breadcrumb", () => {
  const t = [node("a", "alpha", [{ ...node("a1", "child"), tags: ["work"] }])];
  const result = tree.filterTree(t, "", ["work"]);
  assertEqual(result.length, 1);
  assertEqual(result[0].children.map((n) => n.id), ["a1"]);
});

// collectAllTags
test("collectAllTags: collects unique tags across the tree, sorted", () => {
  const t = [
    { ...node("a", "alpha"), tags: ["zebra", "work"] },
    node("b", "beta", [{ ...node("b1", "child"), tags: ["work", "urgent"] }]),
  ];
  assertEqual(tree.collectAllTags(t), ["urgent", "work", "zebra"]);
});

test("collectAllTags: empty when no nodes have tags", () => {
  const t = [node("a", "alpha"), node("b", "beta")];
  assertEqual(tree.collectAllTags(t), []);
});

// collapsedMap
test("collapsedMap: collects ids of collapsed nodes across the tree", () => {
  const t = [
    { ...node("a", "alpha", [{ ...node("a1", "child"), collapsed: true }]), collapsed: true },
    node("b", "beta"),
  ];
  assertEqual(tree.collapsedMap(t), { a: true, a1: true });
});

test("collapsedMap: empty when nothing is collapsed", () => {
  const t = [node("a", "alpha"), node("b", "beta")];
  assertEqual(tree.collapsedMap(t), {});
});

// extractPreambleTitle / setPreambleTitle
test("extractPreambleTitle: finds the value after #+TITLE:", () => {
  assertEqual(tree.extractPreambleTitle("#+TITLE: My Doc\n#+OPTIONS: toc:4\n"), "My Doc");
});

test("extractPreambleTitle: case-insensitive keyword", () => {
  assertEqual(tree.extractPreambleTitle("#+title: lowercase\n"), "lowercase");
});

test("extractPreambleTitle: empty when no title line", () => {
  assertEqual(tree.extractPreambleTitle("#+OPTIONS: toc:4\n"), "");
});

test("extractPreambleTitle: empty for empty/missing preamble", () => {
  assertEqual(tree.extractPreambleTitle(""), "");
  assertEqual(tree.extractPreambleTitle(undefined), "");
});

test("setPreambleTitle: replaces an existing title line in place", () => {
  const result = tree.setPreambleTitle("#+TITLE: Old\n#+OPTIONS: toc:4", "New");
  assertEqual(result, "#+TITLE: New\n#+OPTIONS: toc:4");
});

test("setPreambleTitle: inserts a title line at the top when missing", () => {
  const result = tree.setPreambleTitle("#+OPTIONS: toc:4", "Fresh Title");
  assertEqual(result, "#+TITLE: Fresh Title\n#+OPTIONS: toc:4");
});

test("setPreambleTitle: removes the line entirely when cleared", () => {
  const result = tree.setPreambleTitle("#+TITLE: Old\n#+OPTIONS: toc:4", "");
  assertEqual(result, "#+OPTIONS: toc:4");
});

test("setPreambleTitle: handles an empty preamble", () => {
  assertEqual(tree.setPreambleTitle("", "New Title"), "#+TITLE: New Title");
  assertEqual(tree.setPreambleTitle("", ""), "");
});

// renderOrgInline
test("renderOrgInline: bold", () => {
  assertEqual(tree.renderOrgInline("*bold*"), "<strong>bold</strong>");
});

test("renderOrgInline: italic", () => {
  assertEqual(tree.renderOrgInline("/italic/"), "<em>italic</em>");
});

test("renderOrgInline: underline", () => {
  assertEqual(tree.renderOrgInline("_underline_"), "<u>underline</u>");
});

test("renderOrgInline: code", () => {
  assertEqual(tree.renderOrgInline("=code="), "<code>code</code>");
});

test("renderOrgInline: link with label", () => {
  assertEqual(
    tree.renderOrgInline("[[https://example.com][label]]"),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">label</a>'
  );
});

test("renderOrgInline: link without label uses url as label", () => {
  assertEqual(
    tree.renderOrgInline("[[https://example.com]]"),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>'
  );
});

test("renderOrgInline: unsafe url scheme is neutered, never used as href", () => {
  // Non-http(s)/mailto/file schemes fall through to the wiki-link path:
  // href="#" plus a data-wiki attribute, so the scheme is never executable.
  assertEqual(
    tree.renderOrgInline("[[javascript:alert(1)][click]]"),
    '<a href="#" class="wiki-link" data-wiki="javascript:alert(1)">click</a>'
  );
});

test("renderOrgInline: escapes HTML special characters", () => {
  assertEqual(tree.renderOrgInline("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("renderOrgInline: markup adjacent to escaped tags does not bleed across", () => {
  assertEqual(tree.renderOrgInline("*bold* /italic/"), "<strong>bold</strong> <em>italic</em>");
});

test("renderOrgInline: combination of multiple markers", () => {
  assertEqual(
    tree.renderOrgInline("*bold* /italic/ _underline_ =code="),
    "<strong>bold</strong> <em>italic</em> <u>underline</u> <code>code</code>"
  );
});

test("renderOrgInline: plain text with no markup is only escaped", () => {
  assertEqual(tree.renderOrgInline("just plain text"), "just plain text");
});

test("renderOrgInline: empty string returns empty string", () => {
  assertEqual(tree.renderOrgInline(""), "");
});

test("renderOrgInline: lone marker characters are left as-is", () => {
  assertEqual(tree.renderOrgInline("5 * 5 = 25"), "5 * 5 = 25");
});

// --- renderOrgInline: combined/nested emphasis (verified against Emacs org-mode) ---
test("renderOrgInline: bold+italic nested (bold outer)", () => {
  assertEqual(tree.renderOrgInline("*/bold and italic/*"), "<strong><em>bold and italic</em></strong>");
});

test("renderOrgInline: italic+bold nested (italic outer)", () => {
  assertEqual(tree.renderOrgInline("/*italic and bold*/"), "<em><strong>italic and bold</strong></em>");
});

test("renderOrgInline: bold containing underline", () => {
  assertEqual(tree.renderOrgInline("*bold _underline_ text*"), "<strong>bold <u>underline</u> text</strong>");
});

test("renderOrgInline: underline containing italic", () => {
  assertEqual(tree.renderOrgInline("_underline /italic/ text_"), "<u>underline <em>italic</em> text</u>");
});

test("renderOrgInline: triple-nested bold+italic+underline", () => {
  assertEqual(tree.renderOrgInline("*/_all three_/*"), "<strong><em><u>all three</u></em></strong>");
});

test("renderOrgInline: strikethrough containing bold", () => {
  assertEqual(tree.renderOrgInline("+*bold* strike+"), "<del><strong>bold</strong> strike</del>");
});

test("renderOrgInline: verbatim content stays literal, no nested emphasis", () => {
  assertEqual(tree.renderOrgInline("=*not bold*="), "<code>*not bold*</code>");
});

test("renderOrgInline: separate non-adjacent markers do not combine", () => {
  assertEqual(
    tree.renderOrgInline("*bold* /italic/ _underline_"),
    "<strong>bold</strong> <em>italic</em> <u>underline</u>"
  );
});

// --- renderOrgInline: emphasis boundary rules (verified against Emacs org-mode) ---
test("renderOrgInline: marker touching a letter (no boundary) stays literal", () => {
  assertEqual(tree.renderOrgInline("foo/bar/baz"), "foo/bar/baz");
  assertEqual(tree.renderOrgInline("foo*bar*baz"), "foo*bar*baz");
});

test("renderOrgInline: parenthesis is a valid boundary", () => {
  assertEqual(tree.renderOrgInline("(*bar*)"), "(<strong>bar</strong>)");
});

test("renderOrgInline: hyphen is a valid boundary", () => {
  assertEqual(tree.renderOrgInline("foo-*bold*-bar"), "foo-<strong>bold</strong>-bar");
});

test("renderOrgInline: double-quote boundary works despite HTML-escaping", () => {
  assertEqual(tree.renderOrgInline('"*bar*"'), "&quot;<strong>bar</strong>&quot;");
});

test("renderOrgInline: single-quote boundary works despite HTML-escaping", () => {
  assertEqual(tree.renderOrgInline("'/italic/'"), "&#39;<em>italic</em>&#39;");
});

test("renderOrgInline: apostrophe immediately after closing marker is a valid boundary", () => {
  assertEqual(tree.renderOrgInline("*bold*'s test"), "<strong>bold</strong>&#39;s test");
});

test("renderOrgInline: adjacent emphasis spans separated by one space both apply", () => {
  assertEqual(tree.renderOrgInline("*bold1* *bold2*"), "<strong>bold1</strong> <strong>bold2</strong>");
});

// --- renderOrgBody: quote blocks ---
test("renderOrgBody: quote block renders as blockquote, hides markers", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_quote\nHello world\n#+end_quote"),
    '<blockquote class="org-quote">Hello world</blockquote>'
  );
});

test("renderOrgBody: quote block content still processes inline markup", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_quote\n*bold* text\n#+end_quote"),
    '<blockquote class="org-quote"><strong>bold</strong> text</blockquote>'
  );
});

test("renderOrgBody: quote block marker matching is case-insensitive", () => {
  assertEqual(
    tree.renderOrgBody("#+BEGIN_QUOTE\nHello\n#+END_QUOTE"),
    '<blockquote class="org-quote">Hello</blockquote>'
  );
});

test("renderOrgBody: text before and after quote block is preserved", () => {
  assertEqual(
    tree.renderOrgBody("before\n#+begin_quote\nquoted\n#+end_quote\nafter"),
    'before\n<blockquote class="org-quote">quoted</blockquote>\nafter'
  );
});

test("renderOrgBody: unterminated quote block runs to end of body", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_quote\nquoted forever"),
    '<blockquote class="org-quote">quoted forever</blockquote>'
  );
});

test("renderOrgBody: plain text without quote markers is unaffected", () => {
  assertEqual(tree.renderOrgBody("just a normal line"), "just a normal line");
});

// --- renderOrgBody: verse blocks ---
test("renderOrgBody: verse block renders as <p class=org-verse>, hides markers", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_verse\nRoses are red\nViolets are blue\n#+end_verse"),
    '<p class="org-verse">Roses are red\nViolets are blue</p>'
  );
});

test("renderOrgBody: verse block content still processes inline markup", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_verse\n*Roses* are red\n#+end_verse"),
    '<p class="org-verse"><strong>Roses</strong> are red</p>'
  );
});

test("renderOrgBody: verse block marker matching is case-insensitive", () => {
  assertEqual(
    tree.renderOrgBody("#+BEGIN_VERSE\nline\n#+END_VERSE"),
    '<p class="org-verse">line</p>'
  );
});

test("renderOrgBody: unterminated verse block runs to end of body", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_verse\nforever"),
    '<p class="org-verse">forever</p>'
  );
});

// --- renderOrgBody: src blocks ---
test("renderOrgBody: src block renders as <pre><code>, hides markers", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_src\nconsole.log(1)\n#+end_src"),
    '<pre class="org-src"><code>console.log(1)</code></pre>'
  );
});

test("renderOrgBody: src block captures the language as data-lang", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_src js\nconsole.log(1)\n#+end_src"),
    '<pre class="org-src" data-lang="js"><code>console.log(1)</code></pre>'
  );
});

test("renderOrgBody: src block content is never run through inline markup", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_src\n*not bold* /not italic/\n#+end_src"),
    '<pre class="org-src"><code>*not bold* /not italic/</code></pre>'
  );
});

test("renderOrgBody: src block escapes HTML special characters", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_src html\n<div>&x</div>\n#+end_src"),
    '<pre class="org-src" data-lang="html"><code>&lt;div&gt;&amp;x&lt;/div&gt;</code></pre>'
  );
});

test("renderOrgBody: src block marker matching is case-insensitive", () => {
  assertEqual(
    tree.renderOrgBody("#+BEGIN_SRC python\nx = 1\n#+END_SRC"),
    '<pre class="org-src" data-lang="python"><code>x = 1</code></pre>'
  );
});

test("renderOrgBody: unterminated src block runs to end of body", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_src\nforever()"),
    '<pre class="org-src"><code>forever()</code></pre>'
  );
});

// --- renderOrgBody: example blocks ---
test("renderOrgBody: example block renders as <pre><code>, hides markers", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_example\nsome output\n#+end_example"),
    '<pre class="org-example"><code>some output</code></pre>'
  );
});

test("renderOrgBody: example block content is never run through inline markup", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_example\n*not bold*\n#+end_example"),
    '<pre class="org-example"><code>*not bold*</code></pre>'
  );
});

test("renderOrgBody: example block escapes HTML special characters", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_example\n<div>&x</div>\n#+end_example"),
    '<pre class="org-example"><code>&lt;div&gt;&amp;x&lt;/div&gt;</code></pre>'
  );
});

test("renderOrgBody: example block marker matching is case-insensitive", () => {
  assertEqual(
    tree.renderOrgBody("#+BEGIN_EXAMPLE\nline\n#+END_EXAMPLE"),
    '<pre class="org-example"><code>line</code></pre>'
  );
});

test("renderOrgBody: unterminated example block runs to end of body", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_example\nforever"),
    '<pre class="org-example"><code>forever</code></pre>'
  );
});

// --- renderOrgBody: center blocks ---
test("renderOrgBody: center block renders as <div class=org-center>, hides markers", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_center\nCentered text\n#+end_center"),
    '<div class="org-center">Centered text</div>'
  );
});

test("renderOrgBody: center block content still processes inline markup", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_center\n*bold* text\n#+end_center"),
    '<div class="org-center"><strong>bold</strong> text</div>'
  );
});

test("renderOrgBody: center block marker matching is case-insensitive", () => {
  assertEqual(
    tree.renderOrgBody("#+BEGIN_CENTER\nline\n#+END_CENTER"),
    '<div class="org-center">line</div>'
  );
});

test("renderOrgBody: unterminated center block runs to end of body", () => {
  assertEqual(
    tree.renderOrgBody("#+begin_center\nforever"),
    '<div class="org-center">forever</div>'
  );
});

// --- Done ---
report();
