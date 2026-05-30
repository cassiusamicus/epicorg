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

export function parseOrgDate(orgDate) {
  if (!orgDate) return "";
  const m = orgDate.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// --- Status ---

export const STATUS_CYCLE = ["", "TODO", "DONE"];

export function nextStatus(current) {
  const idx = STATUS_CYCLE.indexOf(current || "");
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}

// --- Fuzzy search ---

export function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = (text || "").toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Filter the tree so only nodes whose title (or any descendant's title)
// matches the query remain. Matching nodes keep all their descendants.
// Non-matching ancestors are kept as breadcrumbs when a descendant matches.
// Returns the original list when query is empty.
export function filterTree(nodes, query) {
  if (!query) return nodes;
  const result = [];
  for (const n of nodes) {
    if (fuzzyMatch(query, n.title)) {
      result.push({ ...n, collapsed: false });
    } else if (n.children?.length > 0) {
      const kept = filterTree(n.children, query);
      if (kept.length > 0) {
        result.push({ ...n, collapsed: false, children: kept });
      }
    }
  }
  return result;
}
