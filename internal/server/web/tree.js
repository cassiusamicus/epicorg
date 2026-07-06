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
// right part becomes a new sibling immediately after.
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
const MARKUP_RE = /\*([^\s*][^*]*?)\*|\/([^\s/][^/]*?)\/|_([^\s_][^_]*?)_|=([^\s=][^=]*?)=|\+([^\s+][^+]*?)\+/g;

// Sentinel char (not producible by escapeHtml or normal text) used to mark
// link placeholders so the markup regex above doesn't reprocess link content.
const LINK_PLACEHOLDER = String.fromCharCode(1);

const IMAGE_EXTS_RE = /\.(?:png|gif|jpe?g|svg|tiff?|webp|bmp)$/i;
const ATTR_ORG_LINE_RE = /^#\+ATTR_ORG:\s*(.+)$/i;
const ATTR_HTML_LINE_RE = /^#\+ATTR_HTML:\s*(.+)$/i;
const IMAGE_LINK_LINE_RE = /^\[\[file:([^\]]+)\]\]$/i;

// Render body text that may contain inline images (#+ATTR_* + [[file:...]] blocks).
// Image blocks are extracted as <div> elements; everything else goes through
// renderOrgInline so org markup is still processed.
export function renderOrgBody(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const outputParts = [];
  const pendingLines = [];
  let imgIndex = 0;

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

  result = result.replace(MARKUP_RE, (match, bold, italic, underline, code, strike) => {
    if (bold !== undefined)   return `<strong>${bold}</strong>`;
    if (italic !== undefined) return `<em>${italic}</em>`;
    if (underline !== undefined) return `<u>${underline}</u>`;
    if (code !== undefined)   return `<code>${code}</code>`;
    return `<del>${strike}</del>`;
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
