// Tree manipulation helpers — pure functions, no React dependency.
// Used by app.js and tested by tree_test.js.

// --- ID generator ---

let _nextId = 1;
export function resetIdCounter(start = 1) { _nextId = start; }
export function newId() { return `n${_nextId++}`; }

// --- Node constructor ---

export function newNode(title = "") {
  return {
    id: newId(),
    title,
    body: "",
    status: "",
    tags: [],
    properties: {},
    children: [],
    collapsed: false,
  };
}

// --- Query helpers ---

export function isDescendantOrSelf(nodes, ancestorId, testId) {
  if (ancestorId === testId) return true;
  const anc = findNode(nodes, ancestorId);
  if (!anc) return false;
  return !!findNode(anc.children || [], testId);
}

export function flattenAll(nodes, depth = 0) {
  const out = [];
  for (const n of (nodes || [])) {
    out.push({ id: n.id, node: n, depth });
    if (n.children?.length > 0) for (const x of flattenAll(n.children, depth + 1)) out.push(x);
  }
  return out;
}

function buildTreeFromFlat(flat) {
  const root = [];
  const stack = [];
  for (const { node, depth } of flat) {
    const n = { ...node, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (!stack.length) root.push(n);
    else stack[stack.length - 1].node.children.push(n);
    stack.push({ node: n, depth });
  }
  return root;
}

export function moveDragNode(nodes, dragId, afterId, targetDepth) {
  const full = flattenAll(nodes);
  const dragIdx = full.findIndex(x => x.id === dragId);
  if (dragIdx < 0) return nodes;
  const dragDepth = full[dragIdx].depth;
  let end = dragIdx + 1;
  while (end < full.length && full[end].depth > dragDepth) end++;
  const subtree = full.slice(dragIdx, end);
  const rem = [...full.slice(0, dragIdx), ...full.slice(end)];

  let insertAt;
  if (afterId === null) {
    insertAt = 0;
  } else {
    const ai = rem.findIndex(x => x.id === afterId);
    if (ai < 0) return nodes;
    insertAt = ai + 1;
    while (insertAt < rem.length && rem[insertAt].depth > rem[ai].depth) insertAt++;
  }

  const delta = targetDepth - dragDepth;
  const shifted = subtree.map(x => ({ ...x, depth: x.depth + delta }));
  return buildTreeFromFlat([...rem.slice(0, insertAt), ...shifted, ...rem.slice(insertAt)]);
}

export function flattenVisible(nodes) {
  const result = [];
  function walk(list) {
    for (const n of list) {
      result.push(n);
      if (n.children?.length > 0 && !n.collapsed) walk(n.children);
    }
  }
  walk(nodes || []);
  return result;
}

export function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children?.length > 0) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function findNodeByProperty(nodes, propName, propValue) {
  for (const n of nodes) {
    if (n.properties?.[propName] === propValue) return n;
    if (n.children?.length > 0) {
      const found = findNodeByProperty(n.children, propName, propValue);
      if (found) return found;
    }
  }
  return null;
}

export function findNodeByTitle(nodes, title) {
  for (const n of nodes) {
    if (n.title === title) return n;
    if (n.children?.length > 0) {
      const found = findNodeByTitle(n.children, title);
      if (found) return found;
    }
  }
  return null;
}

export function findParentInfo(nodes, id, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { parent, parentList: nodes, index: i };
    if (nodes[i].children?.length > 0) {
      const found = findParentInfo(nodes[i].children, id, nodes[i]);
      if (found) return found;
    }
  }
  return null;
}

// --- Field update ---

export function updateNodeField(nodes, nodeId, field, value) {
  return nodes.map((n) => {
    if (n.id === nodeId) return { ...n, [field]: value };
    if (n.children?.length > 0) return { ...n, children: updateNodeField(n.children, nodeId, field, value) };
    return n;
  });
}

export function mapNode(nodes, id, fn) {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children?.length > 0) {
      const updated = mapNode(n.children, id, fn);
      return updated !== n.children ? { ...n, children: updated } : n;
    }
    return n;
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces every occurrence of `find` (case-insensitive) with `replace`
// across every node's title and body. Pass `onlyId` to scope the replace to
// a single node (used for "replace in this match, then move on"). Returns
// { nodes, count } — count is the total number of occurrences replaced.
export function replaceInTree(nodes, find, replace, onlyId = null) {
  if (!find) return { nodes, count: 0 };
  const re = new RegExp(escapeRegExp(find), "gi");
  const safeReplacement = String(replace).replace(/\$/g, "$$$$");
  let count = 0;
  const replaceField = (val) => {
    if (typeof val !== "string" || !val) return val;
    const matches = val.match(re);
    if (!matches) return val;
    count += matches.length;
    return val.replace(re, safeReplacement);
  };
  const walk = (list) => list.map((n) => {
    const apply = !onlyId || n.id === onlyId;
    const newTitle = apply ? replaceField(n.title) : n.title;
    const newBody = apply ? replaceField(n.body) : n.body;
    const newChildren = n.children?.length > 0 ? walk(n.children) : n.children;
    if (newTitle === n.title && newBody === n.body && newChildren === n.children) return n;
    return { ...n, title: newTitle, body: newBody, children: newChildren };
  });
  return { nodes: walk(nodes), count };
}

// --- Structural operations ---

export function insertAfter(nodes, afterId, nn) {
  const result = [];
  for (const n of nodes) {
    if (n.id === afterId) {
      result.push({ ...n, children: n.children ? [...n.children] : [] });
      result.push(nn);
    } else {
      const updated = n.children?.length > 0 ? insertAfter(n.children, afterId, nn) : n.children;
      result.push(updated !== n.children ? { ...n, children: updated } : n);
    }
  }
  return result;
}

export function insertSiblingAfter(nodes, afterId) {
  const nn = newNode();
  return { nodes: insertAfter(nodes, afterId, nn), newId: nn.id };
}

// Duplicates a node and its full subtree as a new sibling directly after,
// generating fresh ids throughout so the copy is fully independent (editing
// one never touches the other).
export function duplicateNode(nodes, id) {
  function cloneDeep(n) {
    return { ...n, id: newId(), children: (n.children || []).map(cloneDeep) };
  }
  let dupId = null;
  function walk(list) {
    const result = [];
    for (const n of list) {
      if (n.id === id) {
        const clone = cloneDeep(n);
        dupId = clone.id;
        result.push(n, clone);
      } else {
        result.push(n.children?.length > 0 ? { ...n, children: walk(n.children) } : n);
      }
    }
    return result;
  }
  return { nodes: walk(nodes), newId: dupId };
}

// Inserts a deep clone of extNode (regenerating every id throughout, so it
// can never collide with an id already in nodes) as a new sibling directly
// after afterId. Used by the node clipboard's Paste — unlike duplicateNode,
// extNode comes from outside the tree (whatever was last Cut or Copied),
// not looked up by id within it.
export function pasteNodeAfter(nodes, afterId, extNode) {
  function cloneDeep(n) {
    return { ...n, id: newId(), children: (n.children || []).map(cloneDeep) };
  }
  const clone = cloneDeep(extNode);
  return { nodes: insertAfter(nodes, afterId, clone), newId: clone.id };
}

export function insertBefore(nodes, beforeId, nn) {
  const result = [];
  for (const n of nodes) {
    if (n.id === beforeId) {
      result.push(nn);
      result.push(n);
    } else {
      const updated = n.children?.length > 0 ? insertBefore(n.children, beforeId, nn) : n.children;
      result.push(updated !== n.children ? { ...n, children: updated } : n);
    }
  }
  return result;
}

