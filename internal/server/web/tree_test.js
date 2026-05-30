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
  const tree = [node("a", "A"), node("b", "B")];
  const flat = tree.flattenVisible(tree);
  assertEqual(flat.length, 2);
  assertEqual(flat[0].id, "a");
  assertEqual(flat[1].id, "b");
});

test("flattenVisible: nested children visible", () => {
  const tree = [node("a", "A", [node("a1", "A1"), node("a2", "A2")]), node("b", "B")];
  const flat = tree.flattenVisible(tree);
  assertEqual(flat.length, 4);
  assertEqual(flat.map(n => n.id), ["a", "a1", "a2", "b"]);
});

test("flattenVisible: collapsed hides children", () => {
  const tree = [{ ...node("a", "A", [node("a1", "A1")]), collapsed: true }, node("b", "B")];
  const flat = tree.flattenVisible(tree);
  assertEqual(flat.length, 2);
  assertEqual(flat.map(n => n.id), ["a", "b"]);
});

test("flattenVisible: empty input", () => {
  assertEqual(tree.flattenVisible([]).length, 0);
  assertEqual(tree.flattenVisible(null).length, 0);
});

// findNode
test("findNode: root level", () => {
  const tree = [node("a", "A"), node("b", "B")];
  assertEqual(tree.findNode(tree, "b").title, "B");
});

test("findNode: nested", () => {
  const tree = [node("a", "A", [node("a1", "A1", [node("deep", "Deep")])])];
  assertEqual(tree.findNode(tree, "deep").title, "Deep");
});

test("findNode: not found returns null", () => {
  assertEqual(tree.findNode([node("a", "A")], "z"), null);
});

// findParentInfo
test("findParentInfo: root node", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const info = tree.findParentInfo(tree, "b");
  assertEqual(info.parent, null);
  assertEqual(info.index, 1);
});

test("findParentInfo: nested node", () => {
  const tree = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const info = tree.findParentInfo(tree, "a2");
  assertEqual(info.parent.id, "a");
  assertEqual(info.index, 1);
});

// updateNodeField
test("updateNodeField: updates title at root", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const result = tree.updateNodeField(tree, "b", "title", "B2");
  assertEqual(result[1].title, "B2");
  assertEqual(result[0].title, "A"); // unchanged
});

test("updateNodeField: updates nested node", () => {
  const tree = [node("a", "A", [node("a1", "old")])];
  const result = tree.updateNodeField(tree, "a1", "title", "new");
  assertEqual(result[0].children[0].title, "new");
});

test("updateNodeField: immutable — original unchanged", () => {
  const tree = [node("a", "A")];
  const result = tree.updateNodeField(tree, "a", "title", "X");
  assertEqual(tree[0].title, "A");
  assertEqual(result[0].title, "X");
});

// insertSiblingAfter
test("insertSiblingAfter: at root level", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const { nodes: result, newId } = tree.insertSiblingAfter(tree, "a");
  assertEqual(result.length, 3);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, newId);
  assertEqual(result[2].id, "b");
});

test("insertSiblingAfter: nested", () => {
  const tree = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const { nodes: result } = tree.insertSiblingAfter(tree, "a1");
  assertEqual(result[0].children.length, 3);
  assertEqual(result[0].children[0].id, "a1");
  assertEqual(result[0].children[2].id, "a2");
});

// removeNode
test("removeNode: removes from root", () => {
  const tree = [node("a", "A"), node("b", "B"), node("c", "C")];
  const result = tree.removeNode(tree, "b");
  assertEqual(result.length, 2);
  assertEqual(result.map(n => n.id), ["a", "c"]);
});

test("removeNode: removes nested", () => {
  const tree = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const result = tree.removeNode(tree, "a1");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "a2");
});

test("removeNode: preserves unrelated branches", () => {
  const tree = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.removeNode(tree, "a1");
  assertEqual(result.length, 2);
  assertEqual(result[1].id, "b");
});

// indentNode
test("indentNode: becomes child of previous sibling", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const result = tree.indentNode(tree, "b");
  assertEqual(result.length, 1);
  assertEqual(result[0].id, "a");
  assertEqual(result[0].children.length, 1);
  assertEqual(result[0].children[0].id, "b");
});

test("indentNode: first child cannot indent", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const result = tree.indentNode(tree, "a");
  assertEqual(result, tree); // unchanged
});

test("indentNode: uncollapses new parent", () => {
  const tree = [{ ...node("a", "A"), collapsed: true }, node("b", "B")];
  const result = tree.indentNode(tree, "b");
  assertEqual(result[0].collapsed, false);
});

test("indentNode: appends to existing children", () => {
  const tree = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.indentNode(tree, "b");
  assertEqual(result[0].children.length, 2);
  assertEqual(result[0].children[0].id, "a1");
  assertEqual(result[0].children[1].id, "b");
});

// outdentNode
test("outdentNode: becomes sibling of parent", () => {
  const tree = [node("a", "A", [node("a1", "A1")])];
  const result = tree.outdentNode(tree, "a1");
  assertEqual(result.length, 2);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, "a1");
  assertEqual(result[0].children.length, 0);
});

test("outdentNode: root node cannot outdent", () => {
  const tree = [node("a", "A")];
  const result = tree.outdentNode(tree, "a");
  assertEqual(result, tree); // unchanged
});

test("outdentNode: inserts after parent, not at end", () => {
  const tree = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.outdentNode(tree, "a1");
  assertEqual(result.length, 3);
  assertEqual(result.map(n => n.id), ["a", "a1", "b"]);
});

