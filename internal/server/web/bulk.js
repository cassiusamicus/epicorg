// Pure helpers shared by every "Marked For Action" bulk-action system
// (Outline, Journal, Agenda, TODO) — split out of app.js so they're
// testable directly under plain Node (app.js itself pulls in browser-only
// React/htm imports that Node can't resolve). See bulk_test.js.
import * as tree from "./tree.js";

// Filters a marked-id set down to only the "outermost" marked nodes — if
// both a node and one of its own descendants are marked, only the
// ancestor's id survives, since a bulk action on it already carries the
// whole marked subtree along (mirrors how a single node's own Delete/Copy
// already includes its children). Used by the outline's own "Marked For
// Action" (see App's markedNodeIds) — the journal/agenda/todo views mark
// by file+title instead of id, so they never need this.
export function pruneMarkedDescendants(nodesList, markedIds) {
  const result = [];
  function walk(list, ancestorMarked) {
    for (const n of list) {
      const isMarked = markedIds.has(n.id);
      if (isMarked && !ancestorMarked) result.push(n.id);
      if (n.children?.length > 0) walk(n.children, ancestorMarked || isMarked);
    }
  }
  walk(nodesList, false);
  return result;
}

// Splits nodesList into { remaining, removed } based on items ([{title}]),
// matching the first N occurrences of each title where N is how many times
// that title appears in items — so two different marked items that happen
// to share a title each still remove one occurrence, not zero or both.
// Searches the whole tree, not just the top level — Agenda/TODO's marked
// items are routinely nested (a TODO under a project heading, an
// appointment under a sub-section), unlike Journal's always-top-level day
// entries, so a match found at any depth is removed as a whole subtree
// (its own children never get matched individually — they moved with it).
// Shared by crossFileBulkAction for every bulk action that needs to pull
// matched nodes out of a file (delete, move, move/copy to a new outline,
// to-other-pane).
export function removeMatchedByTitle(nodesList, items) {
  const counts = new Map();
  for (const it of items) counts.set(it.title, (counts.get(it.title) || 0) + 1);
  const removed = [];
  // Returns `list` itself, unchanged, when nothing inside it (at this level
  // or any nested one) matched — not just a same-contents copy, the actual
  // original reference — so an untouched branch never forces its ancestors
  // into needless new-object churn on the way back up.
  function walk(list) {
    let changed = false;
    const kept = [];
    for (const n of list) {
      const c = counts.get(n.title) || 0;
      if (c > 0) {
        counts.set(n.title, c - 1);
        removed.push(n);
        changed = true;
      } else {
        const newChildren = n.children?.length > 0 ? walk(n.children) : n.children;
        if (newChildren !== n.children) {
          kept.push({ ...n, children: newChildren });
          changed = true;
        } else {
          kept.push(n);
        }
      }
    }
    return changed ? kept : list;
  }
  const remaining = walk(nodesList);
  return { remaining, removed };
}

// Deep-clones a node for any "Copy"-flavored bulk/journal action — fresh
// ids throughout (so the duplicate never collides with the original) and
// TRANSCLUDE_ID stripped (a duplicate must not claim to be the same
// transclusion source as the node it was copied from; TRANSCLUDE itself,
// a pointer *to* another source, is left as-is — copying the pointer is
// exactly what "copy" should do for a transcluding node).
export function cloneNodeForCopy(node) {
  const properties = { ...(node.properties || {}) };
  delete properties.TRANSCLUDE_ID;
  return {
    id: tree.newId(),
    title: node.title || "",
    body: node.body || "",
    status: node.status || "",
    priority: node.priority || "",
    tags: [...(node.tags || [])],
    properties,
    children: (node.children || []).map(cloneNodeForCopy),
    collapsed: false,
  };
}