// Enter pressed at the very start of a title (cursor before the first
// character) inserts the new blank node here and pushes the existing
// heading (and its children) down, rather than appending an empty sibling
// after it — mirrors how a plain textarea splits text at the cursor rather
// than always appending at the end.
export function insertSiblingBefore(nodes, beforeId) {
  const nn = newNode();
  return { nodes: insertBefore(nodes, beforeId, nn), newId: nn.id };
}

export function removeNode(nodes, id) {
  const result = [];
  for (const n of nodes) {
    if (n.id === id) continue;
    const updated = n.children?.length > 0 ? removeNode(n.children, id) : n.children;
    result.push(updated !== n.children ? { ...n, children: updated } : n);
  }
  return result;
}

export function indentNode(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || info.index === 0) return nodes;
  const prevSibling = info.parentList[info.index - 1];
  const node = info.parentList[info.index];
  let result = removeNode(nodes, id);
  result = mapNode(result, prevSibling.id, (n) => ({
    ...n, collapsed: false, children: [...(n.children || []), { ...node }],
  }));
  return result;
}

export function outdentNode(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || !info.parent) return nodes;
  const node = info.parentList[info.index];
  let result = removeNode(nodes, id);
  result = insertAfter(result, info.parent.id, { ...node });
  return result;
}

export function moveNodeUp(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || info.index === 0) return nodes;
  const list = [...info.parentList];
  [list[info.index - 1], list[info.index]] = [list[info.index], list[info.index - 1]];
  if (!info.parent) return list;
  return mapNode(nodes, info.parent.id, (n) => ({ ...n, children: list }));
}

export function moveNodeDown(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || info.index >= info.parentList.length - 1) return nodes;
  const list = [...info.parentList];
  [list[info.index], list[info.index + 1]] = [list[info.index + 1], list[info.index]];
  if (!info.parent) return list;
  return mapNode(nodes, info.parent.id, (n) => ({ ...n, children: list }));
}

// "Heading only" variants — the node moves but its children are left behind as
// siblings, promoted to the same level as the node was.

export function indentNodeOnly(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || info.index === 0) return nodes;
  const node = info.parentList[info.index];
  const prevSibling = info.parentList[info.index - 1];
  const children = node.children || [];
  const childlessNode = { ...node, children: [] };
  // Promote children into sibling list at node's former position
  const newSiblings = [
    ...info.parentList.slice(0, info.index),
    ...children,
    ...info.parentList.slice(info.index + 1),
  ];
  let result = info.parent
    ? mapNode(nodes, info.parent.id, (n) => ({ ...n, children: newSiblings }))
    : newSiblings;
  // Append childless node as last child of previous sibling
  result = mapNode(result, prevSibling.id, (n) => ({
    ...n, collapsed: false, children: [...(n.children || []), childlessNode],
  }));
  return result;
}

export function outdentNodeOnly(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || !info.parent) return nodes;
  const node = info.parentList[info.index];
  const children = node.children || [];
  const childlessNode = { ...node, children: [] };
  // Promote children into parent's child list at node's former position
  const newParentChildren = [
    ...info.parentList.slice(0, info.index),
    ...children,
    ...info.parentList.slice(info.index + 1),
  ];
  let result = mapNode(nodes, info.parent.id, (n) => ({ ...n, children: newParentChildren }));
  // Place childless node after its former parent
  result = insertAfter(result, info.parent.id, childlessNode);
  return result;
}

export function moveNodeUpOnly(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || info.index === 0) return nodes;
  const node = info.parentList[info.index];
  const children = node.children || [];
  const childlessNode = { ...node, children: [] };
  const idx = info.index;
  // Promote children into sibling list, then insert childless node before prev sibling
  const promoted = [
    ...info.parentList.slice(0, idx),
    ...children,
    ...info.parentList.slice(idx + 1),
  ];
  const result = [
    ...promoted.slice(0, idx - 1),
    childlessNode,
    ...promoted.slice(idx - 1),
  ];
  if (!info.parent) return result;
  return mapNode(nodes, info.parent.id, (n) => ({ ...n, children: result }));
}

export function moveNodeDownOnly(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info || info.index >= info.parentList.length - 1) return nodes;
  const node = info.parentList[info.index];
  const children = node.children || [];
  const childlessNode = { ...node, children: [] };
  const idx = info.index;
  const n = children.length;
  // Promote children into sibling list, then insert childless node after next sibling
  const promoted = [
    ...info.parentList.slice(0, idx),
    ...children,
    ...info.parentList.slice(idx + 1),
  ];
  const insertAt = idx + n + 1;
  const result = [
    ...promoted.slice(0, insertAt),
    childlessNode,
    ...promoted.slice(insertAt),
  ];
  if (!info.parent) return result;
  return mapNode(nodes, info.parent.id, (np) => ({ ...np, children: result }));
}

// Split a node's title at pos: left part stays in the node (with children),
// right part becomes a new sibling immediately after. Pairs with
// splitBodyAtCursor below — same "new sibling directly after" shape, just
// title vs. body as the field being split.
export function splitNode(nodes, id, pos) {
  const nn = newNode();
  function walk(list) {
    const result = [];
    for (const n of list) {
      if (n.id === id) {
        nn.title = (n.title || "").slice(pos);
        result.push({ ...n, title: (n.title || "").slice(0, pos) });
        result.push(nn);
      } else {
        result.push(n.children?.length > 0 ? { ...n, children: walk(n.children) } : n);
      }
    }
    return result;
  }
  return { nodes: walk(nodes), newId: nn.id };
}

// Join a node with its next sibling: titles joined with a space (unless one
// is empty), bodies joined with a newline, children concatenated.
// Returns { nodes, cursorPos } where cursorPos is the original title length
// (the join point), useful for restoring the cursor.
export function joinNodes(nodes, id) {
  const info = findParentInfo(nodes, id);
  if (!info) return { nodes, cursorPos: 0 };
  const { parentList, index, parent } = info;
  if (index >= parentList.length - 1) return { nodes, cursorPos: 0 };
  const node = parentList[index];
  const next = parentList[index + 1];
  const cursorPos = (node.title || "").length;
  const sep = (node.title && next.title) ? " " : "";
  const merged = {
    ...node,
    title: (node.title || "") + sep + (next.title || ""),
    body: [node.body, next.body].filter(Boolean).join("\n"),
    children: [...(node.children || []), ...(next.children || [])],
  };
  const newList = [...parentList.slice(0, index), merged, ...parentList.slice(index + 2)];
  if (!parent) return { nodes: newList, cursorPos };
  return { nodes: mapNode(nodes, parent.id, (n) => ({ ...n, children: newList })), cursorPos };
}

// Split a node's body/note at pos: left part stays as this node's body,
// right part becomes a new sibling's body, inserted immediately after (empty
// title, no children — mirrors splitNode's title-split shape).
export function splitBodyAtCursor(nodes, id, pos) {
  const nn = newNode();
  function walk(list) {
    const result = [];
    for (const n of list) {
      if (n.id === id) {
        const body = n.body || "";
        nn.body = body.slice(pos);
        result.push({ ...n, body: body.slice(0, pos) });
        result.push(nn);
      } else {
        result.push(n.children?.length > 0 ? { ...n, children: walk(n.children) } : n);
      }
    }
    return result;
  }
  return { nodes: walk(nodes), newId: nn.id };
}