// moveNodeUp
test("moveNodeUp: swaps with previous sibling", () => {
  const tree = [node("a", "A"), node("b", "B"), node("c", "C")];
  const result = tree.moveNodeUp(tree, "b");
  assertEqual(result.map(n => n.id), ["b", "a", "c"]);
});

test("moveNodeUp: first node cannot move up", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const result = tree.moveNodeUp(tree, "a");
  assertEqual(result, tree);
});

test("moveNodeUp: works within nested children", () => {
  const tree = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const result = tree.moveNodeUp(tree, "a2");
  assertEqual(result[0].children.map(n => n.id), ["a2", "a1"]);
});

// moveNodeDown
test("moveNodeDown: swaps with next sibling", () => {
  const tree = [node("a", "A"), node("b", "B"), node("c", "C")];
  const result = tree.moveNodeDown(tree, "b");
  assertEqual(result.map(n => n.id), ["a", "c", "b"]);
});

test("moveNodeDown: last node cannot move down", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const result = tree.moveNodeDown(tree, "b");
  assertEqual(result, tree);
});

test("moveNodeDown: works within nested children", () => {
  const tree = [node("a", "A", [node("a1", "A1"), node("a2", "A2")])];
  const result = tree.moveNodeDown(tree, "a1");
  assertEqual(result[0].children.map(n => n.id), ["a2", "a1"]);
});

// foldToLevel
test("foldToLevel 1: collapses all root nodes", () => {
  const tree = [node("a", "A", [node("a1", "A1")]), node("b", "B")];
  const result = tree.foldToLevel(tree, 1);
  assertEqual(result[0].collapsed, true);
  assertEqual(result[1].collapsed, false); // no children
});

test("foldToLevel 2: root visible, level 2 collapsed", () => {
  const tree = [node("a", "A", [node("a1", "A1", [node("deep", "Deep")])])];
  const result = tree.foldToLevel(tree, 2);
  assertEqual(result[0].collapsed, false); // depth 1 < level 2
  assertEqual(result[0].children[0].collapsed, true); // depth 2 >= level 2
});

test("foldToLevel: leaf nodes stay uncollapsed", () => {
  const tree = [node("a", "A")];
  const result = tree.foldToLevel(tree, 1);
  assertEqual(result[0].collapsed, false); // no children to collapse
});

// uncollapseToNode
test("uncollapseToNode: uncollapses ancestors", () => {
  const tree = [{ ...node("a", "A", [{ ...node("a1", "A1", [node("deep", "Deep")]), collapsed: true }]), collapsed: true }];
  const result = tree.uncollapseToNode(tree, "deep");
  assertEqual(result[0].collapsed, false);
  assertEqual(result[0].children[0].collapsed, false);
});

test("uncollapseToNode: doesn't change unrelated nodes", () => {
  const tree = [
    { ...node("a", "A", [node("a1", "A1")]), collapsed: true },
    { ...node("b", "B", [node("b1", "B1")]), collapsed: true },
  ];
  const result = tree.uncollapseToNode(tree, "a1");
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
  assertEqual(tree.nextStatus("TODO"), "DONE");
  assertEqual(tree.nextStatus("DONE"), "");
});

test("nextStatus: handles undefined", () => {
  assertEqual(tree.nextStatus(undefined), "TODO");
});

// --- Edge cases ---

test("indent then outdent is identity", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const indented = tree.indentNode(tree, "b");
  const result = tree.outdentNode(indented, "b");
  assertEqual(result.length, 2);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, "b");
});

test("insert then remove is identity", () => {
  const tree = [node("a", "A"), node("b", "B")];
  const { nodes: inserted, newId } = tree.insertSiblingAfter(tree, "a");
  const result = tree.removeNode(inserted, newId);
  assertEqual(result.length, 2);
  assertEqual(result[0].id, "a");
  assertEqual(result[1].id, "b");
});

test("moveUp then moveDown is identity", () => {
  const tree = [node("a", "A"), node("b", "B"), node("c", "C")];
  const moved = tree.moveNodeUp(tree, "b");
  const result = tree.moveNodeDown(moved, "b");
  assertEqual(result.map(n => n.id), ["a", "b", "c"]);
});

// fuzzyMatch
test("fuzzyMatch: empty query matches anything", () => {
  assertEqual(tree.fuzzyMatch("", "hello"), true);
  assertEqual(tree.fuzzyMatch("", ""), true);
});

test("fuzzyMatch: exact substring matches", () => {
  assertEqual(tree.fuzzyMatch("hello", "hello world"), true);
});

test("fuzzyMatch: characters in order with gaps", () => {
  assertEqual(tree.fuzzyMatch("hwo", "hello world"), true);
  assertEqual(tree.fuzzyMatch("hlo", "hello"), true);
});

test("fuzzyMatch: out-of-order characters do not match", () => {
  assertEqual(tree.fuzzyMatch("woh", "hello world"), false);
});

test("fuzzyMatch: missing characters do not match", () => {
  assertEqual(tree.fuzzyMatch("xyz", "hello"), false);
});

test("fuzzyMatch: case insensitive", () => {
  assertEqual(tree.fuzzyMatch("HELLO", "hello world"), true);
  assertEqual(tree.fuzzyMatch("hello", "HELLO WORLD"), true);
});

test("fuzzyMatch: handles null/undefined text", () => {
  assertEqual(tree.fuzzyMatch("a", null), false);
  assertEqual(tree.fuzzyMatch("a", undefined), false);
  assertEqual(tree.fuzzyMatch("", null), true);
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

test("filterTree: matching node keeps all descendants", () => {
  const t = [node("a", "alpha", [node("a1", "x"), node("a2", "y")])];
  const result = tree.filterTree(t, "alpha");
  assertEqual(result[0].children.length, 2);
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

// --- Done ---
report();
