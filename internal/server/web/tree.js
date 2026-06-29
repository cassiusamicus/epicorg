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

export function formatOrgScheduled(isoDate, time) {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T00:00:00");
  const day = DAYS[d.getDay()];
  return time ? `<${isoDate} ${day} ${time}>` : `<${isoDate} ${day}>`;
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

export function orgifyPaths(text) {
  if (!text) return text;
  return text.replace(BARE_PATH_ORG_RE, (_, path) => {
    const filename = path.split("/").pop();
    return `[[file:${path}][${filename}]]`;
  });
}

// Single combined pass: scanning left-to-right for whichever marker comes
// first avoids re-scanning HTML tags already emitted for an earlier match
// (e.g. italic's "/" matching inside a just-inserted "</strong>").
const MARKUP_RE = /\*([^\s*][^*]*?)\*|\/([^\s/][^/]*?)\/|_([^\s_][^_]*?)_|=([^\s=][^=]*?)=/g;

// Sentinel char (not producible by escapeHtml or normal text) used to mark
// link placeholders so the markup regex above doesn't reprocess link content.
const LINK_PLACEHOLDER = String.fromCharCode(1);

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
      html = match;
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

  result = result.replace(MARKUP_RE, (match, bold, italic, underline, code) => {
    if (bold !== undefined) return `<strong>${bold}</strong>`;
    if (italic !== undefined) return `<em>${italic}</em>`;
    if (underline !== undefined) return `<u>${underline}</u>`;
    return `<code>${code}</code>`;
  });

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
// matches, or one of its descendants does (kept as a breadcrumb). Either
// way, children are filtered too, so non-matching descendants are pruned
// even under a matching node. Returns the original list when both filters
// are empty. `selectedTags` matches with OR semantics (any one tag present
// on the node is enough); it combines with the text query using AND.
export function filterTree(nodes, query, selectedTags) {
  const hasTagFilter = selectedTags && selectedTags.length > 0;
  if (!query && !hasTagFilter) return nodes;
  const result = [];
  for (const n of nodes) {
    const textMatch = matchesQuery(query, n.title);
    const tagMatch = !hasTagFilter || (n.tags || []).some((t) => selectedTags.includes(t));
    const selfMatch = textMatch && tagMatch;
    const children = n.children?.length > 0 ? filterTree(n.children, query, selectedTags) : [];
    if (selfMatch || children.length > 0) {
      result.push({ ...n, collapsed: false, children });
    }
  }
  return result;
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