// Converts a node's whole note/body into a new child node: the note text
// becomes the new node's title as-is (line breaks included), inserted as
// the first child, and the original note is cleared — the reverse of
// turning a heading into a note. No-op if the node has no note.
export function convertNoteToNode(nodes, id) {
  const nn = newNode();
  let newIdOut = null;
  function walk(list) {
    return list.map((n) => {
      if (n.id === id) {
        if (!n.body) return n;
        nn.title = n.body;
        newIdOut = nn.id;
        return { ...n, body: "", collapsed: false, children: [nn, ...(n.children || [])] };
      }
      return n.children?.length > 0 ? { ...n, children: walk(n.children) } : n;
    });
  }
  const result = walk(nodes);
  return { nodes: result, newId: newIdOut };
}

// --- Folding ---

export function foldToLevel(nodes, level, depth = 1) {
  return nodes.map((n) => ({
    ...n,
    collapsed: n.children?.length > 0 && depth >= level,
    children: n.children?.length > 0 ? foldToLevel(n.children, level, depth + 1) : n.children,
  }));
}

export function uncollapseToNode(nodes, targetId) {
  function walk(list) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === targetId) return [list, true];
      if (list[i].children?.length > 0) {
        const [updated, found] = walk(list[i].children);
        if (found) {
          const newList = [...list];
          newList[i] = { ...list[i], collapsed: false, children: updated };
          return [newList, true];
        }
      }
    }
    return [list, false];
  }
  const [result] = walk(nodes);
  return result;
}

// --- Org date helpers ---

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatOrgDate(isoDate) {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T00:00:00");
  return `<${isoDate} ${DAYS[d.getDay()]}>`;
}

export function formatOrgScheduled(isoDate, time, repeater) {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T00:00:00");
  const day = DAYS[d.getDay()];
  let s = `<${isoDate} ${day}`;
  if (time) s += ` ${time}`;
  if (repeater) s += ` ${repeater}`;
  return s + ">";
}

export function parseOrgRepeater(orgDate) {
  if (!orgDate) return "";
  const m = orgDate.match(/([.+]?\+\d+[dwmy])/);
  return m ? m[1] : "";
}

