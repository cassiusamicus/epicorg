import * as tree from "./tree.js";
import { pruneMarkedDescendants, removeMatchedByTitle, cloneNodeForCopy } from "./bulk.js";

// --- Minimal test runner (same harness as tree_test.js/export_test.js) ---

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
}

function node(id, title, children = [], extra = {}) {
  return { id, title, body: "", status: "", tags: [], properties: {}, children, collapsed: false, ...extra };
}

// --- pruneMarkedDescendants ---

test("pruneMarkedDescendants: empty marked set yields no ids", () => {
  const t = [node("a", "A", [node("a1", "A1")])];
  assertEqual(pruneMarkedDescendants(t, new Set()), []);
});

test("pruneMarkedDescendants: single top-level marked node survives", () => {
  const t = [node("a", "A"), node("b", "B")];
  assertEqual(pruneMarkedDescendants(t, new Set(["a"])), ["a"]);
});

test("pruneMarkedDescendants: marked parent + marked child — only the parent survives", () => {
  const t = [node("a", "A", [node("a1", "A1")])];
  assertEqual(pruneMarkedDescendants(t, new Set(["a", "a1"])), ["a"]);
});

test("pruneMarkedDescendants: marked child, unmarked parent — the child survives", () => {
  const t = [node("a", "A", [node("a1", "A1")])];
  assertEqual(pruneMarkedDescendants(t, new Set(["a1"])), ["a1"]);
});

test("pruneMarkedDescendants: marked grandparent + marked grandchild (unmarked node between) — only the grandparent survives", () => {
  const t = [node("a", "A", [node("a1", "A1", [node("a1a", "A1A")])])];
  assertEqual(pruneMarkedDescendants(t, new Set(["a", "a1a"])), ["a"]);
});

test("pruneMarkedDescendants: marked siblings in different branches both survive independently", () => {
  const t = [node("a", "A", [node("a1", "A1")]), node("b", "B", [node("b1", "B1")])];
  assertEqual(pruneMarkedDescendants(t, new Set(["a1", "b1"])), ["a1", "b1"]);
});

test("pruneMarkedDescendants: empty tree yields no ids", () => {
  assertEqual(pruneMarkedDescendants([], new Set(["a"])), []);
});

// --- removeMatchedByTitle ---

test("removeMatchedByTitle: matches and removes a top-level node", () => {
  const t = [node("a", "Alpha"), node("b", "Beta")];
  const { remaining, removed } = removeMatchedByTitle(t, [{ title: "Alpha" }]);
  assertEqual(remaining.map((n) => n.id), ["b"]);
  assertEqual(removed.map((n) => n.id), ["a"]);
});

test("removeMatchedByTitle: finds and removes a nested match (regression — used to only scan the top level)", () => {
  const t = [node("project", "Project", [
    node("sub1", "Subtask One"),
    node("sub2", "Target Task"),
  ])];
  const { remaining, removed } = removeMatchedByTitle(t, [{ title: "Target Task" }]);
  assertEqual(removed.map((n) => n.id), ["sub2"]);
  assertEqual(remaining[0].children.map((n) => n.id), ["sub1"], "the nested match should be gone from its parent's children");
  assertEqual(remaining[0].id, "project", "the parent itself stays, just with one fewer child");
});

test("removeMatchedByTitle: a removed node keeps its own children intact (moves as a whole subtree)", () => {
  const t = [node("a", "Target", [node("a1", "Child One"), node("a2", "Child Two")])];
  const { removed } = removeMatchedByTitle(t, [{ title: "Target" }]);
  assertEqual(removed[0].children.map((n) => n.id), ["a1", "a2"]);
});

test("removeMatchedByTitle: a match several levels deep is still found", () => {
  const t = [node("a", "A", [node("b", "B", [node("c", "C", [node("d", "Deep Target")])])])];
  const { removed, remaining } = removeMatchedByTitle(t, [{ title: "Deep Target" }]);
  assertEqual(removed.map((n) => n.id), ["d"]);
  assertEqual(remaining[0].children[0].children[0].children, []);
});

test("removeMatchedByTitle: two different marked items sharing a title each remove one occurrence", () => {
  const t = [node("a", "Dup"), node("b", "Dup"), node("c", "Dup")];
  const { remaining, removed } = removeMatchedByTitle(t, [{ title: "Dup" }, { title: "Dup" }]);
  assertEqual(removed.length, 2);
  assertEqual(remaining.length, 1);
});