export function parseOrgDate(orgDate) {
  if (!orgDate) return "";
  const m = orgDate.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

export function parseOrgScheduledTime(orgDate) {
  if (!orgDate) return "";
  const m = orgDate.match(/\d{4}-\d{2}-\d{2}\s+\w+\s+(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

// --- Preamble #+TITLE: ---

export function extractPreambleTitle(preamble) {
  const m = (preamble || "").match(/^#\+TITLE:\s*(.*)$/im);
  return m ? m[1].trim() : "";
}

// Sets (or removes, when title is empty) the #+TITLE: line within the
// preamble, preserving every other line as-is.
export function setPreambleTitle(preamble, title) {
  const trimmed = (title || "").trim();
  if (!preamble) return trimmed ? "#+TITLE: " + trimmed : "";
  const lines = preamble.split("\n");
  const idx = lines.findIndex((l) => /^#\+TITLE:/i.test(l));
  if (trimmed) {
    const line = "#+TITLE: " + trimmed;
    if (idx >= 0) lines[idx] = line;
    else lines.unshift(line);
  } else if (idx >= 0) {
    lines.splice(idx, 1);
  }
  return lines.join("\n");
}

// --- File picker formatting ---

export function formatFileSize(bytes) {
  if (bytes == null || isNaN(bytes)) return "";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return (value < 10 ? value.toFixed(1) : Math.round(value)) + " " + units[unitIndex];
}

export function formatFileDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

// --- Status ---

export const STATUS_CYCLE = ["", "TODO", "NEXT", "URGENT", "WAITING", "DONE", "CANCELLED"];

export function nextStatus(current) {
  const idx = STATUS_CYCLE.indexOf(current || "");
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}

// --- Search ---

// Case-insensitive substring match. Titles are often full sentences/paragraphs
// rather than short labels, where subsequence-style fuzzy matching produces
// false positives (almost any short query is a subsequence of a long enough
// paragraph), so plain substring matching is what users actually expect here.
export function matchesQuery(query, text) {
  if (!query) return true;
  return (text || "").toLowerCase().includes(query.toLowerCase());
}

// Case-insensitive substring match positions within a single string, in
// order: [{start, end}, ...]. Used for "find in raw text" (Reveal Codes
// mode), where the whole document is one string rather than a tree of
// nodes with their own title/body to search separately.
export function findAllOccurrences(text, query) {
  if (!text || !query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out = [];
  let i = 0;
  while (true) {
    const idx = hay.indexOf(needle, i);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + needle.length });
    i = idx + needle.length;
  }
  return out;
}

// Builds HTML for the Reveal Codes find-highlight overlay: `text`,
// HTML-escaped, with each match position wrapped in <mark> (the match at
// currentIdx gets an extra class so it can be styled distinctly). Pure —
// the overlay element just needs its innerHTML set to this. Relies on
// matches being in ascending, non-overlapping order, which
// findAllOccurrences already guarantees.
export function highlightMatchesHtml(text, matches, currentIdx) {
  if (!text) return "";
  if (!matches || matches.length === 0) return escapeHtml(text);
  let out = "";
  let last = 0;
  matches.forEach((m, i) => {
    out += escapeHtml(text.slice(last, m.start));
    const cls = "raw-find-match" + (i === currentIdx ? " raw-find-match-current" : "");
    out += `<mark class="${cls}">${escapeHtml(text.slice(m.start, m.end))}</mark>`;
    last = m.end;
  });
  out += escapeHtml(text.slice(last));
  return out;
}

// --- Search query parser ---

// Parse a search query into structured form so callers can apply
// tag:, status:, and -exclusion operators in addition to plain text terms.
export function parseSearchQuery(q) {
  const result = { terms: [], tags: [], statuses: [] };
  if (!q || !q.trim()) return result;
  for (const w of q.trim().split(/\s+/)) {
    if (!w) continue;
    if (w.startsWith("tag:") && w.length > 4) {
      result.tags.push(w.slice(4).toLowerCase());
    } else if (w.startsWith("status:") && w.length > 7) {
      result.statuses.push(w.slice(7).toLowerCase());
    } else if (w.startsWith("-") && w.length > 1) {
      result.terms.push({ include: false, text: w.slice(1) });
    } else {
      result.terms.push({ include: true, text: w });
    }
  }
  return result;
}

// Check if a node (or agenda/todo item) matches a parsed search query.
// node should have: title, body (optional), tags (optional), status (optional).
export function nodeMatchesQuery(pq, node) {
  const haystack = ((node.title || "") + "\n" + (node.body || "")).toLowerCase();
  for (const t of pq.terms) {
    const found = haystack.includes(t.text.toLowerCase());
    if (t.include && !found) return false;
    if (!t.include && found) return false;
  }
  const nodeTags = (node.tags || []).map((t) => t.toLowerCase());
  for (const tag of pq.tags) {
    if (!nodeTags.includes(tag)) return false;
  }
  if (pq.statuses.length > 0) {
    const st = (node.status || "").toLowerCase();
    if (!pq.statuses.includes(st)) return false;
  }
  return true;
}

// --- Org inline markup rendering ---
// Renders a small subset of org-mode inline markup to safe HTML:
// *bold*, /italic/, _underline_, =code= and [[url][label]] links.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url) {
  return /^(https?:|mailto:)/i.test(url);
}

function isFileUrl(url) {
  return /^file:/i.test(url);
}

function fileUrlToPath(url) {
  // Strip file:// or file: prefix, leaving the bare path.
  // file:///home/x → /home/x  |  file:/home/x → /home/x  |  file:relative → relative
  return url.replace(/^file:\/\//i, "").replace(/^file:/i, "");
}

const LINK_RE = /\[\[([^\]]+)\]\[([^\]]*)\]\]|\[\[([^\]]+)\]\]/g;

// Bare absolute file paths: /dir/subdir/file.ext — must have at least one
// slash-terminated segment and end with a file extension.  Captured before
// MARKUP_RE so italic's "/" doesn't chop the path into pieces.
const BARE_PATH_RE = /(?<![a-zA-Z0-9])(\/(?:[^\s/\n]+\/)+[^\n/]*\.[a-zA-Z0-9]{1,10})(?=\s|$|[,;!?"])/g;

// Same pattern but for raw (unescaped) text, used when auto-converting bare
// paths to org [[file:...][label]] format in the editor.  The extra ":"
// in the lookbehind prevents re-converting paths already inside org links
// (e.g. [[file:/path...]] where "/" is preceded by ":").
const BARE_PATH_ORG_RE = /(?<![a-zA-Z0-9:])(\/(?:[^\s/\n]+\/)+[^\n/]*\.[a-zA-Z0-9]{1,10})(?=[\s,;!?"]|$)/g;

// Bare domain-looking text ending in .com/.net/.org (e.g. "EpicurusToday.com")
// → clickable link, DISPLAY-TIME ONLY — deliberately not mirrored by an
// orgifyPaths-style rewrite of the stored text the way bare file paths are.
// This outline is full of citations and Latin abbreviations dense with
// periods; a wrong guess by a domain-detecting regex baked permanently into
// the file would be far costlier than one here that's just a rendering
// choice, reversible by definition. The lookbehind excludes "/", ":", "@"
// so this doesn't reprocess a domain that's already part of a URL, file
// path, or email address handled elsewhere.
const BARE_DOMAIN_RE = /(?<![a-zA-Z0-9/:@.-])((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com|net|org))(?=[\s.,;!?"')\]]|$)/g;

function barePathToLink(_, path) {
  const filename = path.split("/").pop();
  return `[[file:${path}][${filename}]]`;
}

// Runs on every keystroke in a title/body field (see onChange in app.js),
// re-scanning the whole field each time — so it must never touch text
// already inside an existing [[...]] link. BARE_PATH_ORG_RE's lookbehind
// only blocks re-wrapping a literal "file:/path" URL; it has no idea where
// a [[...]] span starts or ends, so a path-shaped segment of an https://
// URL (e.g. a domain ending in ".org"/".com") could match straight through
// the link's own "][" delimiter and into its label, nesting a bogus
// [[file:...]] link inside the real one and corrupting it on every edit.
export function orgifyPaths(text) {
  if (!text) return text;
  let result = "";
  let lastIndex = 0;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(text))) {
    result += text.slice(lastIndex, m.index).replace(BARE_PATH_ORG_RE, barePathToLink);
    result += m[0];
    lastIndex = LINK_RE.lastIndex;
  }
  result += text.slice(lastIndex).replace(BARE_PATH_ORG_RE, barePathToLink);
  return result;
}

// Whether clipboard text pasted over a selection should be treated as a
// single URL for the paste-creates-a-hyperlink feature: the whole trimmed
// string, with no internal whitespace/newlines (a URL never contains
// spaces), starting with a recognized scheme. Deliberately strict — a URL
// embedded in a longer pasted sentence should still paste as plain text,
// not silently eat the sentence around it.
export function isPastedUrl(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  return /^(https?:\/\/|mailto:|file:)/i.test(t);
}

// Replaces the selected range [start, end) of `value` with an org-mode
// link wrapping the previously-selected text as the link's label —
// [[url][label]] — displaying what was selected but now pointing at url.
// Returns the new field value and the cursor position (end of the link),
// for the paste-creates-a-hyperlink feature.
export function wrapSelectionAsLink(value, start, end, url) {
  const label = value.slice(start, end);
  const link = `[[${url}][${label}]]`;
  return { value: value.slice(0, start) + link + value.slice(end), cursor: start + link.length };
}

// Emphasis boundary rules, taken directly from real org-mode's own
// org-emphasis-regexp-components / org-emph-re (queried via
// `emacs --batch --eval "(require 'org)" --eval "(princ org-emph-re)"`):
// a marker only opens at the very start of a line or right after one of
// PRE_CHARS, and only closes right before one of POST_CHARS or end of line.
// Without this, "foo/bar/baz" was wrongly italicizing "bar" — org-mode
// requires that boundary and leaves it as plain text.
//
// This text has already been through escapeHtml() by the time this regex
// runs, so a literal `"` or `'` sitting at a boundary has become the
// multi-character entity `&quot;`/`&#39;` — those are matched as
// alternatives alongside the single-character classes so quoted emphasis
// like `"*bold*"` keeps working post-escaping.
const EMPH_PRE = "-\\s('{";
const EMPH_POST = "-\\s.,:!?;)}\\[";
const MARKUP_RE = new RegExp(
  "(^|&quot;|&#39;|[" + EMPH_PRE + "])" +
  "([*/_=+])" +
  "(\\S(?:[\\s\\S]*?\\S)?)" +
  "\\2" +
  "(?=&quot;|&#39;|[" + EMPH_POST + "]|$)",
  "gm"
);

// Sentinel char (not producible by escapeHtml or normal text) used to mark
// link placeholders so the markup regex above doesn't reprocess link content.
const LINK_PLACEHOLDER = String.fromCharCode(1);

const IMAGE_EXTS_RE = /\.(?:png|gif|jpe?g|svg|tiff?|webp|bmp)$/i;

const ORG_TABLE_SEP_RE = /^\|[\s\-\+:|]+\|/;
const isSep = (line) => ORG_TABLE_SEP_RE.test(line.trim()) && !/[a-zA-Z0-9]/.test(line);
const parseOrgRow = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

// Render a sequence of org-mode table lines (all starting with "|") as an HTML table.
// The first group of data rows before any |---+---| separator row becomes <thead>.
function renderOrgTable(tableLines, index) {
  let headerRows = [], bodyRows = [];
  let sepSeen = false;
  for (const line of tableLines) {
    if (isSep(line)) { sepSeen = true; continue; }
    (sepSeen ? bodyRows : headerRows).push(parseOrgRow(line));
  }
  if (!sepSeen) { bodyRows = headerRows; headerRows = []; }

  let out = `<table class="org-table" data-table-index="${index}" title="Click to edit table">`;
  if (headerRows.length) {
    out += "<thead>" + headerRows.map((r) =>
      "<tr>" + r.map((c) => `<th>${renderOrgInline(c)}</th>`).join("") + "</tr>"
    ).join("") + "</thead>";
  }
  out += "<tbody>" + bodyRows.map((r) =>
    "<tr>" + r.map((c) => `<td>${renderOrgInline(c)}</td>`).join("") + "</tr>"
  ).join("") + "</tbody></table>";
  return out;
}

// Parse org table lines into { rows: string[][], headerCount: number }.
export function parseOrgTableData(tableLines) {
  const rows = [];
  let headerCount = 0;
  let sepSeen = false;
  for (const line of tableLines) {
    if (isSep(line)) { if (!sepSeen) headerCount = rows.length; sepSeen = true; continue; }
    rows.push(parseOrgRow(line));
  }
  return { rows, headerCount };
}

// Serialize { rows, headerCount } back to org table lines with aligned columns.
export function serializeOrgTable({ rows, headerCount }) {
  if (!rows.length) return [];
  const numCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
  const widths = Array(numCols).fill(3);
  for (const row of rows) {
    for (let c = 0; c < numCols; c++) widths[c] = Math.max(widths[c], (row[c] || "").length);
  }
  const fmtRow = (row) => "| " + widths.map((w, i) => (row[i] || "").padEnd(w)).join(" | ") + " |";
  const fmtSep = () => "|" + widths.map((w) => "-".repeat(w + 2)).join("+") + "|";
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === headerCount && headerCount > 0) lines.push(fmtSep());
    lines.push(fmtRow(rows[i]));
  }
  return lines;
}

// Find all table blocks (consecutive |-prefixed lines) in a body string.
// Returns [{start, end, lines}] where start/end are line indices (end is exclusive).
export function findTableBlocksInBody(body) {
  const lines = body.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("|")) {
      const start = i;
      while (i < lines.length && lines[i].startsWith("|")) i++;
      blocks.push({ start, end: i, lines: lines.slice(start, i) });
    } else { i++; }
  }
  return blocks;
}

// Replace a table block in body text, returning the updated body string.
export function replaceTableBlockInBody(body, blockIndex, newOrgLines) {
  const lines = body.split("\n");
  const blocks = findTableBlocksInBody(body);
  if (blockIndex >= blocks.length) return body;
  const { start, end } = blocks[blockIndex];
  lines.splice(start, end - start, ...newOrgLines);
  return lines.join("\n");
}
const ATTR_ORG_LINE_RE = /^#\+ATTR_ORG:\s*(.+)$/i;
const ATTR_HTML_LINE_RE = /^#\+ATTR_HTML:\s*(.+)$/i;
const IMAGE_LINK_LINE_RE = /^\[\[file:([^\]]+)\]\]$/i;
const QUOTE_BEGIN_RE = /^\s*#\+begin_quote\s*$/i;
const QUOTE_END_RE = /^\s*#\+end_quote\s*$/i;
const VERSE_BEGIN_RE = /^\s*#\+begin_verse\s*$/i;
const VERSE_END_RE = /^\s*#\+end_verse\s*$/i;
const SRC_BEGIN_RE = /^\s*#\+begin_src(?:\s+(\S+))?\s*$/i;
const SRC_END_RE = /^\s*#\+end_src\s*$/i;
const EXAMPLE_BEGIN_RE = /^\s*#\+begin_example\s*$/i;
const EXAMPLE_END_RE = /^\s*#\+end_example\s*$/i;
const CENTER_BEGIN_RE = /^\s*#\+begin_center\s*$/i;
const CENTER_END_RE = /^\s*#\+end_center\s*$/i;

// Generic greater-block scanner shared by quote/verse/src handling below.
// If lines[i] opens a block matching beginRe, collects lines until endRe (or
// end of body, for an unterminated block) and returns { lang, contentLines,
// nextIndex }; otherwise returns null. lang is beginRe's capture group 1
// (used for #+begin_src's language tag), empty string if the block has none.
function scanBlock(lines, i, beginRe, endRe) {
  const m = beginRe.exec(lines[i]);
  if (!m) return null;
  const contentLines = [];
  let k = i + 1;
  while (k < lines.length && !endRe.test(lines[k])) contentLines.push(lines[k++]);
  return { lang: m[1] || "", contentLines, nextIndex: k < lines.length ? k + 1 : k };
}

// Render body text that may contain inline images (#+ATTR_* + [[file:...]] blocks).
// Image blocks are extracted as <div> elements; everything else goes through
// renderOrgInline so org markup is still processed.
export function renderOrgBody(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const outputParts = [];
  const pendingLines = [];
  let imgIndex = 0;
  let tableIndex = 0;

  const flushPending = () => {
    if (pendingLines.length === 0) return;
    outputParts.push(renderOrgInline(pendingLines.join("\n")));
    pendingLines.length = 0;
  };

  let i = 0;
  while (i < lines.length) {
    let j = i;
    let attrOrg = null, attrHtml = null;

    const orgM = ATTR_ORG_LINE_RE.exec(lines[j]);
    if (orgM) { attrOrg = orgM[1]; j++; }

    if (j < lines.length) {
      const htmlM = ATTR_HTML_LINE_RE.exec(lines[j]);
      if (htmlM) { attrHtml = htmlM[1]; j++; }
    }

    const imgLine = j < lines.length ? lines[j] : null;
    const imgM = imgLine ? IMAGE_LINK_LINE_RE.exec(imgLine) : null;
    if (imgM && IMAGE_EXTS_RE.test(imgM[1])) {
      const filePath = imgM[1];
      const widthM = attrOrg && attrOrg.match(/:width\s+(\d+)/i);
      const width = widthM ? parseInt(widthM[1]) : null;
      const isCenter = !!(attrHtml && /margin\s*:\s*(?:0\s+)?auto/i.test(attrHtml));
      const isRight = !isCenter && !!(attrHtml && /margin-left\s*:\s*auto/i.test(attrHtml));
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      let style = "";
      if (width) style += `max-width:${width}px;width:100%;`;
      if (isCenter) style += "display:block;margin:0 auto;";
      else if (isRight) style += "display:block;margin-left:auto;";
      const imgTag = `<img src="/api/media/${encodedPath}" alt="${escapeHtml(filePath)}"${style ? ` style="${style}"` : ""} class="org-inline-img" />`;
      const cls = `org-img-block${isCenter ? " org-img-center" : isRight ? " org-img-right" : ""}`;

      flushPending();
      outputParts.push(`<div class="${cls}" data-img-index="${imgIndex++}">${imgTag}</div>`);
      i = j + 1;
      continue;
    }

    // Table block: one or more consecutive lines starting with "|"
    if (lines[i].startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i++]);
      }
      flushPending();
      outputParts.push(renderOrgTable(tableLines, tableIndex++));
      continue;
    }

    // Quote block: #+begin_quote ... #+end_quote. The marker lines are
    // hidden; the content in between is rendered like a normal paragraph
    // inside a <blockquote>. An unterminated block runs to the end of body.
    const quoteBlock = scanBlock(lines, i, QUOTE_BEGIN_RE, QUOTE_END_RE);
    if (quoteBlock) {
      flushPending();
      outputParts.push(`<blockquote class="org-quote">${renderOrgInline(quoteBlock.contentLines.join("\n"))}</blockquote>`);
      i = quoteBlock.nextIndex;
      continue;
    }

    // Verse block: #+begin_verse ... #+end_verse. Like quote, but for poetry
    // — line breaks are always significant, no italics/border styling.
    const verseBlock = scanBlock(lines, i, VERSE_BEGIN_RE, VERSE_END_RE);
    if (verseBlock) {
      flushPending();
      outputParts.push(`<p class="org-verse">${renderOrgInline(verseBlock.contentLines.join("\n"))}</p>`);
      i = verseBlock.nextIndex;
      continue;
    }

    // Src block: #+begin_src [lang] ... #+end_src. Content is literal code:
    // escaped but never run through renderOrgInline, so markup characters
    // (*, /, =, etc.) show up as-is instead of being interpreted as emphasis.
    const srcBlock = scanBlock(lines, i, SRC_BEGIN_RE, SRC_END_RE);
    if (srcBlock) {
      flushPending();
      const langAttr = srcBlock.lang ? ` data-lang="${escapeHtml(srcBlock.lang)}"` : "";
      outputParts.push(`<pre class="org-src"${langAttr}><code>${escapeHtml(srcBlock.contentLines.join("\n"))}</code></pre>`);
      i = srcBlock.nextIndex;
      continue;
    }

    // Example block: #+begin_example ... #+end_example. Same literal,
    // unprocessed-markup treatment as src, but with no language tag.
    const exampleBlock = scanBlock(lines, i, EXAMPLE_BEGIN_RE, EXAMPLE_END_RE);
    if (exampleBlock) {
      flushPending();
      outputParts.push(`<pre class="org-example"><code>${escapeHtml(exampleBlock.contentLines.join("\n"))}</code></pre>`);
      i = exampleBlock.nextIndex;
      continue;
    }

    // Center block: #+begin_center ... #+end_center. Inline markup still
    // applies; only the text alignment changes.
    const centerBlock = scanBlock(lines, i, CENTER_BEGIN_RE, CENTER_END_RE);
    if (centerBlock) {
      flushPending();
      outputParts.push(`<div class="org-center">${renderOrgInline(centerBlock.contentLines.join("\n"))}</div>`);
      i = centerBlock.nextIndex;
      continue;
    }

    pendingLines.push(lines[i]);
    i++;
  }

  flushPending();
  return outputParts.join("\n");
}

// Parse image blocks from org body text. Returns array of { startLine, endLine, filePath, width, align }.
export function parseImageBlocks(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    let attrOrg = null, attrHtml = null;
    const orgM = ATTR_ORG_LINE_RE.exec(lines[j]);
    if (orgM) { attrOrg = orgM[1]; j++; }
    if (j < lines.length) {
      const htmlM = ATTR_HTML_LINE_RE.exec(lines[j]);
      if (htmlM) { attrHtml = htmlM[1]; j++; }
    }
    const imgLine = j < lines.length ? lines[j] : null;
    const imgM = imgLine ? IMAGE_LINK_LINE_RE.exec(imgLine) : null;
    if (imgM && IMAGE_EXTS_RE.test(imgM[1])) {
      const widthM = attrOrg && attrOrg.match(/:width\s+(\d+)/i);
      const isCenter = !!(attrHtml && /margin\s*:\s*(?:0\s+)?auto/i.test(attrHtml));
      const isRight = !isCenter && !!(attrHtml && /margin-left\s*:\s*auto/i.test(attrHtml));
      blocks.push({
        startLine: i, endLine: j,
        filePath: imgM[1],
        width: widthM ? parseInt(widthM[1]) : null,
        align: isCenter ? "center" : isRight ? "right" : "left",
      });
      i = j + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

// Replace image block at blockIndex with new width/align, preserving file path and surrounding text.
export function updateImageBlock(text, blockIndex, { width, align }) {
  const blocks = parseImageBlocks(text);
  if (blockIndex < 0 || blockIndex >= blocks.length) return text;
  const block = blocks[blockIndex];
  const lines = text.split("\n");
  const newLines = [];
  if (width) newLines.push(`#+ATTR_ORG: :width ${width}`);
  if (align === "center") newLines.push(`#+ATTR_HTML: :style "display:block;margin:0 auto;"`);
  else if (align === "right") newLines.push(`#+ATTR_HTML: :style "display:block;margin-left:auto;"`);
  newLines.push(`[[file:${block.filePath}]]`);
  return [...lines.slice(0, block.startLine), ...newLines, ...lines.slice(block.endLine + 1)].join("\n");
}

// Real org-mode combines emphasis when markers sit directly adjacent with no
// space, e.g. "*/text/*" -> bold+italic (verified against Emacs' own HTML
// exporter). Applying MARKUP_RE recursively to each captured span's content
// reproduces that: "*/text/*" captures "/text/" as bold's content, which
// itself matches the italic pattern, and so on for triple combinations like
// "*/_text_/*". Verbatim/code (=...=/~...~) are deliberately left alone —
// org keeps their content fully literal, never re-parsing markup inside.
const EMPHASIS_TAGS = { "*": "strong", "/": "em", "_": "u", "+": "del" };

function applyEmphasisMatch(match, pre, marker, body) {
  // Verbatim (=...=) is the one marker org-mode never re-parses for nested
  // emphasis — its content is meant to display exactly as written.
  if (marker === "=") return `${pre}<code>${body}</code>`;
  const tag = EMPHASIS_TAGS[marker];
  return `${pre}<${tag}>${body.replace(MARKUP_RE, applyEmphasisMatch)}</${tag}>`;
}

export function renderOrgInline(text) {
  if (!text) return "";

  // Escape first so all later substitutions only ever insert trusted markup.
  const escaped = escapeHtml(text);

  // Pull links out into placeholders before applying emphasis markup, so
  // markers inside labels/URLs aren't reprocessed.
  const links = [];
  let result = escaped.replace(LINK_RE, (match, url1, label1, url2) => {
    const url = url1 !== undefined ? url1 : url2;
    const label = label1 || url;
    let html;
    if (isSafeUrl(url)) {
      html = `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } else if (isFileUrl(url)) {
      const path = fileUrlToPath(url);
      if (path.endsWith(".org") && !path.includes("/") && !path.includes("\\")) {
        // Bare .org filename → load in-app
        html = `<a href="#" class="org-file-link" data-file-path="${escapeHtml(path)}">${label}</a>`;
      } else {
        // All other file:// links → real href, browser opens on client machine
        html = `<a href="${url}" class="org-file-link" title="${escapeHtml(path)}" target="_blank" rel="noopener">${label}</a>`;
      }
    } else {
      // Wiki-link: [[Note Name]] — internal link to another note by title
      html = `<a href="#" class="wiki-link" data-wiki="${url}">${label}</a>`;
    }
    links.push(html);
    return LINK_PLACEHOLDER + links.length + LINK_PLACEHOLDER;
  });

  // Footnote references: [fn:label] → clickable superscript
  result = result.replace(/\[fn:([^\]]+)\]/g, (match, label) => {
    const safe = label.replace(/"/g, "&quot;");
    const html = `<sup class="org-fn-ref" data-fn="${safe}">[${safe}]</sup>`;
    links.push(html);
    return LINK_PLACEHOLDER + links.length + LINK_PLACEHOLDER;
  });

  // Bare absolute paths: /dir/.../file.ext → file link (also prevents italic
  // markup from splitting the path at its "/" separators).
  // Use a real file:// href so the browser opens the file on the client machine,
  // matching the behavior of http:// links.
  result = result.replace(BARE_PATH_RE, (match, path) => {
    const safe = path.replace(/"/g, "&quot;");
    const label = path.split("/").pop();
    const html = `<a href="file://${safe}" class="org-file-link" title="${safe}" target="_blank" rel="noopener">${label}</a>`;
    links.push(html);
    return LINK_PLACEHOLDER + links.length + LINK_PLACEHOLDER;
  });

  // Bare domain-looking text (EpicurusToday.com) → clickable link. See
  // BARE_DOMAIN_RE above for why this is display-time only.
  result = result.replace(BARE_DOMAIN_RE, (match) => {
    const html = `<a href="https://${match}" target="_blank" rel="noopener noreferrer">${match}</a>`;
    links.push(html);
    return LINK_PLACEHOLDER + links.length + LINK_PLACEHOLDER;
  });

  result = result.replace(MARKUP_RE, applyEmphasisMatch);

  const placeholderRe = new RegExp(LINK_PLACEHOLDER + "(\\d+)" + LINK_PLACEHOLDER, "g");
  result = result.replace(placeholderRe, (_, i) => links[Number(i) - 1]);

  return result;
}

// Build footnote navigation index. Returns:
//   defs: { label → { text, nodeId } } — which node's body defines this label
//   refs: { label → [nodeId, ...] }    — which nodes reference this label
export function buildFootnoteIndex(nodes) {
  const defs = {};
  const refs = {};

  function addRef(label, nodeId) {
    if (!refs[label]) refs[label] = [];
    if (!refs[label].includes(nodeId)) refs[label].push(nodeId);
  }

  function scanBody(body, nodeId) {
    // Definitions start a line: "[fn:label] definition text"
    // Inline references are mid-line: "...text [fn:label] more text..."
    for (const line of body.split("\n")) {
      const m = /^\[fn:([^\]]+)\]\s+(.+)/.exec(line.trim());
      if (m) {
        const label = m[1].trim();
        const text = m[2].trim().replace(/\s+/g, " ");
        if (label && text && !defs[label]) defs[label] = { text, nodeId };
      }
    }
    const re = /\[fn:([^\]]+)\]/g;
    let m;
    while ((m = re.exec(body)) !== null) addRef(m[1].trim(), nodeId);
  }

  function scan(list) {
    for (const n of list) {
      if (n.body) scanBody(n.body, n.id);
      if (n.children?.length > 0) scan(n.children);
    }
  }
  scan(nodes || []);
  return { defs, refs };
}

// Filter the tree into a sparse view: a node is kept only if its own title
// matches, or one of its descendants does (kept as a breadcrumb). Returns
// the original list when both filters are empty. `selectedTags` matches
// with OR semantics (any one tag present on the node is enough); it
// combines with the text query using AND.
//
// showFullSubtree controls what happens once a node itself matches:
// - true (default): show everything beneath it untouched, unfiltered —
//   finding a heading always reveals its full context, so a sub-item that
//   doesn't itself repeat the search text is never mistaken for missing.
// - false: keep filtering children too, so non-matching descendants are
//   pruned even under a matching node (a more compact, narrower result set,
//   at the cost of that exact confusion).
export function filterTree(nodes, query, selectedTags, showFullSubtree = true) {
  const hasTagFilter = selectedTags && selectedTags.length > 0;
  if (!query && !hasTagFilter) return nodes;
  const result = [];
  for (const n of nodes) {
    const textMatch = matchesQuery(query, n.title);
    const tagMatch = !hasTagFilter || (n.tags || []).some((t) => selectedTags.includes(t));
    const selfMatch = textMatch && tagMatch;
    if (selfMatch && showFullSubtree) {
      result.push({ ...n, collapsed: false });
      continue;
    }
    const children = n.children?.length > 0 ? filterTree(n.children, query, selectedTags, showFullSubtree) : [];
    if (selfMatch || children.length > 0) {
      result.push({ ...n, collapsed: false, children });
    }
  }
  return result;
}

// --- Transclusion ---
//
// A node becomes a "source" by carrying a :TRANSCLUDE_ID: property (a
// permanent, randomly-generated id — unlike newId()'s n1/n2 counters, this
// has to survive across sessions since it's written into the org file).
// A node becomes a "copy" by carrying a :TRANSCLUDE: property whose value is
// that id (same-file) or "path/to/file.org::id" (cross-file), mirroring
// org's own file:...::#id link syntax. See applyTransclusions below for how
// a copy's displayed content is resolved from its source.

const TRANSCLUDE_ID_PROP = "TRANSCLUDE_ID";
const TRANSCLUDE_PROP = "TRANSCLUDE";

export function newTransclusionId() {
  return "tc-" + Math.random().toString(36).slice(2, 10);
}

// Splits a :TRANSCLUDE: property value into { file, id }. file is null for
// a same-file reference (bare id).
export function parseTranscludeRef(ref) {
  if (!ref) return null;
  const idx = ref.lastIndexOf("::");
  if (idx < 0) return { file: null, id: ref.trim() };
  return { file: ref.slice(0, idx).trim(), id: ref.slice(idx + 2).trim() };
}

export function formatTranscludeRef(file, id) {
  return file ? `${file}::${id}` : id;
}

export function setNodeProperty(nodes, nodeId, propName, propValue) {
  return mapNode(nodes, nodeId, (n) => ({ ...n, properties: { ...(n.properties || {}), [propName]: propValue } }));
}

export function removeNodeProperty(nodes, nodeId, propName) {
  return mapNode(nodes, nodeId, (n) => {
    if (!n.properties || !(propName in n.properties)) return n;
    const rest = { ...n.properties };
    delete rest[propName];
    return { ...n, properties: rest };
  });
}

// Ensures node `nodeId` has a TRANSCLUDE_ID property, assigning a fresh one
// if it doesn't already have one. Returns { nodes, id }.
export function ensureTranscludeId(nodes, nodeId) {
  const existing = findNode(nodes, nodeId);
  const current = existing?.properties?.[TRANSCLUDE_ID_PROP];
  if (current) return { nodes, id: current };
  const id = newTransclusionId();
  return { nodes: setNodeProperty(nodes, nodeId, TRANSCLUDE_ID_PROP, id), id };
}

// Marks node `nodeId` as transcluding `ref`, clearing its own title/body/
// children — they're replaced at render/export time by the resolved
// source's content (see applyTransclusions) and are never themselves
// written to disk for this node, so the two copies can never drift apart.
export function makeTransclusion(nodes, nodeId, ref) {
  return mapNode(nodes, nodeId, (n) => ({
    ...n,
    title: "",
    body: "",
    children: [],
    properties: { ...(n.properties || {}), [TRANSCLUDE_PROP]: ref },
  }));
}

// Removes the TRANSCLUDE property from node `nodeId`, turning it back into a
// normal, independently-editable node. If `content` (typically the node's
// last-resolved display content) is given, it's baked in as the node's own
// title/body/children so nothing visually changes at the moment of
// detaching — otherwise the node reverts to its stored (empty) content.
export function detachTransclusion(nodes, nodeId, content = null) {
  return mapNode(nodes, nodeId, (n) => {
    const rest = { ...(n.properties || {}) };
    delete rest[TRANSCLUDE_PROP];
    const base = { ...n, properties: rest };
    if (!content) return base;
    return { ...base, title: content.title || "", body: content.body || "", children: content.children || [] };
  });
}

function indexByTranscludeId(nodes, out = {}) {
  for (const n of nodes) {
    const id = n.properties?.[TRANSCLUDE_ID_PROP];
    if (id) out[id] = n;
    if (n.children?.length > 0) indexByTranscludeId(n.children, out);
  }
  return out;
}

// Gives a resolved transclusion's nested children fresh, namespaced ids
// (real node ids never contain "::") so they can't collide with the ids of
// the very same nodes rendered at their actual source location elsewhere in
// the tree. These are read-only display clones — id collisions would
// otherwise confuse findNode/dispatch, which search by id globally.
function cloneReadOnly(n, idPrefix) {
  const id = idPrefix + "::" + n.id;
  return {
    ...n,
    id,
    _transclusion: { status: "resolved", editable: false, readOnly: true },
    children: (n.children || []).map((c) => cloneReadOnly(c, id)),
  };
}

// Resolves every :TRANSCLUDE: reference in `nodes` against same-file
// siblings (via TRANSCLUDE_ID) and, for cross-file references, against
// `cache` — a map of "file::id" -> resolved node (the shape returned by
// GET /api/transclude's "node" field), "missing" (fetched, source
// unavailable), or absent entirely (not yet fetched — caller should fetch
// it). Populate and refresh `cache` in app.js; this function is pure.
//
// Returns a NEW tree for DISPLAY/EXPORT ONLY: a transcluding node keeps its
// own id (so dispatch/save still target the right underlying node) but its
// title/body/tags/children are swapped for the resolved source's, and it
// picks up `_transclusion` metadata: { status, editable, sourceFile,
// sourceId, ref }. `editable` is true only for same-file references — see
// app.js's live-sync dispatch redirect, which routes edits made through the
// copy to `sourceId` instead of the copy's own id. Nested descendants of a
// resolved subtree are always read-only, never live-editable (see
// cloneReadOnly above) — only the transcluding node's own title/body get
// live-sync.
//
// A resolved same-file source that is itself a transclusion is treated as
// unresolvable ("chained") rather than followed further, since chained
// transclusion isn't supported (matches the server's rejection for
// cross-file lookups in internal/api's transclude handler).
export function applyTransclusions(nodes, currentFile, cache) {
  if (!nodes) return nodes;
  const sameFileIndex = indexByTranscludeId(nodes);

  function resolve(ref) {
    const parsed = parseTranscludeRef(ref);
    if (!parsed) return { status: "missing" };
    if (!parsed.file || parsed.file === currentFile) {
      const source = sameFileIndex[parsed.id];
      if (!source) return { status: "missing" };
      if (source.properties?.[TRANSCLUDE_PROP]) return { status: "chained" };
      return { status: "resolved", editable: true, sourceFile: null, sourceId: source.id, node: source };
    }
    const key = `${parsed.file}::${parsed.id}`;
    const cached = cache ? cache[key] : undefined;
    if (cached === undefined) return { status: "loading" };
    if (cached === "missing") return { status: "missing" };
    return { status: "resolved", editable: false, sourceFile: parsed.file, sourceId: parsed.id, node: cached };
  }

  function walk(list) {
    return list.map((n) => {
      const ref = n.properties?.[TRANSCLUDE_PROP];
      if (!ref) {
        return n.children?.length > 0 ? { ...n, children: walk(n.children) } : n;
      }
      const r = resolve(ref);
      if (r.status !== "resolved") {
        return { ...n, title: "", body: "", children: [], _transclusion: { status: r.status, ref } };
      }
      return {
        ...n,
        title: r.node.title,
        body: r.node.body,
        tags: r.node.tags,
        children: (r.node.children || []).map((c) => cloneReadOnly(c, n.id)),
        _transclusion: { status: "resolved", editable: r.editable, sourceFile: r.sourceFile, sourceId: r.sourceId, ref },
      };
    });
  }

  return walk(nodes);
}

// All bookmarked nodes in document order — returns [{id, title, bookmark}]
// for every node that has a BOOKMARK property set.
export function collectBookmarks(nodes) {
  const result = [];
  function walk(list) {
    for (const n of list) {
      if (n.properties?.BOOKMARK) {
        result.push({ id: n.id, title: n.title, bookmark: n.properties.BOOKMARK });
      }
      if (n.children?.length > 0) walk(n.children);
    }
  }
  walk(nodes || []);
  return result;
}

// All distinct tags present anywhere in the tree, sorted alphabetically —
// the full set offered by the tag-filter popup, independent of any filter
// currently applied.
export function collectAllTags(nodes) {
  const seen = new Set();
  const walk = (list) => {
    for (const n of list) {
      for (const t of n.tags || []) seen.add(t);
      if (n.children?.length > 0) walk(n.children);
    }
  };
  walk(nodes || []);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// Collapsed-by-id map, mirroring the backend's model.CollapsedFromTree —
// sent along when exiting text mode so fold state survives a reparse when
// the edit didn't reorder/insert/delete headings above a given node.
export function collapsedMap(nodes) {
  const m = {};
  const walk = (list) => {
    for (const n of list) {
      if (n.collapsed) m[n.id] = true;
      if (n.children?.length > 0) walk(n.children);
    }
  };
  walk(nodes || []);
  return m;
}

// Remove org inline markup characters, leaving readable plain text.
// *bold* → bold, /italic/ → italic, _underline_ → underline, =code= → code.
// [[url][label]] → label, [[url]] → url.  Footnote refs are dropped.
export function stripOrgMarkup(text) {
  if (!text) return "";
  // [[url][label]] → label, [[url]] → url
  let s = text.replace(/\[\[([^\]]+)\]\[([^\]]*)\]\]/g, (_, _url, label) => label || _url);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, url) => url);
  // Footnote refs [fn:label]
  s = s.replace(/\[fn:[^\]]+\]/g, "");
  // Inline markup *b* /i/ _u_ =c= +s+
  s = s.replace(/\*([^\s*][^*]*?)\*/g, "$1");
  s = s.replace(/\/([^\s/][^/]*?)\//g, "$1");
  s = s.replace(/_([^\s_][^_]*?)_/g, "$1");
  s = s.replace(/=([^\s=][^=]*?)=/g, "$1");
  s = s.replace(/\+([^\s+][^+]*?)\+/g, "$1");
  return s;
}

// Convert a node tree to an HTML string suitable for rich-text clipboard.
// Depth 0 → <h1>, depth 1 → <h2>, … capped at <h6>.
export function treeToHtml(nodes, depth = 0) {
  let html = "";
  for (const node of (nodes || [])) {
    if (!node.title && !node.body && !(node.children?.length)) continue;
    const tag = "h" + Math.min(depth + 1, 6);
    html += `<${tag}>${renderOrgInline(node.title || "")}</${tag}>\n`;
    if (node.body) {
      for (const line of node.body.split("\n")) {
        if (line.trim()) html += `<p>${renderOrgInline(line)}</p>\n`;
      }
    }
    if (node.children?.length) html += treeToHtml(node.children, depth + 1);
  }
  return html;
}

// Convert a node tree to readable plain text (no org markup characters).
export function treeToPlainText(nodes, depth = 0) {
  let text = "";
  const pad = "  ".repeat(depth);
  for (const node of (nodes || [])) {
    if (!node.title && !node.body && !(node.children?.length)) continue;
    text += pad + stripOrgMarkup(node.title || "") + "\n";
    if (node.body) {
      for (const line of node.body.split("\n")) {
        text += line.trim() ? pad + "  " + stripOrgMarkup(line) + "\n" : "\n";
      }
    }
    if (node.children?.length) text += treeToPlainText(node.children, depth + 1);
  }
  return text;
}

// Convert a flat list of {node, depth} pairs (from a drag/text selection) to HTML.
// Does NOT recurse into children — only the explicitly selected rows are rendered.
export function selectionToHtml(items) {
  let html = "";
  for (const { node, depth } of (items || [])) {
    if (!node.title && !node.body) continue;
    const tag = "h" + Math.min(depth + 1, 6);
    html += `<${tag}>${renderOrgInline(node.title || "")}</${tag}>\n`;
    if (node.body) {
      for (const line of node.body.split("\n")) {
        if (line.trim()) html += `<p>${renderOrgInline(line)}</p>\n`;
      }
    }
  }
  return html;
}

// Convert a flat list of {node, depth} pairs (from a drag/text selection) to plain text.
export function selectionToPlainText(items) {
  let text = "";
  for (const { node, depth } of (items || [])) {
    if (!node.title && !node.body) continue;
    const pad = "  ".repeat(depth);
    text += pad + stripOrgMarkup(node.title || "") + "\n";
    if (node.body) {
      for (const line of node.body.split("\n")) {
        text += line.trim() ? pad + "  " + stripOrgMarkup(line) + "\n" : "\n";
      }
    }
  }
  return text;
}