test("removeMatchedByTitle: a title with no matching marked item is left alone even if duplicated elsewhere", () => {
  const t = [node("a", "Dup"), node("b", "Dup")];
  const { remaining, removed } = removeMatchedByTitle(t, [{ title: "Dup" }]);
  assertEqual(removed.length, 1);
  assertEqual(remaining.length, 1);
});

test("removeMatchedByTitle: no match anywhere leaves the tree untouched", () => {
  const t = [node("a", "Alpha", [node("a1", "Nested")])];
  const { remaining, removed } = removeMatchedByTitle(t, [{ title: "Nonexistent" }]);
  assertEqual(removed, []);
  assertEqual(remaining, t);
});

test("removeMatchedByTitle: an empty items list removes nothing", () => {
  const t = [node("a", "Alpha")];
  const { remaining, removed } = removeMatchedByTitle(t, []);
  assertEqual(removed, []);
  assertEqual(remaining.map((n) => n.id), ["a"]);
});

test("removeMatchedByTitle: a sibling's children array is left by reference when nothing inside it matches", () => {
  const untouchedChildren = [node("x1", "X1")];
  const t = [node("a", "Alpha", untouchedChildren), node("b", "Target")];
  const { remaining } = removeMatchedByTitle(t, [{ title: "Target" }]);
  assert(remaining[0].children === untouchedChildren, "unaffected node's children array should be the same reference, not a needless copy");
});

test("removeMatchedByTitle: matching the root of one branch doesn't disturb a sibling branch", () => {
  const t = [node("a", "Target", [node("a1", "A1")]), node("b", "Keep", [node("b1", "B1")])];
  const { remaining } = removeMatchedByTitle(t, [{ title: "Target" }]);
  assertEqual(remaining.map((n) => n.id), ["b"]);
  assertEqual(remaining[0].children.map((n) => n.id), ["b1"]);
});

// --- cloneNodeForCopy ---

test("cloneNodeForCopy: produces a fresh id distinct from the original", () => {
  const n = node("orig", "Title");
  const clone = cloneNodeForCopy(n);
  assert(clone.id !== "orig");
});

test("cloneNodeForCopy: deep-clones children, each with their own fresh id", () => {
  const n = node("a", "A", [node("a1", "A1"), node("a2", "A2")]);
  const clone = cloneNodeForCopy(n);
  assertEqual(clone.children.length, 2);
  assert(clone.children[0].id !== "a1" && clone.children[1].id !== "a2");
  assert(clone.children[0].id !== clone.children[1].id, "sibling clones must not collide with each other either");
});

test("cloneNodeForCopy: strips TRANSCLUDE_ID but keeps TRANSCLUDE", () => {
  const n = node("a", "A", [], { properties: { TRANSCLUDE_ID: "tc-123", TRANSCLUDE: "other.org::tc-456", OTHER: "kept" } });
  const clone = cloneNodeForCopy(n);
  assertEqual(clone.properties.TRANSCLUDE_ID, undefined);
  assertEqual(clone.properties.TRANSCLUDE, "other.org::tc-456");
  assertEqual(clone.properties.OTHER, "kept");
});

test("cloneNodeForCopy: always resets collapsed to false", () => {
  const n = node("a", "A", [], { collapsed: true });
  assertEqual(cloneNodeForCopy(n).collapsed, false);
});

test("cloneNodeForCopy: tags array is an independent copy, not the same reference", () => {
  const n = node("a", "A", [], { tags: ["x", "y"] });
  const clone = cloneNodeForCopy(n);
  assertEqual(clone.tags, ["x", "y"]);
  assert(clone.tags !== n.tags);
  clone.tags.push("z");
  assertEqual(n.tags, ["x", "y"], "mutating the clone's tags must not affect the original");
});

test("cloneNodeForCopy: properties object is an independent copy, not the same reference", () => {
  const n = node("a", "A", [], { properties: { FOO: "bar" } });
  const clone = cloneNodeForCopy(n);
  assert(clone.properties !== n.properties);
});

test("cloneNodeForCopy: missing optional fields default to empty values", () => {
  const minimal = { id: "a", children: [] };
  const clone = cloneNodeForCopy(minimal);
  assertEqual(clone.title, "");
  assertEqual(clone.body, "");
  assertEqual(clone.status, "");
  assertEqual(clone.priority, "");
  assertEqual(clone.tags, []);
  assertEqual(clone.properties, {});
});

report();
