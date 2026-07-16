import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useReducer, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import * as tree from "./tree.js";
import { generateExportHtml, generateMarkdown, parseMdToNodes } from "./export.js";

const html = htm.bind(React.createElement);

// One-time migration from the old "torg." localStorage prefix (the app was
// renamed to epicorg). Copies each value across if not already migrated,
// then drops the old key.
(function migrateLocalStorageKeys() {
  const keys = [
    "theme", "lastFile", "recentFiles", "sidebarVisible",
    "titleFormatMode", "readingWidth", "detailWidth", "detailVisible",
  ];
  try {
    for (const key of keys) {
      const oldKey = "torg." + key;
      const newKey = "epicorg." + key;
      if (localStorage.getItem(newKey) === null && localStorage.getItem(oldKey) !== null) {
        localStorage.setItem(newKey, localStorage.getItem(oldKey));
      }
      localStorage.removeItem(oldKey);
    }
  } catch (e) {}
})();

// --- API ---

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
};

// Build the correct API URL for a doc/hash request. Absolute filesystem
// paths (from the folder browser) go as a query param to avoid Go's mux
// cleaning double-slashes; relative workspace names go in the path segment.
function docUrl(name) {
  if (name && name.startsWith("/")) return "/api/doc/?abs=" + encodeURIComponent(name);
  return "/api/doc/" + encodeURIComponent(name);
}
function hashUrl(name) {
  if (name && name.startsWith("/")) return "/api/hash/?abs=" + encodeURIComponent(name);
  return "/api/hash/" + encodeURIComponent(name);
}

// --- Agenda helpers ---

const PRIORITY_ORDER = { A: 0, B: 1, C: 2 };
function priorityRank(p) { return p && PRIORITY_ORDER[p] !== undefined ? PRIORITY_ORDER[p] : 3; }

function collectTodoItems(nodes, ancestors = []) {
  const items = [];
  for (const n of nodes) {
    if (n.status && n.status !== "DONE" && n.status !== "CANCELLED") {
      items.push({ id: n.id, title: n.title, status: n.status, priority: n.priority || "", tags: n.tags || [], ancestors });
    }
    if (n.children?.length > 0) {
      items.push(...collectTodoItems(n.children, [...ancestors, n.title]));
    }
  }
  return items;
}

function collectDatedItems(nodes, ancestors = []) {
  const items = [];
  for (const n of nodes) {
    const scheduledRaw = n.properties?.SCHEDULED || "";
    const deadlineRaw  = n.properties?.DEADLINE  || "";
    const scheduledDate = tree.parseOrgDate(scheduledRaw);
    const deadlineDate  = tree.parseOrgDate(deadlineRaw);
    if (scheduledDate) {
      items.push({ id: n.id, title: n.title, date: scheduledDate,
        time: tree.parseOrgScheduledTime(scheduledRaw), kind: "scheduled",
        status: n.status, tags: n.tags, ancestors, scheduledRaw, deadlineRaw });
    }
    if (deadlineDate && deadlineDate !== scheduledDate) {
      items.push({ id: n.id, title: n.title, date: deadlineDate, time: "", kind: "deadline",
        status: n.status, tags: n.tags, ancestors, scheduledRaw, deadlineRaw });
    }
    if (n.children?.length > 0) {
      items.push(...collectDatedItems(n.children, [...ancestors, n.title]));
    }
  }
  return items;
}

function formatDateDisplay(dateStr) {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  } catch { return dateStr; }
}

function isOverdue(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(dateStr + "T00:00:00") < today;
}

function isToday(dateStr) {
  const d = new Date();
  const local = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return dateStr === local;
}

function localDateStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Cycles through agenda/journal date filters: all → future → past → all
const DATE_FILTERS = ["all", "future", "past"];
const DATE_FILTER_LABELS = { all: "All dates", future: "Present & Future", past: "Present & Past" };

function formatJournalDate(dateStr) {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch { return dateStr; }
}

// --- Components ---

function PreambleRow({ focused, preamble, dispatch, inputRefs }) {
  const title = tree.extractPreambleTitle(preamble);
  return html`
    <div className=${"node-row preamble-row" + (focused ? " focused" : "")}
         onClick=${() => dispatch("preamble", "focus")}
         ref=${(el) => { if (el) inputRefs.current["preamble"] = el; }}
         tabIndex="0"
         onFocus=${() => dispatch("preamble", "focus")}
         onKeyDown=${(e) => {
           if (e.key === "ArrowDown") { e.preventDefault(); dispatch("preamble", "nav-down"); }
           if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); dispatch("preamble", "focus-body"); }
         }}>
      <span className="preamble-icon">\u00B6</span>
      ${title
        ? html`<span className="preamble-label preamble-title" dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(title) }} />`
        : html`<span className="preamble-label">Preamble</span>`}
    </div>
  `;
}

function adjustTextareaHeight(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

// Lowest unused integer footnote label across the whole document.
function nextFootnoteLabel(nodes) {
  const used = new Set();
  const RE = /\[fn:(\d+)\]/g;
  function scan(list) {
    for (const n of list) {
      let m;
      RE.lastIndex = 0; while ((m = RE.exec(n.title || "")) !== null) used.add(Number(m[1]));
      RE.lastIndex = 0; while ((m = RE.exec(n.body  || "")) !== null) used.add(Number(m[1]));
      if (n.children?.length > 0) scan(n.children);
    }
  }
  scan(nodes || []);
  let n = 1; while (used.has(n)) n++;
  return String(n);
}

// Fire from anywhere in the tree without prop-drilling.
function triggerInsertFootnote() {
  document.body.dispatchEvent(new CustomEvent("epicInsertFootnote"));
}

// Fire a custom event so the App can show the link picker without
// prop-drilling a callback through the entire OutlineNode tree.
// isBody=true fires epicWikiLinkTrigger (note titles); otherwise epicLinkTrigger (file links).
function triggerLinkPicker(textarea, e, isBody) {
  // Don't trigger while deleting — only on insertion.
  const inputType = e?.nativeEvent?.inputType ?? "";
  if (inputType.startsWith("delete")) return;
  const pos = textarea.selectionStart;
  if (!textarea.value.substring(0, pos).endsWith("[[")) return;
  const eventName = isBody ? "epicWikiLinkTrigger" : "epicLinkTrigger";
  document.body.dispatchEvent(new CustomEvent(eventName, {
    detail: { textarea, cursorPos: pos },
  }));
}

// Notes/body text under a bullet — shown only when non-empty or actively
// being edited, so empty items don't clutter the outline. Mirrors the
// title's formatted-preview/edit-textarea split, governed by the same
// titleFormatMode toggle.
function NoteContextMenu({ x, y, sel, textarea, nodeId, dispatch, onCommit, onClose }) {
  const menuRef = useRef(null);
  const hasSel = sel.start !== sel.end;

  useEffect(() => {
    const down = (e) => { if (!menuRef.current?.contains(e.target)) onClose(); };
    const key  = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [onClose]);

  const commit = (newVal, cursor) => { onCommit(newVal, cursor); onClose(); };

  const doCut = async () => {
    if (!hasSel) return onClose();
    const text = sel.value.slice(sel.start, sel.end);
    await navigator.clipboard.writeText(text).catch(() => {});
    commit(sel.value.slice(0, sel.start) + sel.value.slice(sel.end), sel.start);
  };
  const doCopy = async () => {
    if (hasSel) await navigator.clipboard.writeText(sel.value.slice(sel.start, sel.end)).catch(() => {});
    onClose();
  };
  const doPaste = async () => {
    const text = await navigator.clipboard.readText().catch(() => "");
    const newVal = sel.value.slice(0, sel.start) + text + sel.value.slice(sel.end);
    commit(newVal, sel.start + text.length);
  };
  const doSelectAll = () => {
    textarea.select();
    onClose();
  };
  const doSplit = () => {
    dispatch(nodeId, "split-body-at-cursor", sel.start);
    onClose();
  };
  const doJoin = () => {
    dispatch(nodeId, "join-with-next");
    onClose();
  };

  const style = { position: "fixed", left: x, top: y, zIndex: 9999 };
  return html`
    <div ref=${menuRef} className="note-ctx-menu" style=${style}>
      <button className="note-ctx-item" disabled=${!hasSel} onClick=${doCut}>Cut</button>
      <button className="note-ctx-item" disabled=${!hasSel} onClick=${doCopy}>Copy</button>
      <button className="note-ctx-item" onClick=${doPaste}>Paste</button>
      <div className="note-ctx-sep" />
      <button className="note-ctx-item" onClick=${doSelectAll}>Select All</button>
      <div className="note-ctx-sep" />
      <button className="note-ctx-item" onClick=${doSplit}>Split At Cursor Location</button>
      <button className="note-ctx-item" onClick=${doJoin}>Join with Next Node</button>
    </div>
  `;
}

// Per-node action menu — opened by clicking or right-clicking the hover
// handle to the left of a node's bullet (or right-clicking the bullet
// itself). Reuses the note-ctx-* classes so it looks consistent with
// NoteContextMenu above. Hoist bypasses the generic dispatch(nodeId, action)
// path because toggleHoist normally infers its target from whichever node
// happens to be keyboard-focused — irrelevant here, since the menu can be
// opened on any node regardless of focus.
function NodeActionMenu({ x, y, nodeId, isHoisted, dispatch, onToggleHoistNode, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const down = (e) => { if (!menuRef.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [onClose]);

  const run = (action) => { dispatch(nodeId, action); onClose(); };

  const style = { position: "fixed", left: x, top: y, zIndex: 9999 };
  return html`
    <div ref=${menuRef} className="note-ctx-menu" style=${style}>
      <button className="note-ctx-item" onClick=${() => run("duplicate")}>Duplicate</button>
      <button className="note-ctx-item" onClick=${() => run("delete")}>Delete</button>
      <div className="note-ctx-sep" />
      <button className="note-ctx-item" onClick=${() => run("move-up")}>Move Up</button>
      <button className="note-ctx-item" onClick=${() => run("move-down")}>Move Down</button>
      <button className="note-ctx-item" onClick=${() => run("indent")}>Indent</button>
      <button className="note-ctx-item" onClick=${() => run("outdent")}>Outdent</button>
      <div className="note-ctx-sep" />
      <button className="note-ctx-item" onClick=${() => { onToggleHoistNode(nodeId); onClose(); }}>${isHoisted ? "Unhoist" : "Hoist"}</button>
    </div>
  `;
}

const IMAGE_EXTS_BROWSE = new Set(["png","jpg","jpeg","gif","svg","webp","bmp","tif","tiff"]);

function InsertImageDialog({ onInsert, onClose }) {
  const [selectedPath, setSelectedPath] = useState("");
  const [width, setWidth] = useState("");
  const [align, setAlign] = useState("left");
  const rootRef = useRef("");
  const [rootState, setRootState] = useState("");
  const [currentAbs, setCurrentAbs] = useState("");
  const [dirs, setDirs] = useState([]);
  const [imgFiles, setImgFiles] = useState([]);
  const [loading, setLoading] = useState(false);

  const browse = useCallback(async (pathArg) => {
    setLoading(true);
    try {
      const url = pathArg != null ? "/api/browse?path=" + encodeURIComponent(pathArg) : "/api/browse?path=";
      const res = await fetch(url);
      const data = await res.json();
      if (!rootRef.current) { rootRef.current = data.path; setRootState(data.path); }
      setCurrentAbs(data.path);
      setDirs(data.dirs || []);
      setImgFiles((data.files || []).filter(f => IMAGE_EXTS_BROWSE.has(f.split(".").pop().toLowerCase())));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    browse(null);
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const relPath = (filename) => {
    const rel = rootState && currentAbs.startsWith(rootState)
      ? currentAbs.slice(rootState.length).replace(/^\/+/, "") : "";
    return rel ? rel + "/" + filename : filename;
  };

  const canGoUp = rootState && currentAbs && currentAbs !== rootState;
  const currentRel = rootState && currentAbs.startsWith(rootState)
    ? currentAbs.slice(rootState.length).replace(/^\/+/, "") : "";

  const doInsert = () => {
    const p = selectedPath.trim();
    if (!p) return;
    const lines = [];
    const w = parseInt(width) || null;
    if (w) lines.push(`#+ATTR_ORG: :width ${w}`);
    if (align === "center") lines.push(`#+ATTR_HTML: :style "display:block;margin:0 auto;"`);
    else if (align === "right") lines.push(`#+ATTR_HTML: :style "display:block;margin-left:auto;"`);
    lines.push(`[[file:${p}]]`);
    onInsert(lines.join("\n"));
    onClose();
  };

  return html`
    <div className="folder-picker-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="img-insert-dialog">
        <div className="img-insert-header">
          <span className="img-insert-title">Insert Image</span>
          <button className="folder-picker-close" onClick=${onClose}>×</button>
        </div>
        <div className="img-insert-body">
          <div>
            <div className="img-browse-nav">
              ${canGoUp ? html`
                <button className="img-browse-up"
                        onClick=${() => { const p = currentAbs.split("/"); p.pop(); browse(p.join("/")); }}>
                  ↑ Up
                </button>
              ` : null}
              <span className="img-browse-path">${currentRel || "workspace root"}</span>
            </div>
            <div className="img-browse-list">
              ${loading && html`<div className="folder-picker-loading">Loading…</div>`}
              ${!loading && dirs.map((d) => html`
                <div key=${"d:" + d} className="img-browse-dir"
                     onClick=${() => browse(currentAbs + "/" + d)}>
                  📁 ${d}
                </div>
              `)}
              ${!loading && imgFiles.map((f) => {
                const p = relPath(f);
                return html`
                  <div key=${"f:" + f}
                       className=${"img-browse-file" + (selectedPath === p ? " active" : "")}
                       onClick=${() => setSelectedPath(p)}>
                    🖼 ${f}
                  </div>
                `;
              })}
              ${!loading && dirs.length === 0 && imgFiles.length === 0 && html`
                <div className="folder-picker-empty">No images in this folder</div>
              `}
            </div>
            ${selectedPath ? html`<div className="img-browse-selected">📌 ${selectedPath}</div>` : null}
          </div>
          <div className="img-insert-row">
            <label className="img-insert-label">Width (px, blank = natural size)</label>
            <input type="number" className="img-insert-width"
                   placeholder="e.g. 400" min="1" max="9999"
                   value=${width}
                   onInput=${(e) => setWidth(e.target.value)} />
          </div>
          <div className="img-insert-row">
            <label className="img-insert-label">Alignment</label>
            <div className="img-insert-align">
              <button className=${"img-align-btn" + (align === "left" ? " active" : "")}
                      onClick=${() => setAlign("left")}>Left</button>
              <button className=${"img-align-btn" + (align === "center" ? " active" : "")}
                      onClick=${() => setAlign("center")}>Center</button>
              <button className=${"img-align-btn" + (align === "right" ? " active" : "")}
                      onClick=${() => setAlign("right")}>Right</button>
            </div>
          </div>
          <div className="img-insert-footer">
            <button className="stg-btn" onClick=${onClose}>Cancel</button>
            <button className="stg-btn img-insert-ok"
                    disabled=${!selectedPath}
                    onClick=${doInsert}>Insert</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function ImageEditPopup({ imgIndex, block, nodeBody, rect, onUpdate, onClose }) {
  const [widthInput, setWidthInput] = useState(block.width ? String(block.width) : "");

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    const onScroll = () => onClose();
    const onMouseDown = e => {
      if (!e.target.closest(".img-edit-popup") && !e.target.closest(".org-img-block")) onClose();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  const applyAlign = (a) => {
    const w = parseInt(widthInput) || null;
    onUpdate(tree.updateImageBlock(nodeBody, imgIndex, { width: w, align: a }));
  };

  const applyWidth = () => {
    const w = parseInt(widthInput) || null;
    onUpdate(tree.updateImageBlock(nodeBody, imgIndex, { width: w, align: block.align }));
  };

  const left = Math.min(rect.left, window.innerWidth - 270);
  const top = (window.innerHeight - rect.bottom >= 110) ? rect.bottom + 6 : Math.max(4, rect.top - 106);

  return html`
    <div className="img-edit-popup" style=${{ position: "fixed", left, top, zIndex: 9500 }}
         onMouseDown=${e => e.stopPropagation()}>
      <span className="img-edit-label">Align</span>
      <div className="img-edit-align">
        <button className=${"img-align-btn" + (block.align === "left" ? " active" : "")}
                onClick=${() => applyAlign("left")}>Left</button>
        <button className=${"img-align-btn" + (block.align === "center" ? " active" : "")}
                onClick=${() => applyAlign("center")}>Center</button>
        <button className=${"img-align-btn" + (block.align === "right" ? " active" : "")}
                onClick=${() => applyAlign("right")}>Right</button>
      </div>
      <span className="img-edit-label">Width px</span>
      <input type="number" className="img-insert-width" placeholder="auto"
             min="1" max="9999" value=${widthInput}
             onInput=${e => setWidthInput(e.target.value)}
             onBlur=${applyWidth}
             onKeyDown=${e => { if (e.key === "Enter") { applyWidth(); onClose(); } }} />
      <button className="img-edit-close" title="Close" onClick=${onClose}>✕</button>
    </div>
  `;
}

function TableEditor({ rows: initRows, headerCount: initHeaderCount, onSave, onCancel }) {
  const [rows, setRows] = useState(() => initRows.map((r) => [...r]));
  const [headerCount, setHeaderCount] = useState(initHeaderCount);

  const numCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
  const padded = rows.map((r) => { const p = [...r]; while (p.length < numCols) p.push(""); return p; });

  const setCell = (ri, ci, val) =>
    setRows((prev) => prev.map((row, r) => r !== ri ? row : row.map((c, ci2) => ci2 !== ci ? c : val)));

  const addRow = (afterRi) => {
    setRows((prev) => { const n = [...prev]; n.splice(afterRi + 1, 0, Array(numCols).fill("")); return n; });
  };

  const delRow = (ri) => {
    if (rows.length <= 1) return;
    setRows((prev) => prev.filter((_, i) => i !== ri));
    setHeaderCount((h) => ri < h ? Math.max(0, h - 1) : h);
  };

  const addCol = (afterCi) => {
    setRows((prev) => prev.map((row) => { const n = [...row]; n.splice(afterCi + 1, 0, ""); return n; }));
  };

  const delCol = (ci) => {
    if (numCols <= 1) return;
    setRows((prev) => prev.map((row) => row.filter((_, i) => i !== ci)));
  };

  const toggleHeader = (ri) => {
    setHeaderCount(ri < headerCount ? ri : ri + 1);
  };

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel]);

  const focusNext = (e, ri, ci) => {
    e.preventDefault();
    const grid = e.target.closest(".te-grid");
    if (!grid) return;
    const inputs = [...grid.querySelectorAll(".te-input")];
    const idx = inputs.indexOf(e.target);
    const next = inputs[idx + 1];
    if (next) { next.focus(); return; }
    // last cell in last row → add row and focus first cell of new row
    addRow(ri);
    requestAnimationFrame(() => {
      const newInputs = [...grid.querySelectorAll(".te-input")];
      newInputs[idx + 1]?.focus();
    });
  };

  const focusPrev = (e) => {
    e.preventDefault();
    const grid = e.target.closest(".te-grid");
    if (!grid) return;
    const inputs = [...grid.querySelectorAll(".te-input")];
    const idx = inputs.indexOf(e.target);
    if (idx > 0) inputs[idx - 1].focus();
  };

  const focusDown = (e, ri, ci) => {
    e.preventDefault();
    const grid = e.target.closest(".te-grid");
    if (!grid) return;
    const inputs = [...grid.querySelectorAll(".te-input")];
    const idx = inputs.indexOf(e.target);
    const down = inputs[idx + numCols];
    if (down) down.focus();
    else { addRow(ri); requestAnimationFrame(() => { const ni = [...grid.querySelectorAll(".te-input")]; ni[idx + numCols]?.focus(); }); }
  };

  return html`
    <div className="te-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="te-modal" onMouseDown=${(e) => e.stopPropagation()}>
        <div className="te-header">
          <span className="te-title">Edit Table</span>
          <button className="te-close" title="Close" onClick=${onCancel}>✕</button>
        </div>
        <div className="te-body">
          <div className="te-table-wrap">
            <table className="te-grid">
              <thead>
                <tr className="te-col-ctrls">
                  ${Array(numCols).fill(0).map((_, ci) => html`
                    <th key=${ci} className="te-col-th">
                      <button className="te-btn te-del" title="Delete column" onClick=${() => delCol(ci)}>−</button>
                      <button className="te-btn" title="Insert column after" onClick=${() => addCol(ci)}>+</button>
                    </th>
                  `)}
                  <th className="te-col-th">
                    <button className="te-btn" title="Add column" onClick=${() => addCol(numCols - 1)}>+ Col</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                ${padded.map((row, ri) => {
                  const isHdr = ri < headerCount;
                  const showSep = ri === headerCount && headerCount > 0;
                  return html`
                    <${React.Fragment} key=${ri}>
                      ${showSep ? html`
                        <tr className="te-sep-row"><td colSpan=${numCols + 1} className="te-sep-cell">▲ header  ▼ body</td></tr>
                      ` : null}
                      <tr className=${"te-row" + (isHdr ? " te-hdr-row" : "")}>
                        ${row.map((cell, ci) => html`
                          <td key=${ci} className="te-cell">
                            <input className="te-input" value=${cell}
                              onChange=${(e) => setCell(ri, ci, e.target.value)}
                              onKeyDown=${(e) => {
                                if (e.key === "Tab" && !e.shiftKey) focusNext(e, ri, ci);
                                else if (e.key === "Tab" && e.shiftKey) focusPrev(e);
                                else if (e.key === "Enter" && !e.shiftKey) focusDown(e, ri, ci);
                              }} />
                          </td>
                        `)}
                        <td className="te-row-acts">
                          <button className=${"te-btn te-h-btn" + (isHdr ? " te-h-on" : "")}
                                  title=${isHdr ? "Demote to body row" : "Promote to header row"}
                                  onClick=${() => toggleHeader(ri)}>H</button>
                          <button className="te-btn" title="Insert row below" onClick=${() => addRow(ri)}>+</button>
                          <button className="te-btn te-del" title="Delete row" onClick=${() => delRow(ri)}>−</button>
                        </td>
                      </tr>
                    </${React.Fragment}>
                  `;
                })}
                <tr><td colSpan=${numCols + 1}>
                  <button className="te-add-row-btn" onClick=${() => addRow(rows.length - 1)}>+ Add Row</button>
                </td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="te-footer">
          <button className="te-footer-btn" onClick=${onCancel}>Cancel</button>
          <button className="te-footer-btn te-save-btn" onClick=${() => onSave({ rows: padded, headerCount })}>Done</button>
        </div>
      </div>
    </div>
  `;
}

function NodeBody({ node, dispatch, isEditing, isPreview, titleFormatMode, notesVisible, depth, bodyRefs }) {
  const localRef = useRef(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [imgPopup, setImgPopup] = useState(null); // { index, rect }
  const [tableEdit, setTableEdit] = useState(null); // { tableIndex, rows, headerCount }

  useEffect(() => {
    adjustTextareaHeight(localRef.current);
  }, [node.body, isEditing]);

  useEffect(() => {
    const ta = localRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => adjustTextareaHeight(ta));
    ro.observe(ta);
    return () => ro.disconnect();
  }, [isEditing]);

  // The global notes toggle hides this row — unless the user explicitly
  // drilled into this specific item's note (Shift+Enter or clicking the
  // "…" marker), which overrides the collapse for just that one item.
  if (!isEditing && !isPreview && (!notesVisible || !node.body)) return null;

  const showFormatted = !isEditing;

  return html`
    <div className="node-body-row">
      <span style=${{ width: depth * 24 + 40, flexShrink: 0 }} />
      ${showFormatted
        ? html`
          <div className="node-body-preview"
               data-node-id=${node.id}
               onClick=${(e) => {
                 const wikiEl = e.target.closest(".wiki-link");
                 if (wikiEl) {
                   e.preventDefault();
                   document.body.dispatchEvent(new CustomEvent("epicWikiNav", { detail: { name: wikiEl.dataset.wiki } }));
                   return;
                 }
                 const tableEl = e.target.closest(".org-table");
                 if (tableEl) {
                   const idx = parseInt(tableEl.dataset.tableIndex || "0");
                   const blocks = tree.findTableBlocksInBody(node.body || "");
                   if (blocks[idx]) {
                     const { rows, headerCount } = tree.parseOrgTableData(blocks[idx].lines);
                     setTableEdit({ tableIndex: idx, rows, headerCount });
                   }
                   return;
                 }
                 const imgBlock = e.target.closest(".org-img-block");
                 if (imgBlock) {
                   const idx = parseInt(imgBlock.dataset.imgIndex);
                   const blocks = tree.parseImageBlocks(node.body);
                   if (blocks[idx]) setImgPopup({ index: idx, rect: imgBlock.getBoundingClientRect() });
                   return;
                 }
                 if (imgPopup) { setImgPopup(null); return; }
                 dispatch(node.id, "edit-body");
               }}
               onMouseOver=${(e) => {
                 const wikiEl = e.target.closest(".wiki-link");
                 if (!wikiEl) return;
                 document.body.dispatchEvent(new CustomEvent("epicWikiHover", {
                   detail: { name: wikiEl.dataset.wiki, rect: wikiEl.getBoundingClientRect(), over: true },
                 }));
               }}
               onMouseOut=${(e) => {
                 const wikiEl = e.target.closest(".wiki-link");
                 if (!wikiEl) return;
                 if (e.relatedTarget?.closest?.(".wiki-hover-popup")) return;
                 document.body.dispatchEvent(new CustomEvent("epicWikiHover", {
                   detail: { name: wikiEl.dataset.wiki, over: false },
                 }));
               }}
               dangerouslySetInnerHTML=${{ __html: tree.renderOrgBody(node.body) }} />
        `
        : html`
          <textarea
            rows=${1}
            ref=${(el) => {
              localRef.current = el;
              if (el) { bodyRefs.current[node.id] = el; adjustTextareaHeight(el); }
            }}
            className="node-body-textarea"
            data-node-id=${node.id}
            value=${node.body || ""}
            placeholder="Add notes..."
            onChange=${(e) => { dispatch(node.id, "change-body", tree.orgifyPaths(e.target.value)); triggerLinkPicker(e.target, e, true); }}
            onContextMenu=${(e) => {
              e.preventDefault();
              const ta = e.target;
              setCtxMenu({ x: e.clientX, y: e.clientY, textarea: ta,
                sel: { start: ta.selectionStart, end: ta.selectionEnd, value: ta.value } });
            }}
            onBlur=${() => {
              dispatch(node.id, "stop-edit-body");
              if (!document.hasFocus()) dispatch(node.id, "preview-body");
            }}
            onKeyDown=${(e) => {
              const marker = formatMarkerForKey(e);
              if (marker) { e.preventDefault(); wrapSelectionWithMarker(e, marker, (v) => dispatch(node.id, "change-body", v)); return; }
              if (matchShortcut("splitNode", e)) { e.preventDefault(); dispatch(node.id, "split-body-at-cursor", e.target.selectionStart); return; }
              if (e.key === "Escape") { e.preventDefault(); dispatch(node.id, "focus-outline"); }
            }}
          />
          <button className="body-fn-btn" title="Insert footnote reference [fn:N]"
                  onMouseDown=${(e) => { e.preventDefault(); localRef.current?.focus(); triggerInsertFootnote(); }}>fn</button>
          <button className="body-fn-btn" title="Insert inline image"
                  onMouseDown=${(e) => {
                    e.preventDefault();
                    const ta = localRef.current;
                    document.body.dispatchEvent(new CustomEvent("epicInsertImage", {
                      detail: { nodeId: node.id, cursorPos: ta ? ta.selectionStart : (node.body || "").length, body: node.body || "" }
                    }));
                  }}>img</button>
          <button className="body-fn-btn" title="Insert table"
                  onMouseDown=${(e) => {
                    e.preventDefault();
                    const ta = localRef.current;
                    const body = node.body || "";
                    const pos = ta ? ta.selectionStart : body.length;
                    const before = body.slice(0, pos);
                    const after = body.slice(pos);
                    const pre = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
                    const post = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
                    const blankRows = [["", ""], ["", ""]];
                    const newLines = tree.serializeOrgTable({ rows: blankRows, headerCount: 1 });
                    const tableText = newLines.join("\n");
                    const newBody = before + pre + tableText + post + after;
                    // New table index = number of table blocks in the text before insertion point
                    const newTableIndex = tree.findTableBlocksInBody(before + pre).length;
                    dispatch(node.id, "change-body", newBody);
                    dispatch(node.id, "preview-body");
                    setTableEdit({ tableIndex: newTableIndex, rows: blankRows, headerCount: 1 });
                  }}>tbl</button>
        `}
    </div>
    ${ctxMenu && html`<${NoteContextMenu}
      x=${ctxMenu.x} y=${ctxMenu.y}
      sel=${ctxMenu.sel} textarea=${ctxMenu.textarea}
      nodeId=${node.id} dispatch=${dispatch}
      onCommit=${(newVal, cursor) => {
        dispatch(node.id, "change-body", tree.orgifyPaths(newVal));
        requestAnimationFrame(() => {
          ctxMenu.textarea.focus();
          ctxMenu.textarea.setSelectionRange(cursor, cursor);
        });
      }}
      onClose=${() => setCtxMenu(null)} />`}
    ${imgPopup && (() => {
      const blocks = tree.parseImageBlocks(node.body);
      const block = blocks[imgPopup.index];
      return block ? html`<${ImageEditPopup}
        imgIndex=${imgPopup.index}
        block=${block}
        nodeBody=${node.body}
        rect=${imgPopup.rect}
        onUpdate=${(newBody) => dispatch(node.id, "change-body", newBody)}
        onClose=${() => setImgPopup(null)} />` : null;
    })()}
    ${tableEdit && html`<${TableEditor}
      rows=${tableEdit.rows}
      headerCount=${tableEdit.headerCount}
      onSave=${({ rows, headerCount }) => {
        const newLines = tree.serializeOrgTable({ rows, headerCount });
        const newBody = tree.replaceTableBlockInBody(node.body || "", tableEdit.tableIndex, newLines);
        dispatch(node.id, "change-body", newBody);
        setTableEdit(null);
      }}
      onCancel=${() => setTableEdit(null)} />`}
  `;
}

function inlineTagChipsHtml(tags) {
  return tags.map((t) => `<span class="node-tag-chip inline-chip" data-tag="${t}">${t}</span>`).join(" ");
}

function toLetters(n, upper) {
  let result = "";
  while (n > 0) { result = String.fromCharCode((upper ? 65 : 97) + (n - 1) % 26) + result; n = Math.floor((n - 1) / 26); }
  return result + ".";
}

function OutlineNode({ node, focusedId, dispatch, inputRefs, depth, titleFormatMode, notesVisible, outlineFormat, levelFormats, siblingIndex, verticalLines, showTagChips, tagsOnRight, onSearchTag, bodyEditingId, bodyPreviewId, bodyRefs, onNodeHandleMouseDown, onNodeHandleMenu, nodeMenuOpenId, globalFont, levelFonts, globalColor, levelColors }) {
  const isFocused = focusedId === node.id;
  const hasChildren = node.children?.length > 0;
  const bulletFmt = (levelFormats && levelFormats[depth]) || outlineFormat || "bullets";
  const effectiveFont = (levelFonts && levelFonts[depth]) || globalFont;
  const effectiveColor = (levelColors && levelColors[depth]) || globalColor;
  const typoStyle = {};
  if (effectiveFont) {
    const css = FONT_CSS[effectiveFont] || (effectiveFont.startsWith("custom:") ? effectiveFont.slice(7) : null);
    if (css) typoStyle.fontFamily = css;
  }
  if (effectiveColor) typoStyle.color = effectiveColor;
  const isIndexed = bulletFmt === "numbers" || bulletFmt === "letters" || bulletFmt === "upper";
  const bulletLabel = bulletFmt === "letters" ? toLetters(siblingIndex) : bulletFmt === "upper" ? toLetters(siblingIndex, true) : siblingIndex + ".";
  const titleRef = useRef(null);
  const [isEditing, setIsEditing] = useState(false);
  const pendingEditRef = useRef(false);
  const showFormatted = titleFormatMode && !isFocused;
  // When focused but not yet editing: overlay rendered view over a hidden (keyboard-capturing) textarea.
  // Skip overlay for empty titles — there's nothing to render and no way for the user to click into it.
  const showOverlay = titleFormatMode && isFocused && !isEditing && node.title !== "";
  const bodyEditing = bodyEditingId === node.id;
  const bodyPreview = bodyPreviewId === node.id;
  const hasHiddenNote = !notesVisible && !!node.body && !bodyEditing && !bodyPreview;

  // Reset to view mode when losing focus; enter edit immediately when a mouse
  // click set pendingEditRef before the dispatch that changed focusedId.
  useEffect(() => {
    if (!isFocused) {
      setIsEditing(false);
    } else if (pendingEditRef.current) {
      pendingEditRef.current = false;
      setIsEditing(true);
      requestAnimationFrame(() => titleRef.current?.focus());
    }
  }, [isFocused]);

  useEffect(() => {
    adjustTextareaHeight(titleRef.current);
  }, [node.title]);

  // Fix textarea height when transitioning from hidden overlay → visible edit mode.
  useLayoutEffect(() => {
    if (isEditing && titleRef.current) adjustTextareaHeight(titleRef.current);
  }, [isEditing]);

  // Re-attach whenever the textarea (re)mounts — notably when switching out
  // of the formatted preview back to editing, which swaps in a brand-new
  // textarea that starts at its default single-row height regardless of how
  // many lines the wrapped text actually needs.
  useEffect(() => {
    const ta = titleRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => adjustTextareaHeight(ta));
    ro.observe(ta);
    return () => ro.disconnect();
  }, [showFormatted]);

  return html`
    <div>
      <div className=${"node-row" + (isFocused ? " focused" : "")} data-node-id=${node.id} data-depth=${depth}>
        ${verticalLines
          ? Array.from({ length: depth }, (_, i) => html`<span key=${i} className="indent-guide" />`)
          : html`<span style=${{ width: depth * 24, flexShrink: 0 }} />`}
        <span className=${"node-handle" + (nodeMenuOpenId === node.id ? " menu-open" : "")}
              title="Drag to move \u00B7 Click for actions"
              onMouseDown=${(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                onNodeHandleMouseDown?.(node.id, e);
              }}
              onContextMenu=${(e) => {
                e.preventDefault();
                onNodeHandleMenu?.(node.id, e.clientX, e.clientY);
              }}>
          <${IconNodeHandle} />
        </span>
        <span className=${"bullet" + (hasChildren ? (node.collapsed ? " has-children collapsed" : " has-children expanded") : "") + (isIndexed ? " numbered" : "")}
              onClick=${() => {
                if (hasChildren) dispatch(node.id, "toggle");
                else { dispatch(node.id, "focus"); dispatch(node.id, "edit-title"); }
              }}
              onContextMenu=${(e) => {
                e.preventDefault();
                onNodeHandleMenu?.(node.id, e.clientX, e.clientY);
              }}>
          ${isIndexed && html`<span className="bullet-caret">${hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : ""}</span>`}
          ${isIndexed && html`<span className="bullet-number">${bulletLabel}</span>`}
          ${!isIndexed && (hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : html`<span className="bullet-dot" />`)}
        </span>
        ${showFormatted
          ? html`
            <div className=${"node-title node-title-preview" + (node.status === "DONE" || node.status === "CANCELLED" ? " done" : "")}
                 style=${typoStyle}
                 onClick=${(e) => {
                   if (e.target.closest(".status-badge")) { e.stopPropagation(); dispatch(node.id, "cycle-status"); return; }
                   if (e.target.closest(".priority-badge")) { e.stopPropagation(); dispatch(node.id, "set-priority", node.priority === "A" ? "B" : node.priority === "B" ? "C" : "A"); return; }
                   const tagEl = e.target.closest("[data-tag]");
                   if (tagEl) { e.stopPropagation(); onSearchTag?.(tagEl.dataset.tag); return; }
                   if (e.target.closest(".node-has-notes-indicator")) { dispatch(node.id, "preview-body"); return; }
                   pendingEditRef.current = true;
                   dispatch(node.id, "edit-title");
                 }}
                 dangerouslySetInnerHTML=${{
                   __html: tree.renderOrgInline(node.title) +
                     (hasHiddenNote ? ' <span class="node-has-notes-indicator" title="This item has a hidden note — click to view it">…</span>' : "") +
                     (showTagChips && !tagsOnRight ? (
                       (node.status ? ` <span class="status-badge status-${node.status.toLowerCase()}">${node.status}</span>` : "") +
                       (node.priority ? ` <span class="priority-badge priority-${node.priority}">${node.priority}</span>` : "") +
                       (node.tags?.length > 0 ? ' <span class="node-tag-chips-inline">' + inlineTagChipsHtml(node.tags) + "</span>" : "")
                     ) : ""),
                 }} />
          `
          : html`
            <textarea
              rows=${1}
              ref=${(el) => {
                titleRef.current = el;
                if (el) { inputRefs.current[node.id] = el; adjustTextareaHeight(el); }
              }}
              className=${"node-title" + (node.status === "DONE" || node.status === "CANCELLED" ? " done" : "")}
              style=${showOverlay ? {position:"absolute",left:"-9999px",opacity:0,pointerEvents:"none",width:"1px",height:"1px",padding:0,border:0,overflow:"hidden",margin:0} : typoStyle}
              value=${node.title}
              placeholder=""
              onFocus=${() => dispatch(node.id, "focus")}
              onKeyDown=${(e) => {
                if (e.key === "Escape" && titleFormatMode) {
                  e.preventDefault();
                  dispatch(node.id, "release-focus");
                  return;
                }
                // In overlay (navigation) mode, Enter should begin editing rather
                // than creating a new sibling via handleKey.
                if (showOverlay && e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  setIsEditing(true);
                  return;
                }
                if (showOverlay && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) setIsEditing(true);
                // When actively editing, let the browser move the cursor first for
                // ArrowUp/Down. Check in rAF whether it actually moved — if not, the
                // cursor was already at the visual boundary and we navigate to the
                // adjacent node. This handles both literal-newline and word-wrapped
                // titles without needing to measure visual line position.
                if (isEditing && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey) {
                  const ta = e.target;
                  const posBefore = ta.selectionStart;
                  const dir = e.key === "ArrowUp" ? "nav-up" : "nav-down";
                  requestAnimationFrame(() => {
                    if (ta.selectionStart === posBefore) dispatch(node.id, dir);
                  });
                  return;
                }
                handleKey(e, node.id, dispatch);
              }}
              onChange=${(e) => { setIsEditing(true); dispatch(node.id, "change", tree.orgifyPaths(e.target.value)); triggerLinkPicker(e.target, e); }}
            />
          `}
        ${showOverlay && html`
          <div className=${"node-title node-title-preview" + (node.status === "DONE" || node.status === "CANCELLED" ? " done" : "")}
               style=${typoStyle}
               onClick=${(e) => {
                 if (e.target.closest(".status-badge")) { e.stopPropagation(); dispatch(node.id, "cycle-status"); return; }
                 if (e.target.closest(".priority-badge")) { e.stopPropagation(); dispatch(node.id, "set-priority", node.priority === "A" ? "B" : node.priority === "B" ? "C" : "A"); return; }
                 const tagEl = e.target.closest("[data-tag]");
                 if (tagEl) { e.stopPropagation(); onSearchTag?.(tagEl.dataset.tag); return; }
                 if (e.target.closest(".node-has-notes-indicator")) { dispatch(node.id, "preview-body"); return; }
                 setIsEditing(true);
                 setTimeout(() => titleRef.current?.focus(), 0);
               }}
               dangerouslySetInnerHTML=${{
                 __html: tree.renderOrgInline(node.title) +
                   (hasHiddenNote ? ' <span class="node-has-notes-indicator" title="This item has a hidden note — click to view it">…</span>' : "") +
                   (showTagChips && !tagsOnRight ? (
                     (node.status ? ` <span class="status-badge status-${node.status.toLowerCase()}">${node.status}</span>` : "") +
                     (node.priority ? ` <span class="priority-badge priority-${node.priority}">${node.priority}</span>` : "") +
                     (node.tags?.length > 0 ? ' <span class="node-tag-chips-inline">' + inlineTagChipsHtml(node.tags) + "</span>" : "")
                   ) : ""),
               }} />
        `}
        ${!showFormatted && !showOverlay && hasHiddenNote && html`
          <span className="node-has-notes-indicator"
                onClick=${() => dispatch(node.id, "preview-body")}
                title="This item has a hidden note — click to view it">…</span>
        `}
        ${showTagChips && (tagsOnRight || (!showFormatted && !showOverlay)) && (node.status ? html`
          <span className=${"status-badge status-" + node.status.toLowerCase()}
                onClick=${(e) => { e.stopPropagation(); dispatch(node.id, "cycle-status"); }}
                title="Click to change status">${node.status}</span>
        ` : html`
          <span className="status-badge status-none"
                onClick=${(e) => { e.stopPropagation(); dispatch(node.id, "cycle-status"); }}
                title="Click to set status"></span>
        `)}
        ${showTagChips && (tagsOnRight || (!showFormatted && !showOverlay)) && node.priority && html`
          <span className=${"priority-badge priority-" + node.priority}
                onClick=${(e) => { e.stopPropagation(); dispatch(node.id, "set-priority", node.priority === "A" ? "B" : node.priority === "B" ? "C" : "A"); }}
                title="Click to cycle priority">${node.priority}</span>
        `}
        ${showTagChips && node.tags?.length > 0 && (tagsOnRight || (!showFormatted && !showOverlay)) && html`
          <span className="node-tag-chips">
            ${node.tags.map((t) => html`<span key=${t} className="node-tag-chip"
              onClick=${(e) => { e.stopPropagation(); onSearchTag?.(t); }}>${t}</span>`)}
          </span>
        `}
      </div>
      <${NodeBody}
        node=${node}
        dispatch=${dispatch}
        isEditing=${bodyEditing}
        isPreview=${bodyPreview}
        titleFormatMode=${titleFormatMode}
        notesVisible=${notesVisible}
        depth=${depth}
        bodyRefs=${bodyRefs}
      />
      ${hasChildren && !node.collapsed && node.children.map(
        (child, i) => html`
          <${OutlineNode}
            key=${child.id}
            node=${child}
            focusedId=${focusedId}
            dispatch=${dispatch}
            inputRefs=${inputRefs}
            depth=${depth + 1}
            titleFormatMode=${titleFormatMode}
            notesVisible=${notesVisible}
            outlineFormat=${outlineFormat}
            levelFormats=${levelFormats}
            siblingIndex=${i + 1}
            verticalLines=${verticalLines}
            showTagChips=${showTagChips}
            tagsOnRight=${tagsOnRight}
            onSearchTag=${onSearchTag}
            bodyEditingId=${bodyEditingId}
            bodyPreviewId=${bodyPreviewId}
            bodyRefs=${bodyRefs}
            onNodeHandleMouseDown=${onNodeHandleMouseDown}
            onNodeHandleMenu=${onNodeHandleMenu}
            nodeMenuOpenId=${nodeMenuOpenId}
            globalFont=${globalFont}
            levelFonts=${levelFonts}
            globalColor=${globalColor}
            levelColors=${levelColors}
          />
        `
      )}
    </div>
  `;
}

function PropertiesEditor({ nodeId, properties, dispatch }) {
  const entries = Object.entries(properties || {});
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  return html`
    <div className="props-editor">
      ${entries.map(([k, v]) => html`
        <div className="prop-row" key=${k}>
          <span className="prop-key">${k}</span>
          <input className="prop-value" value=${v}
            onChange=${(e) => {
              dispatch(nodeId, "update-properties", { ...properties, [k]: e.target.value });
            }} />
          <button className="prop-delete"
                  onClick=${() => {
                    const updated = { ...properties };
                    delete updated[k];
                    dispatch(nodeId, "update-properties", updated);
                  }}>\u00D7</button>
        </div>
      `)}
      <div className="prop-row prop-add">
        <input className="prop-key-input" placeholder="key"
               value=${newKey} onChange=${(e) => setNewKey(e.target.value)} />
        <input className="prop-value" placeholder="value"
               value=${newVal} onChange=${(e) => setNewVal(e.target.value)} />
        <button className="prop-add-btn"
                onClick=${() => {
                  if (newKey.trim()) {
                    dispatch(nodeId, "update-properties", { ...properties, [newKey.trim()]: newVal });
                    setNewKey(""); setNewVal("");
                  }
                }}>+</button>
      </div>
    </div>
  `;
}

function flattenTagNames(tags, out = []) {
  for (const t of tags) {
    if (t.name) out.push(t.name);
    if (t.children?.length) flattenTagNames(t.children, out);
  }
  return out;
}

function TagPickerModal({ currentTags, globalTags, onAdd, onClose }) {
  const [filter, setFilter] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const allKnown = useMemo(() => flattenTagNames(globalTags || []), [globalTags]);
  const suggestions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const known = allKnown.filter((t) => !currentTags.includes(t) && (!q || t.toLowerCase().includes(q)));
    // If typed text isn't already in the list, show it as a "new tag" option at top
    const trimmed = filter.trim();
    if (trimmed && !currentTags.includes(trimmed) && !known.includes(trimmed)) {
      return [{ name: trimmed, isNew: true }, ...known.map((n) => ({ name: n, isNew: false }))];
    }
    return known.map((n) => ({ name: n, isNew: false }));
  }, [filter, allKnown, currentTags]);

  useEffect(() => { setHighlighted(0); }, [filter]);

  useEffect(() => {
    const el = listRef.current?.children[highlighted];
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const select = (item) => { onAdd(item.name); setFilter(""); setHighlighted(0); };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (suggestions[highlighted]) select(suggestions[highlighted]); }
  };

  return html`
    <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tag-picker-modal">
        <div className="text-search-header">
          <span className="text-search-title">Add Tag</span>
          <button className="folder-picker-close" onClick=${onClose}>×</button>
        </div>
        <div className="tag-picker-body">
          <input ref=${inputRef} className="text-search-input" type="text"
                 placeholder="Type to filter or add new tag…"
                 value=${filter} onInput=${(e) => setFilter(e.target.value)}
                 onKeyDown=${onKeyDown} />
          <div ref=${listRef} className="tag-picker-list">
            ${suggestions.length === 0 && html`
              <div className="tag-picker-empty">No tags in TagList.org yet</div>
            `}
            ${suggestions.map((item, i) => html`
              <div key=${item.name}
                   className=${"tag-picker-item" + (i === highlighted ? " highlighted" : "") + (item.isNew ? " is-new" : "")}
                   onMouseDown=${(e) => { e.preventDefault(); select(item); }}>
                ${item.isNew ? html`<span className="tag-picker-new-label">New:</span> ` : ""}${item.name}
              </div>
            `)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function TagsEditor({ nodeId, tags, dispatch, globalTags }) {
  const [showPicker, setShowPicker] = useState(false);
  const list = tags || [];

  const addTag = (t) => {
    if (t && !list.includes(t)) dispatch(nodeId, "update-tags", [...list, t]);
  };

  return html`
    <div className="tags-editor">
      ${list.map((tag, i) => html`
        <span className="tag-chip" key=${tag + i}>
          ${tag}
          <button className="tag-delete"
                  onClick=${() => dispatch(nodeId, "update-tags", list.filter((_, idx) => idx !== i))}>×</button>
        </span>
      `)}
      <button className="tags-add-btn" onClick=${() => setShowPicker(true)}>+ add tag</button>
      ${showPicker && html`
        <${TagPickerModal}
          currentTags=${list}
          globalTags=${globalTags}
          onAdd=${(t) => addTag(t)}
          onClose=${() => setShowPicker(false)} />
      `}
    </div>
  `;
}

function NodeTagsPane({ node, dispatch, onAddToGlobalTags }) {
  const [input, setInput] = useState("");
  const tags = node?.tags || [];

  const commit = () => {
    const t = input.trim();
    setInput("");
    if (!t || tags.includes(t)) return;
    dispatch(node.id, "update-tags", [...tags, t]);
    onAddToGlobalTags(t);
  };

  return html`
    <div className="node-tags-pane">
      <div className="node-tags-pane-header">ITEM TAG</div>
      <div className="node-tags-pills">
        ${node ? tags.map((tag) => html`
          <span className="node-tag-pill" key=${tag}>
            <span className="node-tag-pill-name">${tag}</span>
            <button className="node-tag-pill-remove"
                    onClick=${() => dispatch(node.id, "update-tags", tags.filter(t => t !== tag))}
                    title="Remove tag">×</button>
          </span>
        `) : null}
        ${node && tags.length === 0 && html`<span className="node-tags-empty">No tags</span>`}
        ${!node && html`<span className="node-tags-empty">Select a node</span>`}
      </div>
      ${node && html`
        <input className="node-tags-add-input"
               placeholder="add tag…"
               value=${input}
               onChange=${(e) => setInput(e.target.value)}
               onKeyDown=${(e) => {
                 if (e.key === "Enter") { e.preventDefault(); commit(); }
                 if (e.key === "Escape") setInput("");
               }}
               onBlur=${commit} />
      `}
    </div>
  `;
}

function ItemBookmarkPane({ node, dispatch, onAddToGlobalBMs }) {
  const [input, setInput] = useState("");
  const bms = (node?.properties?.BOOKMARKS || "").split(" ").filter(Boolean);

  const commit = () => {
    const t = input.trim();
    setInput("");
    if (!t || bms.includes(t)) return;
    dispatch(node.id, "update-bookmarks", [...bms, t]);
    onAddToGlobalBMs(t);
  };

  return html`
    <div className="item-bookmark-pane">
      <div className="item-bookmark-pane-header">ITEM BOOKMARK</div>
      <div className="node-tags-pills">
        ${node ? bms.map((bm) => html`
          <span className="node-tag-pill" key=${bm}>
            <span className="node-tag-pill-name">${bm}</span>
            <button className="node-tag-pill-remove"
                    onClick=${() => dispatch(node.id, "update-bookmarks", bms.filter(b => b !== bm))}
                    title="Remove bookmark">×</button>
          </span>
        `) : null}
        ${node && bms.length === 0 && html`<span className="node-tags-empty">No bookmarks</span>`}
        ${!node && html`<span className="node-tags-empty">Select a node</span>`}
      </div>
      ${node && html`
        <input className="node-tags-add-input"
               placeholder="add bookmark…"
               value=${input}
               onChange=${(e) => setInput(e.target.value)}
               onKeyDown=${(e) => {
                 if (e.key === "Enter") { e.preventDefault(); commit(); }
                 if (e.key === "Escape") setInput("");
               }}
               onBlur=${commit} />
      `}
    </div>
  `;
}

// Returns true if tagName exists anywhere in the nested tag tree.
function tagExistsInTree(tags, name) {
  for (const t of (tags || [])) {
    if (t.name === name) return true;
    if (t.children?.length > 0 && tagExistsInTree(t.children, name)) return true;
  }
  return false;
}

// Remove a tag by name from anywhere in the tree. Returns [updatedTree, removedTag|null].
function removeTagFromTree(tags, name) {
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].name === name) {
      return [[...tags.slice(0, i), ...tags.slice(i + 1)], tags[i]];
    }
    const [newChildren, found] = removeTagFromTree(tags[i].children || [], name);
    if (found) {
      const next = [...tags];
      next[i] = { ...tags[i], children: newChildren };
      return [next, found];
    }
  }
  return [tags, null];
}

// Add a tag as the last child of the tag named parentName, anywhere in the tree.
function addTagAsChild(tags, parentName, child) {
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].name === parentName) {
      const next = [...tags];
      next[i] = { ...tags[i], collapsed: false, children: [...(tags[i].children || []), child] };
      return next;
    }
    if ((tags[i].children || []).length > 0) {
      const newChildren = addTagAsChild(tags[i].children, parentName, child);
      if (newChildren !== tags[i].children) {
        const next = [...tags];
        next[i] = { ...tags[i], children: newChildren };
        return next;
      }
    }
  }
  return tags;
}

// Module-level drag state — synchronous, shared across all recursive TagList instances.
// React setState is async so we can't rely on it inside onDrop handlers.
let gDragTagName = null;    // name of the tag being dragged
let gNestTarget = null;     // name of the tag to nest under (right-zone hover)
let gLineIdx = null;        // drop-line index for reorder (left-zone hover)

// Parallel module-level drag state for the bookmark list.
let gDragBMName = null;
let gNestBMTarget = null;
let gBMLineIdx = null;

// Recursive sibling list — each instance owns its own render state (line/nest indicators)
// but shares the module-level drag vars for reliable drop logic.
function TagList({ tags, onUpdate, depth, selectedTags, onToggleTag, onAddTagToItem, onNestTag, onSearch, onRenameTag }) {
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dropLineIdx, setDropLineIdx] = useState(null);  // line shown between items
  const [nestOverIdx, setNestOverIdx] = useState(null);  // box shown on nest target
  const [addingChildFor, setAddingChildFor] = useState(null);
  const [newChildName, setNewChildName] = useState("");
  const [renamingIdx, setRenamingIdx] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const clearDrag = () => {
    setDraggingIdx(null); setDropLineIdx(null); setNestOverIdx(null);
  };

  // Clear stuck visual indicators whenever any drag ends anywhere on the page.
  useEffect(() => {
    const onDragEnd = () => { setDropLineIdx(null); setNestOverIdx(null); setDraggingIdx(null); };
    document.addEventListener("dragend", onDragEnd);
    return () => document.removeEventListener("dragend", onDragEnd);
  }, []);

  // Insert item at fromIdx into the gap at lineIdx (0 = before first item).
  const insertAtLine = (fromIdx, lineIdx) => {
    if (fromIdx === null || lineIdx === null) return;
    if (lineIdx === fromIdx || lineIdx === fromIdx + 1) return; // no-op
    const next = [...tags];
    const [item] = next.splice(fromIdx, 1);
    const insertAt = lineIdx > fromIdx ? lineIdx - 1 : lineIdx;
    next.splice(insertAt, 0, item);
    onUpdate(next);
  };

  const n = (tags || []).length;

  return html`
    ${(tags || []).map((tag, i) => {
      const hasChildren = (tag.children || []).length > 0;
      const isActive = selectedTags.includes(tag.name);
      const isNestOver = nestOverIdx === i;

      const commitChild = () => {
        const name = newChildName.trim();
        setAddingChildFor(null); setNewChildName("");
        if (!name) return;
        const children = tag.children || [];
        if (children.some(c => c.name === name)) return;
        const next = [...tags];
        next[i] = { ...tag, collapsed: false, children: [...children, { name, children: [], collapsed: false }] };
        onUpdate(next);
      };

      const toggleCollapsed = () => {
        const next = [...tags];
        next[i] = { ...tag, collapsed: !tag.collapsed };
        onUpdate(next);
      };

      return html`
        <div key=${tag.name + "-" + depth + "-" + i} className="tag-list-node">
          ${dropLineIdx === i && html`<div className="tag-drop-line"></div>`}
          <div className=${"tag-panel-item" + (isActive ? " active" : "") + (isNestOver ? " nest-over" : "")}
               style=${{paddingLeft: (4 + depth * 14) + "px"}}
               draggable="true"
               onDragStart=${(e) => {
                 e.dataTransfer.effectAllowed = "move";
                 setDraggingIdx(i);
                 gDragTagName = tag.name;
                 gNestTarget = null;
                 gLineIdx = null;
               }}
               onDragOver=${(e) => {
                 e.preventDefault();
                 const rect = e.currentTarget.getBoundingClientRect();
                 const relX = (e.clientX - rect.left) / rect.width;
                 const relY = (e.clientY - rect.top) / rect.height;
                 if (gDragTagName && gDragTagName !== tag.name && relX > 0.65) {
                   // Right zone → nest under this tag
                   gNestTarget = tag.name;
                   gLineIdx = null;
                   setNestOverIdx(i);
                   setDropLineIdx(null);
                 } else {
                   // Left zone → reorder; line above/below based on cursor Y
                   gNestTarget = null;
                   const lineIdx = relY < 0.5 ? i : i + 1;
                   gLineIdx = lineIdx;
                   setNestOverIdx(null);
                   setDropLineIdx(lineIdx);
                 }
               }}
               onDrop=${(e) => {
                 e.preventDefault();
                 if (gNestTarget && gDragTagName && gNestTarget !== gDragTagName) {
                   onNestTag(gDragTagName, gNestTarget);
                 } else if (draggingIdx !== null && gLineIdx !== null) {
                   insertAtLine(draggingIdx, gLineIdx);
                 }
                 clearDrag();
                 gDragTagName = null; gNestTarget = null; gLineIdx = null;
               }}
               onDragEnd=${() => {
                 clearDrag();
                 gDragTagName = null; gNestTarget = null; gLineIdx = null;
               }}>
            <button className=${"tag-collapse-btn" + (hasChildren ? "" : " tag-collapse-spacer")}
                    onClick=${(e) => { e.stopPropagation(); if (hasChildren) toggleCollapsed(); }}>
              ${hasChildren ? (tag.collapsed ? "▶" : "▼") : ""}
            </button>
            <button className="tag-add-to-item-btn" title="Add this tag to the focused item"
                    onClick=${(e) => { e.stopPropagation(); onAddTagToItem(tag.name); }}>+</button>
            <button className="tag-search-btn" title=${"Search all files for :" + tag.name + ":"}
                    onClick=${(e) => { e.stopPropagation(); onSearch(tag.name); }}><${IconSearch} /></button>
            <span className="tag-panel-drag-icon">⠿</span>
            <span className="tag-panel-name" onClick=${() => onToggleTag(tag.name)}>${tag.name}</span>
            <button className="tag-add-child-btn" title="Add sub-tag"
                    onClick=${(e) => { e.stopPropagation(); setAddingChildFor(i); setNewChildName(""); }}>↳</button>
            <button className="tag-rename-btn" title="Rename this tag"
                    onClick=${(e) => { e.stopPropagation(); setRenamingIdx(i); setRenameValue(tag.name); }}>✎</button>
            <button className="tag-panel-remove" title="Remove from list"
                    onClick=${(e) => { e.stopPropagation(); onUpdate(tags.filter((_, j) => j !== i)); }}>×</button>
          </div>
          ${renamingIdx === i && html`
            <div className="tag-add-child-row" style=${{paddingLeft: (4 + depth * 14) + "px"}}>
              <input className="tag-add-child-input"
                     autoFocus
                     value=${renameValue}
                     onChange=${(e) => setRenameValue(e.target.value)}
                     onKeyDown=${(e) => {
                       if (e.key === "Enter") {
                         e.preventDefault();
                         const newName = renameValue.trim();
                         const oldName = tag.name;
                         setRenamingIdx(null); setRenameValue("");
                         if (newName && newName !== oldName) onRenameTag?.(oldName, newName);
                       }
                       if (e.key === "Escape") { setRenamingIdx(null); setRenameValue(""); }
                     }}
                     onBlur=${() => { setRenamingIdx(null); setRenameValue(""); }} />
            </div>
          `}
          ${addingChildFor === i && html`
            <div className="tag-add-child-row" style=${{paddingLeft: (4 + (depth + 1) * 14) + "px"}}>
              <input className="tag-add-child-input"
                     autoFocus
                     placeholder="sub-tag name…"
                     value=${newChildName}
                     onChange=${(e) => setNewChildName(e.target.value)}
                     onKeyDown=${(e) => {
                       if (e.key === "Enter") { e.preventDefault(); commitChild(); }
                       if (e.key === "Escape") { setAddingChildFor(null); setNewChildName(""); }
                     }}
                     onBlur=${commitChild} />
            </div>
          `}
          ${!tag.collapsed && hasChildren && html`
            <${TagList}
              tags=${tag.children}
              onUpdate=${(newChildren) => {
                const next = [...tags];
                next[i] = { ...tag, children: newChildren };
                onUpdate(next);
              }}
              depth=${depth + 1}
              selectedTags=${selectedTags}
              onToggleTag=${onToggleTag}
              onAddTagToItem=${onAddTagToItem}
              onNestTag=${onNestTag}
              onSearch=${onSearch}
              onRenameTag=${onRenameTag} />
          `}
        </div>
      `;
    })}
    ${dropLineIdx === n && html`<div className="tag-drop-line" style=${{marginLeft: (4 + depth * 14) + "px"}}></div>`}
  `;
}

function TagPanel({ globalTags, onUpdateTags, onNestTag, onAddTagToItem, selectedTags, onToggleTag, onClearTags, onEditTagFile, onPickTagListFile, tagListFile, width, onWidthChange, onSearch, onReloadTags, focusedNode, dispatch, onAddToGlobalTags }) {
  const tagListLabel = tagListFile ? pathBasename(tagListFile) : "TagList.org";
  const [renameConfirm, setRenameConfirm] = useState(null); // { oldName, newName }
  const [renaming, setRenaming] = useState(false);
  const [renameResult, setRenameResult] = useState(null); // { filesChanged, replacements } after success

  const handleRenameTag = (oldName, newName) => setRenameConfirm({ oldName, newName });

  const confirmRenameEverywhere = async () => {
    if (!renameConfirm || renaming) return;
    setRenaming(true);
    try {
      const result = await api.post("/api/rename-tag", { oldName: renameConfirm.oldName, newName: renameConfirm.newName });
      setRenameResult(result);
      setRenameConfirm(null);
      onReloadTags?.();
    } catch (e) {
      setRenaming(false);
    }
    setRenaming(false);
  };

  const onGripperMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev) => {
      const dx = startX - ev.clientX;
      onWidthChange(Math.max(160, Math.min(420, startWidth + dx)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return html`
    <div className="tag-panel" style=${{width: width + "px"}}>
      <div className="tag-panel-gripper" onMouseDown=${onGripperMouseDown}>
        <span className="detail-gripper-icon" aria-hidden="true"></span>
      </div>
      <div className="tag-panel-content">
        <${NodeTagsPane} node=${focusedNode} dispatch=${dispatch} onAddToGlobalTags=${onAddToGlobalTags} />
        <div className="tag-panel-header">
          <span>TAG LIST</span>
          ${selectedTags.length > 0 && html`
            <button className="tag-panel-clear" onClick=${onClearTags}>Clear</button>
          `}
        </div>
        <div className="tag-panel-list">
          <${TagList}
            tags=${globalTags}
            onUpdate=${onUpdateTags}
            onNestTag=${onNestTag}
            onAddTagToItem=${onAddTagToItem}
            depth=${0}
            selectedTags=${selectedTags}
            onToggleTag=${onToggleTag}
            onSearch=${onSearch}
            onRenameTag=${handleRenameTag} />
          ${globalTags.length === 0 && html`
            <div className="tag-panel-empty">No tags yet.<br/>Open org files with tags to populate this list.</div>
          `}
        </div>
        ${renameResult && html`
          <div className="tag-rename-result" onClick=${() => setRenameResult(null)}>
            Renamed in ${renameResult.filesChanged} file${renameResult.filesChanged !== 1 ? "s" : ""}
            (${renameResult.replacements} occurrence${renameResult.replacements !== 1 ? "s" : ""}) ×
          </div>
        `}
        <div className="tag-panel-footer">
          <button className="tag-edit-file-btn" onClick=${onEditTagFile}>Edit ${tagListLabel}</button>
          <button className="tag-edit-file-btn" onClick=${onPickTagListFile} title="Switch to a different tag list file">Change</button>
        </div>
      </div>
      ${renameConfirm && html`
        <div className="rename-tag-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setRenameConfirm(null); }}>
          <div className="rename-tag-dialog">
            <div className="rename-tag-title">Rename Tag</div>
            <div className="rename-tag-msg">
              Rename <strong>:${renameConfirm.oldName}:</strong> to <strong>:${renameConfirm.newName}:</strong>
              in all org files in home folder?
            </div>
            <div className="rename-tag-actions">
              <button className="rename-tag-btn-confirm" onClick=${confirmRenameEverywhere} disabled=${renaming}>
                ${renaming ? "Renaming…" : "Rename Everywhere"}
              </button>
              <button className="rename-tag-btn-cancel" onClick=${() => setRenameConfirm(null)} disabled=${renaming}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

// Recursive bookmark list — same drag/nest/reorder logic as TagList but uses
// separate module-level vars (gDragBMName, gNestBMTarget, gBMLineIdx).
function BookmarkList({ bms, onUpdate, depth, onAddBMToItem, onNestBM }) {
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dropLineIdx, setDropLineIdx] = useState(null);
  const [nestOverIdx, setNestOverIdx] = useState(null);
  const [addingChildFor, setAddingChildFor] = useState(null);
  const [newChildName, setNewChildName] = useState("");

  const clearDrag = () => { setDraggingIdx(null); setDropLineIdx(null); setNestOverIdx(null); };

  useEffect(() => {
    const onDragEnd = () => { setDropLineIdx(null); setNestOverIdx(null); setDraggingIdx(null); };
    document.addEventListener("dragend", onDragEnd);
    return () => document.removeEventListener("dragend", onDragEnd);
  }, []);

  const insertAtLine = (fromIdx, lineIdx) => {
    if (fromIdx === null || lineIdx === null) return;
    if (lineIdx === fromIdx || lineIdx === fromIdx + 1) return;
    const next = [...bms];
    const [item] = next.splice(fromIdx, 1);
    const insertAt = lineIdx > fromIdx ? lineIdx - 1 : lineIdx;
    next.splice(insertAt, 0, item);
    onUpdate(next);
  };

  const n = (bms || []).length;

  return html`
    ${(bms || []).map((bm, i) => {
      const hasChildren = (bm.children || []).length > 0;
      const isNestOver = nestOverIdx === i;

      const commitChild = () => {
        const name = newChildName.trim();
        setAddingChildFor(null); setNewChildName("");
        if (!name) return;
        const children = bm.children || [];
        if (children.some(c => c.name === name)) return;
        const next = [...bms];
        next[i] = { ...bm, collapsed: false, children: [...children, { name, children: [], collapsed: false }] };
        onUpdate(next);
      };

      const toggleCollapsed = () => {
        const next = [...bms];
        next[i] = { ...bm, collapsed: !bm.collapsed };
        onUpdate(next);
      };

      return html`
        <div key=${bm.name + "-" + depth + "-" + i} className="tag-list-node">
          ${dropLineIdx === i && html`<div className="tag-drop-line"></div>`}
          <div className=${"tag-panel-item" + (isNestOver ? " nest-over" : "")}
               style=${{paddingLeft: (4 + depth * 14) + "px"}}
               draggable="true"
               onDragStart=${(e) => {
                 e.dataTransfer.effectAllowed = "move";
                 setDraggingIdx(i);
                 gDragBMName = bm.name;
                 gNestBMTarget = null;
                 gBMLineIdx = null;
               }}
               onDragOver=${(e) => {
                 e.preventDefault();
                 const rect = e.currentTarget.getBoundingClientRect();
                 const relX = (e.clientX - rect.left) / rect.width;
                 const relY = (e.clientY - rect.top) / rect.height;
                 if (gDragBMName && gDragBMName !== bm.name && relX > 0.65) {
                   gNestBMTarget = bm.name;
                   gBMLineIdx = null;
                   setNestOverIdx(i);
                   setDropLineIdx(null);
                 } else {
                   gNestBMTarget = null;
                   const lineIdx = relY < 0.5 ? i : i + 1;
                   gBMLineIdx = lineIdx;
                   setNestOverIdx(null);
                   setDropLineIdx(lineIdx);
                 }
               }}
               onDrop=${(e) => {
                 e.preventDefault();
                 if (gNestBMTarget && gDragBMName && gNestBMTarget !== gDragBMName) {
                   onNestBM(gDragBMName, gNestBMTarget);
                 } else if (draggingIdx !== null && gBMLineIdx !== null) {
                   insertAtLine(draggingIdx, gBMLineIdx);
                 }
                 clearDrag();
                 gDragBMName = null; gNestBMTarget = null; gBMLineIdx = null;
               }}
               onDragEnd=${() => {
                 clearDrag();
                 gDragBMName = null; gNestBMTarget = null; gBMLineIdx = null;
               }}>
            <button className=${"tag-collapse-btn" + (hasChildren ? "" : " tag-collapse-spacer")}
                    onClick=${(e) => { e.stopPropagation(); if (hasChildren) toggleCollapsed(); }}>
              ${hasChildren ? (bm.collapsed ? "▶" : "▼") : ""}
            </button>
            <span className="tag-panel-drag-icon">⠿</span>
            <span className="tag-panel-name">${bm.name}</span>
            <button className="tag-add-to-item-btn" title="Add this bookmark to the focused item"
                    onClick=${(e) => { e.stopPropagation(); onAddBMToItem(bm.name); }}>+</button>
            <button className="tag-add-child-btn" title="Add sub-bookmark"
                    onClick=${(e) => { e.stopPropagation(); setAddingChildFor(i); setNewChildName(""); }}>↳</button>
            <button className="tag-panel-remove" title="Remove from list"
                    onClick=${(e) => { e.stopPropagation(); onUpdate(bms.filter((_, j) => j !== i)); }}>×</button>
          </div>
          ${addingChildFor === i && html`
            <div className="tag-add-child-row" style=${{paddingLeft: (4 + (depth + 1) * 14) + "px"}}>
              <input className="tag-add-child-input"
                     autoFocus
                     placeholder="sub-bookmark name…"
                     value=${newChildName}
                     onChange=${(e) => setNewChildName(e.target.value)}
                     onKeyDown=${(e) => {
                       if (e.key === "Enter") { e.preventDefault(); commitChild(); }
                       if (e.key === "Escape") { setAddingChildFor(null); setNewChildName(""); }
                     }}
                     onBlur=${commitChild} />
            </div>
          `}
          ${!bm.collapsed && hasChildren && html`
            <${BookmarkList}
              bms=${bm.children}
              onUpdate=${(newChildren) => {
                const next = [...bms];
                next[i] = { ...bm, children: newChildren };
                onUpdate(next);
              }}
              depth=${depth + 1}
              onAddBMToItem=${onAddBMToItem}
              onNestBM=${onNestBM} />
          `}
        </div>
      `;
    })}
    ${dropLineIdx === n && html`<div className="tag-drop-line" style=${{marginLeft: (4 + depth * 14) + "px"}}></div>`}
  `;
}

function BookmarkPanel({ globalBMs, onUpdateBMs, onNestBM, onAddBMToItem, onEditBookmarkFile, onPickBookmarkListFile, bookmarkListFile, width, onWidthChange, focusedNode, dispatch, onAddToGlobalBMs }) {
  const onGripperMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;  // drag right = wider (opposite of TagPanel)
      onWidthChange(Math.max(160, Math.min(420, startWidth + dx)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return html`
    <div className="bookmark-panel" style=${{width: width + "px"}}>
      <div className="bookmark-panel-content">
        <${ItemBookmarkPane} node=${focusedNode} dispatch=${dispatch} onAddToGlobalBMs=${onAddToGlobalBMs} />
        <div className="tag-panel-header">
          <span>BOOKMARK LIST</span>
        </div>
        <div className="tag-panel-list">
          <${BookmarkList}
            bms=${globalBMs}
            onUpdate=${onUpdateBMs}
            onNestBM=${onNestBM}
            onAddBMToItem=${onAddBMToItem}
            depth=${0} />
          ${globalBMs.length === 0 && html`
            <div className="tag-panel-empty">No bookmarks yet.<br/>Use "add bookmark…" in the item pane.</div>
          `}
        </div>
        <div className="tag-panel-footer">
          <button className="tag-edit-file-btn" onClick=${onEditBookmarkFile}>Edit ${bookmarkListFile ? pathBasename(bookmarkListFile) : "Bookmarks.org"}</button>
          <button className="tag-edit-file-btn" onClick=${onPickBookmarkListFile} title="Switch to a different bookmark list file">Change</button>
        </div>
      </div>
      <div className="bookmark-panel-gripper" onMouseDown=${onGripperMouseDown}>
        <span className="detail-gripper-icon" aria-hidden="true"></span>
      </div>
    </div>
  `;
}

const DETAIL_MIN_WIDTH = 220;
const DETAIL_MAX_WIDTH_RATIO = 0.70;
// Fully collapsed when closed — the header's own Details button already
// handles reopening it, so no need to reserve a sliver for a gripper too.
const DETAIL_CLOSED_WIDTH = 0;

const REPEATER_OPTIONS = [
  { label: "None",    value: "" },
  { label: "Daily",   value: "+1d" },
  { label: "Weekly",  value: "+1w" },
  { label: "Bi-wk",  value: "+2w" },
  { label: "Monthly", value: "+1m" },
  { label: "Yearly",  value: "+1y" },
];

const DetailPane = forwardRef(function DetailPane({ node, isPreamble, dispatch, inputRefs, width, visible, onWidthChange, onOpen, onClose, titleFormatMode, globalTags, tagPanelVisible, onToggleTagPanel, textMode, selectedTags }, ref) {
  // Only preamble's content still lives here — it has no bulleted row of
  // its own to display notes inline under. Every regular node's body now
  // shows inline in the outline, so the pane is properties-only for those.
  const [bodyText, setBodyText] = useState(node?.body || "");
  const [editing, setEditing] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const localRef = useRef(null);
  const titleRef = useRef(null);

  // DetailPane stays mounted while the preamble stays focused (it's keyed
  // by focus target, not content), so the Title field's edits — which land
  // here as a freshly-built preamble string — need to flow back into the
  // Content field's local mirror too.
  useEffect(() => {
    setBodyText(node?.body || "");
  }, [node?.body]);

  useImperativeHandle(ref, () => ({
    focusBody() {
      setEditing(true);
      requestAnimationFrame(() => { localRef.current?.focus(); });
    },
  }));

  useEffect(() => {
    const ta = localRef.current;
    if (ta && editing) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
  }, [bodyText, editing]);

  const onGripperMouseDown = useCallback((e) => {
    if (!visible) {
      e.preventDefault();
      onOpen();
      return;
    }
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const dx = startX - ev.clientX;
      const max = Math.round(window.innerWidth * DETAIL_MAX_WIDTH_RATIO);
      onWidthChange(Math.max(DETAIL_MIN_WIDTH, Math.min(max, startWidth + dx)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, visible, onWidthChange, onOpen]);

  const gripper = html`
    <div className="detail-gripper" onMouseDown=${onGripperMouseDown}
         role="separator" aria-orientation="vertical"
         aria-label=${visible ? "Resize details pane" : "Open details pane"}
         title=${visible ? "Drag to resize" : "Click to open details"}>
      <span className="detail-gripper-icon" aria-hidden="true"></span>
    </div>
  `;

  const header = isPreamble ? "Preamble" : (node?.title || (node ? "Untitled" : "No selection"));

  // Preamble-only from here on — its content has nowhere else to live.
  const startEditing = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => { localRef.current?.focus(); });
  }, []);

  const bodyField = editing
    ? html`
        <textarea
          ref=${(el) => { localRef.current = el; }}
          className="detail-body"
          value=${bodyText}
          placeholder="File header, #+TITLE, etc..."
          onChange=${(e) => { setBodyText(e.target.value); dispatch("preamble", "change-preamble", e.target.value); }}
          onBlur=${() => setEditing(false)}
          onKeyDown=${(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              dispatch("preamble", "focus-outline");
            }
          }}
        />
      `
    : html`
        <div className="detail-body detail-body-preview" onClick=${startEditing}>
          ${bodyText
            ? html`<span dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(bodyText) }} />`
            : html`<span className="detail-body-placeholder">File header, #+TITLE, etc...</span>`}
        </div>
      `;

  // The #+TITLE: line gets its own field — same formatted-preview/edit
  // pattern as a node title, since a title can carry the same *bold*,
  // /italic/, and [[link][label]] markup.
  const titleValue = tree.extractPreambleTitle(bodyText);
  const setTitleValue = (value) => {
    const updated = tree.setPreambleTitle(bodyText, value);
    setBodyText(updated);
    dispatch("preamble", "change-preamble", updated);
  };
  const startTitleEditing = useCallback(() => {
    setTitleEditing(true);
    requestAnimationFrame(() => { titleRef.current?.focus(); });
  }, []);
  const showTitleFormatted = titleFormatMode && !titleEditing && titleValue;

  const titleField = showTitleFormatted
    ? html`
        <div className="detail-title-field detail-title-preview"
             onClick=${startTitleEditing}
             dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(titleValue) }} />
      `
    : html`
        <input
          ref=${(el) => { titleRef.current = el; }}
          type="text"
          className="detail-title-field detail-title-input"
          value=${titleValue}
          placeholder="(none — stored as #+TITLE: in the file header)"
          onFocus=${() => setTitleEditing(true)}
          onChange=${(e) => setTitleValue(e.target.value)}
          onBlur=${() => setTitleEditing(false)}
          onKeyDown=${(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setTitleEditing(false);
              dispatch("preamble", "focus-outline");
            }
          }}
        />
      `;

  const scheduledRaw = node?.properties?.SCHEDULED || "";
  const schedDate = tree.parseOrgDate(scheduledRaw);
  const schedTime = tree.parseOrgScheduledTime(scheduledRaw);
  const schedRepeater = tree.parseOrgRepeater(scheduledRaw);

  const inner = html`
    <div className="detail-header">
      <span className="detail-title">${header}</span>
    </div>
    ${isPreamble && html`
      <div className="detail-section">
        <label className="detail-label">Title</label>
        ${titleField}
      </div>
      <div className="detail-section">
        <label className="detail-label">Content</label>
        ${bodyField}
      </div>
    `}
    ${!isPreamble && html`
      <div className="detail-section">
        <label className="detail-label">TODO Status</label>
        <div className="detail-status-group">
          ${tree.STATUS_CYCLE.map((s) => html`
            <button key=${s || "none"}
                    className=${"detail-status-btn" + (s ? " status-" + s.toLowerCase() : " status-none") + (node?.status === s ? " active" : "")}
                    disabled=${!node}
                    onClick=${() => dispatch(node.id, "set-status", s)}>${s || "NONE"}</button>
          `)}
        </div>
      </div>
      <div className="detail-section">
        <label className="detail-label">Priority</label>
        <div className="detail-priority-group">
          ${[["A","#c0392b"],["B","#d68910"],["C","#1a6e9e"]].map(([p, color]) => html`
            <button key=${p}
                    className=${"detail-priority-btn" + (node?.priority === p ? " active" : "")}
                    style=${node?.priority === p ? { background: color, color: "#fff", borderColor: color } : {}}
                    disabled=${!node}
                    onClick=${() => dispatch(node.id, "set-priority", node?.priority === p ? "" : p)}>
              ${p}
            </button>
          `)}
          <button className=${"detail-priority-btn priority-none-btn" + (!node?.priority ? " active" : "")}
                  disabled=${!node}
                  onClick=${() => dispatch(node.id, "set-priority", "")}>
            None
          </button>
        </div>
      </div>
      <div className="detail-section">
        <div className="detail-section-hdr">
          <label className="detail-label">Scheduling</label>
          <button className="detail-clear-sched-btn"
                  disabled=${!node || (!node.properties?.DEADLINE && !node.properties?.SCHEDULED)}
                  onClick=${() => {
                    const updated = { ...(node.properties || {}) };
                    delete updated.DEADLINE;
                    delete updated.SCHEDULED;
                    dispatch(node.id, "update-properties", updated);
                  }}>× Clear</button>
        </div>
        <div className="detail-scheduling-row">
          <span className="detail-sublabel">Scheduled</span>
          <div className="detail-scheduled-row">
            <input type="date" className="detail-date detail-scheduled-date"
              value=${schedDate}
              disabled=${!node}
              onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
              onChange=${(e) => {
                if (!node) return;
                const updated = { ...(node.properties || {}) };
                if (e.target.value) updated.SCHEDULED = tree.formatOrgScheduled(e.target.value, schedTime, schedRepeater);
                else delete updated.SCHEDULED;
                dispatch(node.id, "update-properties", updated);
              }} />
            <input type="time" className="detail-date detail-scheduled-time" step="900"
              value=${schedTime}
              disabled=${!node || !schedDate}
              onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
              onChange=${(e) => {
                if (!node) return;
                if (!schedDate) return;
                const updated = { ...(node.properties || {}) };
                updated.SCHEDULED = tree.formatOrgScheduled(schedDate, e.target.value, schedRepeater);
                dispatch(node.id, "update-properties", updated);
              }} />
          </div>
        </div>
        <div className="detail-scheduling-row">
          <span className="detail-sublabel">Deadline</span>
          <div className="detail-scheduled-row">
            <input type="date" className="detail-date detail-scheduled-date"
              value=${node ? tree.parseOrgDate(node.properties?.DEADLINE) : ""}
              disabled=${!node}
              onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
              onChange=${(e) => {
                if (!node) return;
                const updated = { ...(node.properties || {}) };
                if (e.target.value) updated.DEADLINE = tree.formatOrgDate(e.target.value);
                else delete updated.DEADLINE;
                dispatch(node.id, "update-properties", updated);
              }} />
            <button className="detail-clear-sched-btn"
                    disabled=${!node || !node.properties?.DEADLINE}
                    onClick=${() => {
                      const updated = { ...(node.properties || {}) };
                      delete updated.DEADLINE;
                      dispatch(node.id, "update-properties", updated);
                    }}>× Clear</button>
          </div>
        </div>
        <div className="detail-scheduling-row">
          <span className="detail-sublabel">Repeat</span>
          <div className="detail-repeater-row">
          ${REPEATER_OPTIONS.map(({label, value}) => html`
            <button key=${value || "none"}
                    className=${"detail-repeater-btn" + (schedRepeater === value ? " active" : "")}
                    disabled=${!node || !schedDate}
                    onClick=${() => {
                      const updated = { ...(node.properties || {}) };
                      updated.SCHEDULED = tree.formatOrgScheduled(schedDate, schedTime, value);
                      dispatch(node.id, "update-properties", updated);
                    }}>${label}</button>
          `)}
          </div>
        </div>
        <div className="detail-scheduling-row">
          <span className="detail-sublabel">Remind</span>
          <div className="detail-repeater-row">
          ${REMINDER_OPTIONS.map(({label, value}) => html`
            <button key=${value || "none"}
                    className=${"detail-repeater-btn" + ((node?.properties?.REMINDER || "") === value ? " active" : "")}
                    disabled=${!node || !schedDate}
                    onClick=${() => {
                      const updated = { ...(node.properties || {}) };
                      if (value) updated.REMINDER = value; else delete updated.REMINDER;
                      dispatch(node.id, "update-properties", updated);
                    }}>${label}</button>
          `)}
          </div>
        </div>
      </div>
      <div className="detail-section">
        <label className="detail-label">Tags</label>
        ${node
          ? html`<${TagsEditor} nodeId=${node.id} tags=${node.tags} dispatch=${dispatch} globalTags=${globalTags} />`
          : html`<div className="detail-empty">—</div>`}
      </div>
      <div className="detail-section">
        <label className="detail-label">Properties</label>
        ${node
          ? html`<${PropertiesEditor} nodeId=${node.id} properties=${node.properties} dispatch=${dispatch} />`
          : html`<div className="detail-empty">—</div>`}
      </div>
    `}
  `;

  const effectiveWidth = visible ? width : DETAIL_CLOSED_WIDTH;
  return html`
    <div className=${"detail-pane" + (visible ? "" : " closed")} style=${{ width: effectiveWidth + "px" }}>
      ${gripper}
      <div className="detail-content">
        ${visible && html`
          <div className="panel-icon-strip">
            <button className="panel-toggle-btn active" onClick=${onClose}
                    title="Close details pane"><${IconInfo} /></button>
            <button className=${"panel-toggle-btn" + (tagPanelVisible && !textMode ? " active" : "") + ((selectedTags && selectedTags.length > 0) ? " has-filter" : "")}
                    onClick=${onToggleTagPanel} disabled=${textMode}
                    title=${textMode ? "Not available in reveal codes mode" : "Tag panel"}>
              <${IconTag} />
              ${selectedTags && selectedTags.length > 0 && html`<span className="tag-filter-count">${selectedTags.length}</span>`}
            </button>
          </div>
        `}
        ${inner}
      </div>
    </div>
  `;
});

const TODO_SORT_OPTIONS = [
  { key: "priority", label: "Priority" },
  { key: "status",   label: "Status"   },
  { key: "title",    label: "Title"    },
];

const TODO_STATUS_FILTERS = ["TODO", "NEXT", "URGENT", "WAITING"];

function TodoView({ nodes, currentFile, onSelect, searchQuery, selectedTags }) {
  const [sortBy, setSortBy] = useState("priority");
  const [statusFilter, setStatusFilter] = useState(new Set());
  const [priorityFilter, setPriorityFilter] = useState(new Set());
  const [allFiles, setAllFiles] = useState(false);
  const [allFileItems, setAllFileItems] = useState(null); // null=not fetched, []+=fetched
  const [allFilesLoading, setAllFilesLoading] = useState(false);

  const toggleStatus = (s) => setStatusFilter((prev) => {
    const next = new Set(prev); next.has(s) ? next.delete(s) : next.add(s); return next;
  });
  const togglePriority = (p) => setPriorityFilter((prev) => {
    const next = new Set(prev); next.has(p) ? next.delete(p) : next.add(p); return next;
  });
  const clearAll = () => { setStatusFilter(new Set()); setPriorityFilter(new Set()); };

  const toggleAllFiles = () => {
    const next = !allFiles;
    setAllFiles(next);
    if (next && allFileItems === null) {
      setAllFilesLoading(true);
      api.get("/api/todos")
        .then((d) => setAllFileItems(d.items || []))
        .catch(() => setAllFileItems([]))
        .finally(() => setAllFilesLoading(false));
    }
  };

  const localItems = collectTodoItems(nodes);

  let items;
  if (!allFiles) {
    items = localItems;
  } else {
    // Merge: local items from current file + external items from other files.
    const externalItems = (allFileItems || [])
      .filter((it) => it.file !== currentFile)
      .map((it) => ({
        id: null,
        title: it.nodeTitle,
        status: it.status,
        priority: it.priority || "",
        tags: it.tags || [],
        ancestors: it.ancestors || [],
        file: it.file,
      }));
    items = [...localItems, ...externalItems];
  }

  if (searchQuery) {
    const pq = tree.parseSearchQuery(searchQuery);
    items = items.filter((item) => tree.nodeMatchesQuery(pq, item));
  }
  if (selectedTags && selectedTags.length > 0) {
    items = items.filter((item) => item.tags.some((t) => selectedTags.includes(t)));
  }
  if (statusFilter.size > 0) {
    items = items.filter((item) => statusFilter.has(item.status));
  }
  if (priorityFilter.size > 0) {
    items = items.filter((item) => priorityFilter.has(item.priority));
  }

  items = [...items].sort((a, b) => {
    if (sortBy === "priority") {
      const pd = priorityRank(a.priority) - priorityRank(b.priority);
      if (pd !== 0) return pd;
      return a.status.localeCompare(b.status);
    }
    if (sortBy === "status") {
      const sd = a.status.localeCompare(b.status);
      if (sd !== 0) return sd;
      return priorityRank(a.priority) - priorityRank(b.priority);
    }
    return a.title.localeCompare(b.title);
  });

  const isFiltering = !!searchQuery || (selectedTags && selectedTags.length > 0) || statusFilter.size > 0 || priorityFilter.size > 0;

  return html`
    <div className="agenda-view todo-view">
      <div className="todo-sort-bar">
        <span className="todo-sort-label">Sort:</span>
        ${TODO_SORT_OPTIONS.map((opt) => html`
          <button key=${opt.key}
                  className=${"todo-sort-btn" + (sortBy === opt.key ? " active" : "")}
                  onClick=${() => setSortBy(opt.key)}>${opt.label}</button>
        `)}
        <span style=${{ flex: 1 }} />
        <button className=${"todo-scope-btn" + (allFiles ? " active" : "")}
                title=${allFiles ? "Showing all workspace files — click to show only this file" : "Show TODOs from all workspace files"}
                onClick=${toggleAllFiles}>
          ${allFilesLoading ? "Loading…" : (allFiles ? "≡ All files" : "≡ This file")}
        </button>
      </div>
      <div className="todo-filter-bar">
        <span className="todo-sort-label">Filter:</span>
        ${TODO_STATUS_FILTERS.map((s) => html`
          <button key=${s}
                  className=${"todo-filter-chip status-badge status-" + s.toLowerCase() + (statusFilter.has(s) ? " active" : "")}
                  onClick=${() => toggleStatus(s)}>${s}</button>
        `)}
        <span className="todo-filter-sep"></span>
        ${["A", "B", "C"].map((p) => html`
          <button key=${p}
                  className=${"todo-filter-chip priority-badge priority-" + p + (priorityFilter.has(p) ? " active" : "")}
                  onClick=${() => togglePriority(p)}>${p}</button>
        `)}
        ${(statusFilter.size > 0 || priorityFilter.size > 0) && html`
          <button className="todo-filter-clear" onClick=${clearAll}>✕ clear</button>
        `}
      </div>
      ${searchQuery && html`
        <div className="agenda-filter-badge">
          Text filter: ${searchQuery} — ${items.length} result${items.length === 1 ? "" : "s"}
        </div>
      `}
      ${items.length === 0 ? html`
        <div className="agenda-empty">${isFiltering ? "No matches" : allFiles ? "No TODO items found in workspace" : "No TODO items in this file"}</div>
      ` : items.map((item, i) => html`
        <div className="todo-item" key=${item.id || ("ext-" + i)}
             onClick=${() => item.id ? onSelect(item.id) : onSelect({ file: item.file, title: item.title, id: null })}>
          <span className=${"todo-item-priority" + (item.priority ? " priority-badge priority-" + item.priority : " priority-badge priority-none")}>
            ${item.priority || ""}
          </span>
          <span className=${"todo-item-status status-badge status-" + item.status.toLowerCase()}>
            ${item.status}
          </span>
          <span className="todo-item-title"
                dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(item.title || "Untitled") }} />
          ${item.tags.length > 0 && html`
            <span className="agenda-item-tags">
              ${item.tags.map((t) => html`<span key=${t} className="agenda-item-tag">:${t}:</span>`)}
            </span>
          `}
          ${item.file && item.file !== currentFile && html`
            <span className="todo-item-file">${item.file.replace(/\.org$/, "")}</span>
          `}
          ${item.ancestors && item.ancestors.length > 0 && html`
            <span className="todo-item-path"
                  dangerouslySetInnerHTML=${{ __html: item.ancestors.map((a) => tree.renderOrgInline(a)).join(" › ") }} />
          `}
        </div>
      `)}
    </div>
  `;
}

function SearchResultsView({ searchResults, currentFile, onBack, onNavigate }) {
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [currentFileOnly, setCurrentFileOnly] = useState(false);

  // Reset filters when the search changes
  const queryKey = searchResults.type + ":" + searchResults.query;
  const prevQueryRef = useRef(queryKey);
  if (prevQueryRef.current !== queryKey) {
    prevQueryRef.current = queryKey;
    setActiveFilters(new Set());
    setCurrentFileOnly(false);
  }

  const toggleFilter = (tag) => setActiveFilters((prev) => {
    const next = new Set(prev); next.has(tag) ? next.delete(tag) : next.add(tag); return next;
  });

  const results = searchResults.results;

  // Collect additional unique tags across results (beyond the query tag)
  const extraTags = useMemo(() => {
    if (!results) return [];
    const seen = new Set();
    for (const r of results) for (const t of (r.tags || [])) seen.add(t);
    if (searchResults.type === "tag") seen.delete(searchResults.query);
    return [...seen].sort();
  }, [results, searchResults.type, searchResults.query]);

  const filtered = useMemo(() => {
    if (!results) return results;
    let out = results;
    if (currentFileOnly && currentFile) out = out.filter((r) => r.file === currentFile);
    if (activeFilters.size > 0) out = out.filter((r) => r.tags && [...activeFilters].every((t) => r.tags.includes(t)));
    return out;
  }, [results, activeFilters, currentFileOnly, currentFile]);

  return html`
    <div className="tag-search-header">
      <button className="tag-search-back" onClick=${onBack}>← Back</button>
      <span className="tag-search-title-label">
        ${searchResults.type === "tag"
          ? html`Tag search:`
          : html`Text search: <code>${searchResults.query}</code>`}
        ${filtered !== null ? html` — ${filtered.length} result${filtered.length === 1 ? "" : "s"}` : ""}
      </span>
    </div>
    <div className="todo-filter-bar">
      <span className="todo-sort-label">Filter:</span>
      ${searchResults.type === "tag" && html`
        <button className="todo-filter-chip tag-filter-chip active-filter"
                onClick=${onBack} title="Clear search">
          ${searchResults.query} ✕
        </button>
      `}
      ${currentFile && html`
        <button className=${"todo-filter-chip tag-filter-chip" + (currentFileOnly ? " active-filter" : "")}
                onClick=${() => setCurrentFileOnly((v) => !v)}
                title="Show results from current file only">
          Current file${currentFileOnly ? " ✕" : ""}
        </button>
      `}
      ${extraTags.map((t) => html`
        <button key=${t}
                className=${"todo-filter-chip tag-filter-chip" + (activeFilters.has(t) ? " active-filter" : "")}
                onClick=${() => toggleFilter(t)}>
          ${t}${activeFilters.has(t) ? " ✕" : ""}
        </button>
      `)}
      ${(activeFilters.size > 0 || currentFileOnly) && html`
        <button className="todo-filter-clear" onClick=${() => { setActiveFilters(new Set()); setCurrentFileOnly(false); }}>✕ clear all</button>
      `}
    </div>
    ${results === null ? html`
      <div className="tag-search-loading">Searching…</div>
    ` : filtered.length === 0 ? html`
      <div className="tag-search-empty">
        ${activeFilters.size > 0
          ? html`No results match the active tag filters.`
          : searchResults.type === "tag"
            ? html`No nodes tagged <code>:${searchResults.query}:</code> found in any org file.`
            : html`No matches for <code>${searchResults.query}</code> found in any org file.`}
      </div>
    ` : filtered.map((r, i) => {
      // Markdown results come from the "include .md files" search option —
      // they can't be opened through the normal org-file loader (it would
      // parse and could resave markdown as if it were org syntax), so treat
      // them like subfolder results: shown, but not directly clickable.
      const isMarkdown = isMarkdownFile(r.file);
      const notNavigable = r.inSubdir || isMarkdown;
      return html`
      <div key=${i}
           className=${"tag-search-result" + (r.inSubdir ? " tag-search-result-subdir" : "")}
           onClick=${notNavigable ? undefined : () => onNavigate(r)}>
        <div className="tag-search-result-file">
          ${r.file}
          ${r.inSubdir && html`<span className="tag-search-result-subdir-badge" title="In subdirectory — open manually">subfolder</span>`}
          ${!r.inSubdir && isMarkdown && html`<span className="tag-search-result-subdir-badge" title="Markdown file — open manually">markdown</span>`}
        </div>
        <div className="tag-search-result-title"
             dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(r.title) }} />
        ${r.context && html`<div className="tag-search-result-context"
             dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(r.context) }} />`}
        ${r.tags && r.tags.length > 0 && html`
          <div className="tag-search-result-tags">
            ${r.tags.map((t) => html`<span key=${t} className="tag-search-result-tag">:${t}:</span>`)}
          </div>
        `}
      </div>
    `;
    })}
  `;
}

// Inline scheduling editor shown beneath an agenda item row.
function AgendaScheduleEditor({ item, currentNode, onUpdateCurrent, onClose, onItemCleared }) {
  const isExternal = !!item.file;

  // For external items we manage local copies of the raw values and fetch the doc.
  const [localSchedRaw, setLocalSchedRaw] = useState(item.scheduledRaw || "");
  const [localDlRaw,    setLocalDlRaw]    = useState(item.deadlineRaw  || "");
  const [extDoc,        setExtDoc]        = useState(null); // {nodes, preamble, hash}
  const [saveLabel,     setSaveLabel]     = useState(""); // "", "Saving…", "Saved", "Error"
  const saveTimerRef = useRef(null);

  useEffect(() => {
    if (!isExternal) return;
    api.get(docUrl(item.file)).then((data) => {
      setExtDoc(data);
      // Refresh from the file in case the item's raw values were stale.
      function find(ns) {
        for (const n of ns) {
          if (n.title === item.title) return n;
          if (n.children?.length > 0) { const f = find(n.children); if (f) return f; }
        }
        return null;
      }
      const found = find(data.nodes || []);
      if (found) {
        setLocalSchedRaw(found.properties?.SCHEDULED || "");
        setLocalDlRaw(found.properties?.DEADLINE    || "");
      }
    }).catch(() => {});
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, []);

  // Derive display values from whichever source is active.
  const schedRaw = isExternal ? localSchedRaw : (currentNode?.properties?.SCHEDULED || "");
  const dlRaw    = isExternal ? localDlRaw    : (currentNode?.properties?.DEADLINE  || "");
  const schedDate     = tree.parseOrgDate(schedRaw);
  const schedTime     = tree.parseOrgScheduledTime(schedRaw);
  const schedRepeater = tree.parseOrgRepeater(schedRaw);
  const dlDate        = tree.parseOrgDate(dlRaw);

  function updateNodePropsInTree(ns, title, updater) {
    return ns.map((n) => {
      if (n.title === title) return { ...n, properties: updater(n.properties || {}) };
      if (n.children?.length > 0) return { ...n, children: updateNodePropsInTree(n.children, title, updater) };
      return n;
    });
  }

  const save = useCallback((newSchedRaw, newDlRaw) => {
    if (!isExternal) {
      // Current-file: dispatch immediately via parent callback.
      const props = { ...(currentNode?.properties || {}) };
      if (newSchedRaw) props.SCHEDULED = newSchedRaw; else delete props.SCHEDULED;
      if (newDlRaw)    props.DEADLINE  = newDlRaw;    else delete props.DEADLINE;
      onUpdateCurrent(item.id, props);
    } else {
      // External file: update local state then debounce the PUT.
      setLocalSchedRaw(newSchedRaw);
      setLocalDlRaw(newDlRaw);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        if (!extDoc) return;
        setSaveLabel("Saving…");
        try {
          const updNodes = updateNodePropsInTree(extDoc.nodes || [], item.title, (props) => {
            const p = { ...props };
            if (newSchedRaw) p.SCHEDULED = newSchedRaw; else delete p.SCHEDULED;
            if (newDlRaw)    p.DEADLINE  = newDlRaw;    else delete p.DEADLINE;
            return p;
          });
          const result = await api.put(docUrl(item.file), {
            hash: extDoc.hash, preamble: extDoc.preamble || "", nodes: updNodes,
          });
          setExtDoc((d) => ({ ...d, hash: result.hash, nodes: updNodes }));
          setSaveLabel("Saved");
          setTimeout(() => setSaveLabel(""), 1500);
        } catch {
          setSaveLabel("Error saving");
          setTimeout(() => setSaveLabel(""), 2500);
        }
      }, 600);
    }
  }, [isExternal, currentNode, extDoc, item, onUpdateCurrent]);

  return html`
    <div className="agenda-item-editor" onClick=${(e) => e.stopPropagation()}>
      <div className="agenda-editor-row">
        <span className="agenda-editor-label">Sched</span>
        <input type="date" className="detail-date detail-scheduled-date"
          value=${schedDate}
          onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
          onChange=${(e) => {
            const ns = e.target.value ? tree.formatOrgScheduled(e.target.value, schedTime, schedRepeater) : "";
            save(ns, dlRaw);
          }} />
        <input type="time" step="900" className="detail-date detail-scheduled-time"
          value=${schedTime} disabled=${!schedDate}
          onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
          onChange=${(e) => {
            save(schedDate ? tree.formatOrgScheduled(schedDate, e.target.value, schedRepeater) : "", dlRaw);
          }} />
        <button className="agenda-editor-clear" onClick=${() => save("", dlRaw)}
                disabled=${!schedRaw}>×</button>
      </div>
      <div className="agenda-editor-row">
        <span className="agenda-editor-label">Repeat</span>
        <div className="detail-repeater-row">
          ${REPEATER_OPTIONS.map(({label, value}) => html`
            <button key=${value || "none"}
                    className=${"detail-repeater-btn" + (schedRepeater === value ? " active" : "")}
                    disabled=${!schedDate}
                    onClick=${() => save(tree.formatOrgScheduled(schedDate, schedTime, value), dlRaw)}>
              ${label}
            </button>
          `)}
        </div>
      </div>
      <div className="agenda-editor-row">
        <span className="agenda-editor-label">Deadline</span>
        <input type="date" className="detail-date detail-scheduled-date"
          value=${dlDate}
          onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
          onChange=${(e) => {
            save(schedRaw, e.target.value ? tree.formatOrgDate(e.target.value) : "");
          }} />
        <button className="agenda-editor-clear" onClick=${() => save(schedRaw, "")}
                disabled=${!dlRaw}>×</button>
      </div>
      <div className="agenda-editor-footer">
        ${saveLabel && html`<span className="agenda-editor-save-label">${saveLabel}</span>`}
        <button className="agenda-editor-clear-all"
                onClick=${() => {
                  save("", "");
                  if (isExternal) onItemCleared?.();
                  onClose();
                }}>Delete All Scheduling</button>
        <button className="agenda-editor-done"
                onClick=${() => {
                  if (isExternal && !localSchedRaw && !localDlRaw) onItemCleared?.();
                  onClose();
                }}>Done</button>
      </div>
    </div>
  `;
}

function AgendaView({ nodes, currentFile, onSelect, onEditNode, searchQuery, selectedTags, onGoToDate, onNewAppointment }) {
  const [apiItems, setApiItems] = useState(null); // null=loading
  const [sortDesc, setSortDesc] = useState(true); // true = newest/future first
  const [dateFilter, setDateFilter] = useState("all"); // "all" | "future" | "past"
  const [openEditKey, setOpenEditKey] = useState(null); // key of item whose editor is open
  const [hiddenExternalKeys, setHiddenExternalKeys] = useState(() => new Set());

  useEffect(() => {
    api.get("/api/agenda")
      .then((data) => setApiItems(data.items || []))
      .catch(() => setApiItems([]));
  }, []);

  const cycleFilter = useCallback(() => {
    setDateFilter((f) => DATE_FILTERS[(DATE_FILTERS.indexOf(f) + 1) % DATE_FILTERS.length]);
  }, []);

  // Must run unconditionally (before the early "no items" return below) —
  // calling hooks after a conditional return violates the Rules of Hooks and
  // makes React throw "rendered fewer hooks than expected" the moment the
  // list empties out, which (with no error boundary anywhere) unmounts the
  // entire app instead of just this view.
  const agendaDatePickerRef = useRef(null);
  const openAgendaDatePicker = useCallback(() => {
    const el = agendaDatePickerRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.click(); }
  }, []);

  const isFiltering = !!searchQuery || (selectedTags && selectedTags.length > 0);
  // Local items come from the current in-memory nodes.
  const localItems = collectDatedItems(nodes);
  // External items come from the server scan; exclude the current file to avoid duplicates.
  const externalItems = (apiItems || [])
    .filter((it) => it.file !== currentFile && !hiddenExternalKeys.has(it.file + "::" + it.nodeTitle))
    .map((it) => ({
      id: null,
      title: it.nodeTitle,
      date: it.date,
      time: it.time || "",
      kind: it.kind,
      status: it.status,
      tags: it.tags || [],
      ancestors: it.ancestors || [],
      file: it.file,
      scheduledRaw: it.scheduledRaw || "",
      deadlineRaw: it.deadlineRaw || "",
    }));
  let items = [...localItems, ...externalItems];

  if (searchQuery) {
    const pq = tree.parseSearchQuery(searchQuery);
    items = items.filter((item) =>
      tree.nodeMatchesQuery(pq, { ...item, body: (item.ancestors || []).join(" ") })
    );
  }
  if (selectedTags && selectedTags.length > 0) {
    items = items.filter((item) => (item.tags || []).some((t) => selectedTags.includes(t)));
  }

  const today = localDateStr();
  if (dateFilter === "future") items = items.filter((item) => item.date >= today);
  if (dateFilter === "past")   items = items.filter((item) => item.date <= today);

  items.sort((a, b) => {
    const dc = a.date.localeCompare(b.date);
    if (dc !== 0) return sortDesc ? -dc : dc;
    // Within same date: always chronological (earlier time first)
    if (a.time && !b.time) return -1;
    if (!a.time && b.time) return 1;
    return (a.time || "").localeCompare(b.time || "");
  });

  if (items.length === 0 && apiItems !== null) {
    return html`<div className="agenda-empty">${isFiltering || dateFilter !== "all" ? "No matches" : "No items scheduled or with deadlines"}</div>`;
  }

  const groups = [];
  let cur = null;
  for (const item of items) {
    if (!cur || cur.date !== item.date) { cur = { date: item.date, items: [] }; groups.push(cur); }
    cur.items.push(item);
  }

  return html`
    <div className="agenda-view">
      <div className="journal-toolbar agenda-toolbar">
        <input type="date" ref=${agendaDatePickerRef} className="hidden-date-input"
               onChange=${(e) => { if (e.target.value) onGoToDate(e.target.value); e.target.value = ""; }} />
        <button className="journal-icon-btn" onClick=${openAgendaDatePicker}
                title="Go to a specific date in the journal">
          <${IconAgenda} /> Go to date…
        </button>
        <button className="journal-icon-btn journal-add-appt-btn" onClick=${onNewAppointment}
                title="Add appointment to a journal date">+ Appointment</button>
        <div className="view-toolbar-spacer" />
        <button className="journal-icon-btn" onClick=${() => setSortDesc((d) => !d)}
                title="Toggle sort order">
          ${sortDesc ? "↓ Newest first" : "↑ Oldest first"}
        </button>
        <button className=${"journal-icon-btn" + (dateFilter !== "all" ? " view-ctrl-active" : "")}
                onClick=${cycleFilter} title="Cycle date filter">
          ${DATE_FILTER_LABELS[dateFilter]}
        </button>
      </div>
      ${isFiltering && html`
        <div className="agenda-filter-badge">
          Filtering: ${[searchQuery, ...(selectedTags||[])].filter(Boolean).join(", ")} — ${items.length} result${items.length === 1 ? "" : "s"}
        </div>
      `}
      ${groups.map((g) => html`
        <div className="agenda-group" key=${g.date}>
          <div className=${"agenda-date" + (isOverdue(g.date) ? " overdue" : "") + (isToday(g.date) ? " today" : "")}>
            ${formatDateDisplay(g.date)}
            ${isToday(g.date) && html`<span className="agenda-badge">today</span>`}
            ${isOverdue(g.date) && html`<span className="agenda-badge overdue">overdue</span>`}
          </div>
          ${g.items.map((item, idx) => {
            const editKey = (item.id || item.file + item.title) + "-" + item.kind + "-" + idx;
            const isEditing = openEditKey === editKey;
            const currentNode = item.id ? (() => {
              function find(ns) {
                for (const n of ns) {
                  if (n.id === item.id) return n;
                  if (n.children?.length > 0) { const f = find(n.children); if (f) return f; }
                }
                return null;
              }
              return find(nodes);
            })() : null;
            return html`
              <div className=${"agenda-item-wrapper" + (isEditing ? " editing" : "")} key=${editKey}>
                <div className="agenda-item" onClick=${() => !isEditing && onSelect(item)}>
                  <div className="agenda-item-top">
                    ${item.time && html`<span className="agenda-item-time">${item.time}</span>`}
                    <span className="agenda-item-title"
                          dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(item.title || "Untitled") }} />
                    <button className=${"agenda-item-edit-btn" + (isEditing ? " active" : "")}
                            title="Edit scheduling"
                            onClick=${(e) => { e.stopPropagation(); setOpenEditKey(isEditing ? null : editKey); }}>\u270E</button>
                    <span className=${"agenda-item-kind " + item.kind}>${item.kind === "scheduled" ? "sched" : "deadline"}</span>
                  </div>
                  ${(() => {
                    const pathParts = [
                      ...item.ancestors.map((a) => tree.renderOrgInline(a)),
                      ...(item.file ? [`<span class="agenda-item-file">${item.file}</span>`] : []),
                    ];
                    return pathParts.length > 0 && html`
                      <span className="agenda-item-path"
                            dangerouslySetInnerHTML=${{ __html: pathParts.join(" \u203A ") }} />
                    `;
                  })()}
                </div>
                ${isEditing && html`
                  <${AgendaScheduleEditor}
                    item=${item}
                    currentNode=${currentNode}
                    onUpdateCurrent=${onEditNode}
                    onClose=${() => setOpenEditKey(null)}
                    onItemCleared=${() => {
                      setHiddenExternalKeys((prev) => { const s = new Set(prev); s.add(item.file + "::" + item.title); return s; });
                      setOpenEditKey(null);
                    }} />
                `}
              </div>
            `;
          })}
        </div>
      `)}
    </div>
  `;
}

function JournalDayCard({ filename, onOpen, onOpenDetail, onOpenAt, searchQuery }) {
  const [content, setContent] = useState(null); // null=not loaded, false=error, {nodes,preamble}=ok
  const hasStarted = useRef(false);
  const cardRef = useRef(null);

  const doLoad = useCallback(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;
    api.get(docUrl(filename))
      .then((d) => setContent({ nodes: d.nodes || [], preamble: d.preamble || "" }))
      .catch(() => setContent(false));
  }, [filename]);

  useEffect(() => {
    if (!cardRef.current || typeof IntersectionObserver === "undefined") {
      doLoad();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { io.disconnect(); doLoad(); }
    }, { rootMargin: "300px" });
    io.observe(cardRef.current);
    return () => io.disconnect();
  }, [doLoad]);

  const dateStr = filename.replace("journal/", "").replace(".org", "");
  const dateDisplay = formatJournalDate(dateStr);
  const today = isToday(dateStr);

  // When filtering: hide card if content is loaded and nothing matches
  const pq = tree.parseSearchQuery(searchQuery);
  const dateMatches = !searchQuery || tree.nodeMatchesQuery(pq, { title: dateStr + " " + dateDisplay, body: "" });
  const allNodes = content && content.nodes ? content.nodes : [];
  const matchingNodes = searchQuery
    ? allNodes.filter((n) => tree.nodeMatchesQuery(pq, n))
    : allNodes;
  // If content is loaded and neither the date nor any nodes match, hide the card entirely
  if (searchQuery && content && !dateMatches && matchingNodes.length === 0) return null;

  const displayNodes = searchQuery ? matchingNodes : allNodes;

  return html`
    <div className=${"journal-day-card" + (today ? " journal-today" : "")} ref=${cardRef}>
      <div className="journal-day-header">
        <button className="journal-day-date" onClick=${onOpen}>
          ${dateDisplay}
          ${today && html`<span className="journal-today-badge">today</span>`}
        </button>
        <button className="journal-day-detail-btn" onClick=${onOpenDetail} title="Open with detail pane">⋯</button>
      </div>
      <div className="journal-day-content" onClick=${onOpen}>
        ${content === null && html`<div className="journal-loading">Loading…</div>`}
        ${content === false && html`<div className="journal-error">Could not load</div>`}
        ${content && displayNodes.length === 0 && !searchQuery && html`
          <div className="journal-day-empty">No entries yet — click to add</div>
        `}
        ${content && displayNodes.length > 0 && html`
          ${displayNodes.slice(0, 6).map((node, i) => html`
            <div key=${i} className="journal-node-preview"
                 onClick=${(e) => { e.stopPropagation(); onOpenAt(node.id); }}>
              <span className="journal-node-bullet">•</span>
              <span dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(node.title || "") }} />
              ${node.children && node.children.length > 0 && html`
                <span className="journal-node-child-count"> +${node.children.length}</span>
              `}
            </div>
          `)}
          ${displayNodes.length > 6 && html`
            <div className="journal-more">+${displayNodes.length - 6} more…</div>
          `}
        `}
      </div>
    </div>
  `;
}

function pathBasename(p) { if (!p) return ""; const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
function pathDirname(p) { if (!p) return "/"; const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "/"; }

function todayDateStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

const REMINDER_OPTIONS = [
  { label: "None",     value: "" },
  { label: "At time",  value: "0" },
  { label: "5 min",    value: "5" },
  { label: "15 min",   value: "15" },
  { label: "30 min",   value: "30" },
  { label: "1 hour",   value: "60" },
  { label: "1 day",    value: "1440" },
];

function AppointmentDialog({ defaultDate, onConfirm, onCancel }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate || todayDateStr());
  const [time, setTime] = useState("09:00");
  const [reminder, setReminder] = useState("");
  const titleRef = useRef(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const submit = useCallback(() => {
    if (!title.trim()) return;
    onConfirm({ title: title.trim(), date, time, reminder });
  }, [title, date, time, reminder, onConfirm]);

  return html`
    <div className="folder-picker-overlay"
         onMouseDown=${(e) => e.target === e.currentTarget && onCancel()}>
      <div className="appointment-dialog">
        <h3 className="appt-dialog-title">New Appointment</h3>
        <div className="appt-field">
          <label className="appt-label">Title</label>
          <input ref=${titleRef} type="text" className="appt-input"
                 value=${title}
                 onChange=${(e) => setTitle(e.target.value)}
                 onKeyDown=${(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
                 placeholder="e.g. Dentist appointment" />
        </div>
        <div className="appt-field">
          <label className="appt-label">Date</label>
          <input type="date" className="appt-input appt-datetime"
                 value=${date} onChange=${(e) => setDate(e.target.value)} />
        </div>
        <div className="appt-field">
          <label className="appt-label">Time</label>
          <input type="time" className="appt-input appt-datetime" step="900"
                 value=${time} onChange=${(e) => setTime(e.target.value)} />
        </div>
        <div className="appt-field">
          <label className="appt-label">Reminder</label>
          <select className="appt-input" value=${reminder} onChange=${(e) => setReminder(e.target.value)}>
            ${REMINDER_OPTIONS.map(({ label, value }) => html`<option key=${value} value=${value}>${label}</option>`)}
          </select>
        </div>
        <div className="appt-dialog-buttons">
          <button className="appt-btn-cancel" onClick=${onCancel}>Cancel</button>
          <button className="appt-btn-confirm" onClick=${submit}
                  disabled=${!title.trim()}>Add to Journal</button>
        </div>
        <p className="appt-dialog-hint">
          Adds a <strong>TODO</strong> heading with a <strong>SCHEDULED</strong> timestamp
          to the journal file for that date.
        </p>
      </div>
    </div>
  `;
}

// Shows one due reminder at a time (oldest-queued first). Deliberately has
// no backdrop-click or Escape dismissal — it's meant to stay onscreen until
// explicitly acknowledged, not to be accidentally swiped away.
function ReminderPopup({ reminder, queueLength, onOpen, onDismiss }) {
  return html`
    <div className="reminder-overlay">
      <div className="reminder-dialog">
        <div className="reminder-dialog-header">
          <span className="reminder-dialog-icon">⏰</span>
          <h3 className="reminder-dialog-title">Reminder</h3>
          ${queueLength > 1 && html`<span className="reminder-dialog-count">1 of ${queueLength}</span>`}
        </div>
        <div className="reminder-dialog-body">
          <div className="reminder-item-title"
               dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(reminder.nodeTitle || "Untitled") }} />
          <div className="reminder-item-when">
            ${formatDateDisplay(reminder.date)}${reminder.time ? ` at ${reminder.time}` : ""}
          </div>
          ${reminder.file && html`<div className="reminder-item-file">${reminder.file}</div>`}
        </div>
        <div className="reminder-dialog-buttons">
          <button className="appt-btn-cancel" onClick=${() => onDismiss(reminder)}>Dismiss</button>
          <button className="appt-btn-confirm" onClick=${() => onOpen(reminder)}>Open</button>
        </div>
      </div>
    </div>
  `;
}

function JournalView({ onOpenFile, onOpenFileWithDetail, onOpenFileAt, onGoToDate, onNewAppointment, searchQuery }) {
  const [journalFiles, setJournalFiles] = useState(null); // null=loading, []+ =loaded
  const [sortDesc, setSortDesc] = useState(true); // true = newest first
  const [dateFilter, setDateFilter] = useState("all"); // "all" | "future" | "past"
  const datePickerRef = useRef(null);

  useEffect(() => {
    api.get("/api/journal")
      .then((d) => setJournalFiles(d.files || []))
      .catch(() => setJournalFiles([]));
  }, []);

  const cycleFilter = useCallback(() => {
    setDateFilter((f) => DATE_FILTERS[(DATE_FILTERS.indexOf(f) + 1) % DATE_FILTERS.length]);
  }, []);

  const openToday = useCallback(async () => {
    try {
      const d = await api.post("/api/journal", {});
      onOpenFile(d.filename);
    } catch {}
  }, [onOpenFile]);

  const openDatePicker = useCallback(() => {
    const el = datePickerRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.click(); }
  }, []);

  // Build the display list: filter by date, then sort
  const today = localDateStr();
  let displayFiles = journalFiles || [];
  if (dateFilter === "future") displayFiles = displayFiles.filter((f) => {
    const m = f.name.match(/(\d{4}-\d{2}-\d{2})\.org$/); return m && m[1] >= today;
  });
  if (dateFilter === "past") displayFiles = displayFiles.filter((f) => {
    const m = f.name.match(/(\d{4}-\d{2}-\d{2})\.org$/); return m && m[1] <= today;
  });
  // API returns newest-first; reverse for ascending
  if (!sortDesc) displayFiles = [...displayFiles].reverse();

  return html`
    <div className="journal-view">
      <div className="journal-toolbar">
        <button className="journal-today-btn" onClick=${openToday}>Today's Journal</button>
        <input type="date" ref=${datePickerRef} className="hidden-date-input"
               onChange=${(e) => { if (e.target.value) onGoToDate(e.target.value); e.target.value = ""; }} />
        <button className="journal-icon-btn" onClick=${openDatePicker} title="Go to a specific date">
          <${IconAgenda} />
        </button>
        <button className="journal-icon-btn journal-add-appt-btn" onClick=${onNewAppointment}
                title="Add appointment to a journal date">+ Appointment</button>
        <div className="view-toolbar-spacer" />
        <button className="journal-icon-btn" onClick=${() => setSortDesc((d) => !d)}
                title="Toggle sort order">
          ${sortDesc ? "↓ Newest first" : "↑ Oldest first"}
        </button>
        <button className=${"journal-icon-btn" + (dateFilter !== "all" ? " view-ctrl-active" : "")}
                onClick=${cycleFilter} title="Cycle date filter">
          ${DATE_FILTER_LABELS[dateFilter]}
        </button>
      </div>
      ${journalFiles === null && html`
        <div className="agenda-empty">Loading journal files…</div>
      `}
      ${journalFiles !== null && displayFiles.length === 0 && html`
        <div className="agenda-empty">${journalFiles.length === 0 ? 'No journal entries yet — click "Today\'s Journal" to create one.' : "No entries match the current filter."}</div>
      `}
      ${journalFiles !== null && displayFiles.length > 0 && searchQuery && html`
        <div className="agenda-filter-badge">Filtering: ${searchQuery}</div>
      `}
      ${journalFiles !== null && displayFiles.map((f) => html`
        <${JournalDayCard}
          key=${f.name}
          filename=${f.name}
          onOpen=${() => onOpenFile(f.name)}
          onOpenDetail=${() => onOpenFileWithDetail(f.name)}
          onOpenAt=${(nodeId) => onOpenFileAt(f.name, nodeId)}
          searchQuery=${searchQuery}
        />
      `)}
    </div>
  `;
}

// --- Keyboard shortcuts ---

const SHORTCUTS_KEY = "epicorg.shortcuts";

const SHORTCUT_DEFS = [
  { id: "undo",            cat: "Edit",       label: "Undo",                  def: "Ctrl+Z" },
  { id: "redo",            cat: "Edit",       label: "Redo",                  def: "Ctrl+Shift+Z" },
  { id: "bold",            cat: "Formatting", label: "Bold",                  def: "Ctrl+B" },
  { id: "italic",          cat: "Formatting", label: "Italic",                def: "Ctrl+I" },
  { id: "underline",       cat: "Formatting", label: "Underline",             def: "Ctrl+U" },
  { id: "strikethrough",   cat: "Formatting", label: "Strikethrough",         def: "Ctrl+S" },
  { id: "insertFootnote",  cat: "Formatting", label: "Insert Footnote",       def: "Ctrl+Shift+N" },
  { id: "insertDateStamp", cat: "Formatting", label: "Insert Date Stamp",     def: "Ctrl+Shift+Q" },
  { id: "splitNode",       cat: "Outline",    label: "Split At Cursor Location", def: "Ctrl+Shift+S" },
  { id: "joinNode",        cat: "Outline",    label: "Join with Next Node",   def: "Ctrl+Shift+J" },
  { id: "moveUp",          cat: "Outline",    label: "Move Node Up",          def: "Alt+ArrowUp" },
  { id: "moveDown",        cat: "Outline",    label: "Move Node Down",        def: "Alt+ArrowDown" },
  { id: "indent",          cat: "Outline",    label: "Indent Node",           def: "Alt+ArrowRight" },
  { id: "outdent",         cat: "Outline",    label: "Outdent Node",          def: "Alt+ArrowLeft" },
  { id: "moveUpOnly",      cat: "Outline",    label: "Move Heading Up",       def: "Alt+Shift+ArrowUp" },
  { id: "moveDownOnly",    cat: "Outline",    label: "Move Heading Down",     def: "Alt+Shift+ArrowDown" },
  { id: "indentOnly",      cat: "Outline",    label: "Demote Heading",        def: "Alt+Shift+ArrowRight" },
  { id: "outdentOnly",     cat: "Outline",    label: "Promote Heading",       def: "Alt+Shift+ArrowLeft" },
  { id: "hoist",           cat: "Outline",    label: "Hoist / Unhoist",       def: "Ctrl+Shift+H" },
  { id: "commandPalette",  cat: "Navigation", label: "Command Palette",       def: "Ctrl+H" },
  { id: "textSearch",      cat: "Navigation", label: "Full-text Search",      def: "Ctrl+Shift+F" },
  { id: "copyFormatted",   cat: "Export",     label: "Copy as Formatted Text", def: "Ctrl+Shift+C" },
  { id: "copyPlain",       cat: "Export",     label: "Copy as Plain Text",     def: "Ctrl+Shift+X" },
  // Fixed: shown for reference, not rebindable
  { id: "newSibling",  cat: "Reference", label: "New Sibling Node",  def: "Enter",       fixed: true },
  { id: "editBody",    cat: "Reference", label: "Edit Body Note",    def: "Shift+Enter", fixed: true },
  { id: "foldToggle",  cat: "Reference", label: "Fold / Unfold",     def: "Tab",         fixed: true },
  { id: "deleteEmpty", cat: "Reference", label: "Delete Empty Node", def: "Backspace",   fixed: true },
  { id: "navUp",       cat: "Reference", label: "Navigate Up",       def: "↑",           fixed: true },
  { id: "navDown",     cat: "Reference", label: "Navigate Down",     def: "↓",           fixed: true },
  { id: "navBack",     cat: "Reference", label: "Go Back",           def: "Alt+←",       fixed: true },
  { id: "navForward",  cat: "Reference", label: "Go Forward",        def: "Alt+→",       fixed: true },
  { id: "foldLevel1",  cat: "Reference", label: "Fold to Level 1",   def: "Alt+1",       fixed: true },
  { id: "foldLevel2",  cat: "Reference", label: "Fold to Level 2",   def: "Alt+2",       fixed: true },
  { id: "foldLevel3",  cat: "Reference", label: "Fold to Level 3",   def: "Alt+3",       fixed: true },
  { id: "foldLevel4",  cat: "Reference", label: "Fold to Level 4",   def: "Alt+4",       fixed: true },
  { id: "foldLevel5",  cat: "Reference", label: "Fold to Level 5",   def: "Alt+5",       fixed: true },
  { id: "foldLevel6",  cat: "Reference", label: "Fold to Level 6",   def: "Alt+6",       fixed: true },
  { id: "foldLevel7",  cat: "Reference", label: "Fold to Level 7",   def: "Alt+7",       fixed: true },
  { id: "foldLevel8",  cat: "Reference", label: "Fold to Level 8",   def: "Alt+8",       fixed: true },
  { id: "expandAll",   cat: "Reference", label: "Expand All",        def: "Alt+9",       fixed: true },
];

const TOOLBAR_ITEMS = [
  { id: "home",       label: "Home button",          desc: "Jump to your configured home file" },
  { id: "navArrows",  label: "Back / Forward",       desc: "Navigate recently viewed files" },
  { id: "foldLevels", label: "Fold level buttons",   desc: "Collapse outline to heading levels 1–3 (outline only)" },
  { id: "moveGroup",  label: "Move / Notes / Hoist", desc: "Outline movement panel, inline notes, hoist (outline only)" },
  { id: "undoRedo",   label: "Undo / Redo",          desc: "Undo and redo editing actions" },
  { id: "viewTabs",   label: "View switcher",        desc: "Switch between Outline, Agenda, TODO, Journal" },
  { id: "modeToggle", label: "Mode toggle",          desc: "Plain, formatted titles, and reveal codes (outline only)" },
];
const TOOLBAR_DEFAULTS = { home: true, navArrows: true, foldLevels: true, moveGroup: true, undoRedo: true, viewTabs: true, modeToggle: true };
const TOOLBAR_CONFIG_KEY = "epicorg.toolbarConfig";

// Module-level shortcut overrides — mutated directly so key handlers
// (which are module-level functions) can always read the current bindings
// without needing them threaded through props/context.
let shortcutOverrides = (function() {
  try { return JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || "{}"); } catch { return {}; }
})();

function getShortcutCombo(id) {
  if (shortcutOverrides[id]) return shortcutOverrides[id];
  const d = SHORTCUT_DEFS.find((x) => x.id === id);
  return d ? d.def : "";
}

function matchesKey(combo, e) {
  if (!combo) return false;
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const needsCtrl  = parts.includes("Ctrl");
  const needsShift = parts.includes("Shift");
  const needsAlt   = parts.includes("Alt");
  const ctrl = e.ctrlKey || e.metaKey;
  return ctrl === needsCtrl && e.shiftKey === needsShift && e.altKey === needsAlt
    && (e.key === key || e.key.toLowerCase() === key.toLowerCase());
}

function matchShortcut(id, e) {
  return matchesKey(getShortcutCombo(id), e);
}

function keyEventToCombo(e) {
  const key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

function displayCombo(combo) {
  if (!combo) return "—";
  return combo
    .replace(/\bArrowUp\b/g, "↑")
    .replace(/\bArrowDown\b/g, "↓")
    .replace(/\bArrowLeft\b/g, "←")
    .replace(/\bArrowRight\b/g, "→");
}

// Ctrl+B/I/U/S wrap the selection in org-mode's inline markup characters.
function formatMarkerForKey(e) {
  if (matchShortcut("bold", e))          return "*";
  if (matchShortcut("italic", e))        return "/";
  if (matchShortcut("underline", e))     return "_";
  if (matchShortcut("strikethrough", e)) return "+";
  return null;
}

// Tracks the last textarea inside an outline/preamble row that received focus.
// Clicking the command palette or OAP moves focus away from the textarea, so
// document.activeElement is no longer useful — this lets applyMarkerToFocused
// still find the right element. Updated by a global focusin listener in App.
//
// A body note's textarea unmounts the instant it blurs (it re-renders as a
// formatted preview — see "stop-edit-body"), so by the time a palette command
// runs, el.closest(...) can no longer walk up to find its owning node: the
// element has already been detached from the tree. _lastOutlineTextareaMeta
// captures the node id and field name right now, while el is still attached.
let _lastOutlineTextarea = null;
let _lastOutlineTextareaMeta = null;
export function _setLastOutlineTextarea(el) {
  _lastOutlineTextarea = el;
  _lastOutlineTextareaMeta = fieldMetaForTextarea(el);
}

function fieldMetaForTextarea(el) {
  const row = el.closest("[data-node-id]");
  if (row) return { nodeId: row.dataset.nodeId, field: el.classList.contains("node-body-textarea") ? "change-body" : "change" };
  if (el.closest(".preamble-row")) return { nodeId: "preamble", field: "change-preamble" };
  return null;
}

// Apply an org inline marker to the last focused outline textarea.
// selectionStart/selectionEnd survive blur in all modern browsers, so the
// user's selected range is still intact even after focus moved to the palette.
function applyMarkerToFocused(marker) {
  const el = (document.activeElement?.tagName === "TEXTAREA" ? document.activeElement : null)
             || _lastOutlineTextarea;
  if (!el || el.tagName !== "TEXTAREA") return;
  const { selectionStart: start, selectionEnd: end, value } = el;
  const newVal = value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end);
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  nativeSetter.call(el, newVal);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  requestAnimationFrame(() => el.setSelectionRange(start + marker.length, end + marker.length));
}

// Collapses extra inline whitespace and hard line-wraps in messily pasted
// text, while preserving paragraph breaks (blank lines) — leading spaces/
// tabs on each line are stripped, runs of spaces/tabs become one space, and
// single newlines (a wrapped line, not a new paragraph) become a space too.
function cleanUpText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((para) => para
      .split("\n")
      .map((line) => line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""))
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim())
    .filter((para) => para.length > 0)
    .join("\n\n");
}

// Converts one <td>/<th> cell's inline content to org markup, recursing
// through simple formatting tags. A literal "|" would break the table's
// column structure, so it's swapped for a visually similar character.
function htmlCellToOrgInline(el) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { out += node.textContent; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    switch (node.tagName.toLowerCase()) {
      case "br": out += " "; return;
      case "b": case "strong": out += "*"; node.childNodes.forEach(walk); out += "*"; return;
      case "i": case "em": out += "/"; node.childNodes.forEach(walk); out += "/"; return;
      case "u": out += "_"; node.childNodes.forEach(walk); out += "_"; return;
      case "s": case "strike": case "del": out += "+"; node.childNodes.forEach(walk); out += "+"; return;
      case "code": case "tt": out += "="; node.childNodes.forEach(walk); out += "="; return;
      case "a": {
        const href = node.getAttribute("href");
        const label = node.textContent.trim();
        if (href) { out += (label && label !== href) ? `[[${href}][${label}]]` : `[[${href}]]`; return; }
        node.childNodes.forEach(walk);
        return;
      }
      default: node.childNodes.forEach(walk);
    }
  };
  el.childNodes.forEach(walk);
  return out.replace(/\s+/g, " ").trim().replace(/\|/g, "¦");
}

// Converts one <table> element into { rows, headerCount } for
// tree.serializeOrgTable, or null if it has no rows. A <thead>, or a first
// row made entirely of <th>, is treated as the header row.
function tableElementToOrgRows(table) {
  const trs = [...table.querySelectorAll("tr")];
  if (!trs.length) return null;
  const rows = trs.map((tr) => [...tr.children].map(htmlCellToOrgInline));
  const firstRowAllTh = trs[0].children.length > 0 && trs[0].querySelectorAll("th").length === trs[0].children.length;
  const headerCount = (table.querySelector("thead") || firstRowAllTh) ? 1 : 0;
  return { rows, headerCount };
}

// Tags whose inline content (bold/italic/links/etc.) matters but that don't
// start a new block on their own — e.g. a bare <b> or <span> sitting
// directly in the clipboard HTML without a wrapping <p>.
const ORG_INLINE_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "strike", "del", "code", "tt", "a", "span", "br"]);

// Walks a browser-clipboard HTML fragment into a sequence of org-mode
// blocks — plain paragraphs (as strings) and tables (as {rows, headerCount}
// objects) — in the order they appear. A paste that mixes prose with an
// embedded table would otherwise lose the prose if only the table were
// extracted, so every paragraph/heading/list-item/table is preserved in place.
function htmlToOrgBlocks(root) {
  const blocks = [];
  let buffer = "";
  const flush = () => {
    const t = buffer.replace(/\s+/g, " ").trim();
    if (t) blocks.push(t);
    buffer = "";
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { buffer += child.textContent; continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (tag === "table") {
        flush();
        const t = tableElementToOrgRows(child);
        if (t) blocks.push(t);
        continue;
      }
      if (tag === "p" || tag === "li" || tag === "blockquote" || /^h[1-6]$/.test(tag)) {
        flush();
        const t = htmlCellToOrgInline(child);
        if (t) blocks.push(t);
        continue;
      }
      if (tag === "ul" || tag === "ol") { flush(); walk(child); continue; }
      if (ORG_INLINE_TAGS.has(tag)) { buffer += htmlCellToOrgInline(child); continue; }
      // Generic wrapper (div, body, section, etc.) — keep searching inside it.
      walk(child);
    }
  };
  walk(root);
  flush();
  return blocks;
}

// Wraps the current selection (or, for a collapsed selection, just the
// cursor position) in `marker` on both sides, then re-selects the original
// text so the markup is visible and another press toggles it right back
// off. Deferred to an animation frame because onChange triggers a React
// re-render of this controlled textarea before the new selection would
// otherwise stick.
function wrapSelectionWithMarker(e, marker, onChange) {
  const el = e.target;
  const { selectionStart: start, selectionEnd: end, value } = el;
  onChange(value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end));
  requestAnimationFrame(() => el.setSelectionRange(start + marker.length, end + marker.length));
}

function handleKey(e, id, dispatch) {
  const marker = formatMarkerForKey(e);
  if (marker) { e.preventDefault(); wrapSelectionWithMarker(e, marker, (v) => dispatch(id, "change", v)); return; }
  if (matchShortcut("splitNode", e)) { e.preventDefault(); dispatch(id, "split-at-cursor", e.target.selectionStart); return; }
  if (matchShortcut("joinNode", e))  { e.preventDefault(); dispatch(id, "join-with-next"); return; }
  if (matchShortcut("moveUp", e))       { e.preventDefault(); dispatch(id, "move-up"); return; }
  if (matchShortcut("moveDown", e))     { e.preventDefault(); dispatch(id, "move-down"); return; }
  if (matchShortcut("indent", e))       { e.preventDefault(); dispatch(id, "indent"); return; }
  if (matchShortcut("outdent", e))      { e.preventDefault(); dispatch(id, "outdent"); return; }
  if (matchShortcut("moveUpOnly", e))   { e.preventDefault(); dispatch(id, "move-up-only"); return; }
  if (matchShortcut("moveDownOnly", e)) { e.preventDefault(); dispatch(id, "move-down-only"); return; }
  if (matchShortcut("indentOnly", e))   { e.preventDefault(); dispatch(id, "indent-only"); return; }
  if (matchShortcut("outdentOnly", e))  { e.preventDefault(); dispatch(id, "outdent-only"); return; }
  const key = e.key;
  if (key === "Tab")       { e.preventDefault(); dispatch(id, "toggle"); return; }
  if (key === "ArrowUp")   { e.preventDefault(); dispatch(id, "nav-up"); return; }
  if (key === "ArrowDown") { e.preventDefault(); dispatch(id, "nav-down"); return; }
  if (key === "Enter" && e.shiftKey) { e.preventDefault(); dispatch(id, "focus-body"); return; }
  if (key === "Enter") {
    e.preventDefault();
    const atStart = e.target.selectionStart === 0 && e.target.selectionEnd === 0;
    dispatch(id, atStart ? "new-sibling-before" : "new-sibling");
    return;
  }
  if (key === "Backspace" && e.target.value === "") { e.preventDefault(); dispatch(id, "delete"); return; }
}

// --- Date stamp ---

const DATE_STAMP_KEY = "epicorg.dateStampFmt";
const DATE_STAMP_DEFAULT = { date: "YYYY-MM-DD", time: "hh:mm am" };

const DATE_FMT_OPTIONS = [
  { key: "M/D/YY",     label: "7/2/26" },
  { key: "M/D/YYYY",   label: "7/2/2026" },
  { key: "YYYY-MM-DD", label: "ISO" },
  { key: "Mon D",      label: "Jul 2" },
];

const TIME_FMT_OPTIONS = [
  { key: "hh:mm am", label: "05:32 pm" },
  { key: "h:mm AM",  label: "5:34 AM" },
  { key: "HH:mm",    label: "17:34" },
  { key: "none",     label: "Date only" },
];

function getDateStampFmt() {
  try { return { ...DATE_STAMP_DEFAULT, ...JSON.parse(localStorage.getItem(DATE_STAMP_KEY) || "{}") }; }
  catch { return DATE_STAMP_DEFAULT; }
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatDateStamp(d, fmt) {
  const M = d.getMonth() + 1, D = d.getDate(), Y = d.getFullYear();
  const YY = String(Y).slice(-2);
  let s;
  switch (fmt.date) {
    case "M/D/YYYY":   s = `${M}/${D}/${Y}`; break;
    case "YYYY-MM-DD": s = `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}`; break;
    case "Mon D":      s = `${MONTHS_SHORT[d.getMonth()]} ${D}`; break;
    default:           s = `${M}/${D}/${YY}`;
  }
  if (fmt.time === "none") return s;
  const h = d.getHours(), mm = String(d.getMinutes()).padStart(2,"0");
  switch (fmt.time) {
    case "hh:mm am": { const h12 = h % 12 || 12; s += ` ${String(h12).padStart(2,"0")}:${mm} ${h < 12 ? "am" : "pm"}`; break; }
    case "h:mm AM":  { const h12 = h % 12 || 12; s += ` ${h12}:${mm} ${h < 12 ? "AM" : "PM"}`; break; }
    case "HH:mm":    s += ` ${String(h).padStart(2,"0")}:${mm}`; break;
    default:         { const h12 = h % 12 || 12; s += ` ${String(h12).padStart(2,"0")}:${mm} ${h < 12 ? "am" : "pm"}`; }
  }
  return s;
}

// --- Sync status ---
const SYNC_SAVED = "saved";
const SYNC_DIRTY = "unsaved";
const SYNC_SAVING = "saving";
const SYNC_ERROR = "error";
const SYNC_CONFLICT = "conflict";
const SYNC_MERGED = "merged";
const SYNC_RELOADED = "reloaded";

const SYNC_COPIED = "copied";

const SYNC_LABELS = {
  [SYNC_SAVED]:    "Saved \u2014 green dot: up to date",
  [SYNC_DIRTY]:    "Unsaved changes \u2014 amber dot: pending save",
  [SYNC_SAVING]:   "Saving\u2026 \u2014 blue dot: save in progress",
  [SYNC_ERROR]:    "Save failed \u2014 red dot: network or server error",
  [SYNC_CONFLICT]: "Merge conflict \u2014 red dot: resolve conflict markers in file",
  [SYNC_MERGED]:   "Merged external edits \u2014 blue dot: external edit was merged in",
  [SYNC_RELOADED]: "Reloaded \u2014 blue dot: file changed on disk and was reloaded",
  [SYNC_COPIED]:   "Copied to clipboard",
};

// Short form of SYNC_LABELS for use as a persistent visible label (SYNC_LABELS
// itself is the tooltip text, too long to sit in the UI at all times).
const SYNC_SHORT_LABELS = {
  [SYNC_SAVED]:    "Saved",
  [SYNC_DIRTY]:    "Unsaved changes",
  [SYNC_SAVING]:   "Saving\u2026",
  [SYNC_ERROR]:    "Save failed",
  [SYNC_CONFLICT]: "Merge conflict",
  [SYNC_MERGED]:   "Merged",
  [SYNC_RELOADED]: "Reloaded",
  [SYNC_COPIED]:   "Copied",
};

function Toast({ message }) {
  if (!message) return null;
  return html`<div className="toast">${message}</div>`;
}

function SyncIndicator({ status, filePath }) {
  const label = SYNC_LABELS[status] || "";
  // Leads with the file path so hovering the dot answers "which file is
  // this even talking about" — the confusion that causes edits to land in
  // the wrong document without the user noticing.
  const text = filePath ? (filePath + " — " + label) : label;
  // A custom hover tooltip instead of the native title attribute: the
  // browser tooltip can't be width-capped or wrapped, so a long absolute
  // path renders as one unreadable single-line strip.
  return html`
    <span className="sync-indicator-wrap">
      <span className=${"sync-indicator sync-" + status} aria-label=${text}>
        <span className="sync-dot sync-dot-filled" />
      </span>
      <span className="sync-tooltip" role="tooltip">${text}</span>
    </span>
  `;
}

// --- File Picker ---

const FILE_SORT_DEFAULT_DIR = { name: "asc", size: "desc", modTime: "desc" };

const FILE_COL_MIN_WIDTH = 50;
const FILE_COL_DEFAULTS = { size: 80, date: 170 };

function FilePicker({ files, onSelect, onCreate, onClose, onRename, onDelete, onChangeHomeFolder }) {
  const [newName, setNewName] = useState("");
  const [sort, setSort] = useState({ column: "name", dir: "asc" });

  // Integrated folder navigation — always starts at workspace dir
  const workspacePath = useRef(null); // resolved on first browse fetch
  const [navPath, setNavPath] = useState(null);  // null = at workspace root
  const [navDirs, setNavDirs] = useState([]);
  const [navFiles, setNavFiles] = useState([]);  // used only when not at workspace
  const [navParent, setNavParent] = useState(null);
  const [navLoading, setNavLoading] = useState(false);

  const fetchNav = useCallback(async (path) => {
    setNavLoading(true);
    try {
      const url = path
        ? "/api/browse?ext=.org&path=" + encodeURIComponent(path)
        : "/api/browse?ext=.org";
      const data = await api.get(url);
      if (!path) workspacePath.current = data.path;  // capture workspace path once
      const atHome = data.path === workspacePath.current;
      setNavPath(atHome ? null : data.path);
      setNavDirs(data.dirs || []);
      setNavFiles(atHome ? [] : (data.files || []));
      setNavParent(data.parent || null);
    } catch {}
    setNavLoading(false);
  }, []);

  useEffect(() => { fetchNav(null); }, [fetchNav]);

  const atWorkspace = navPath === null;
  const [renamingFile, setRenamingFile] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const renameInputRef = useRef(null);

  const startRename = (name) => {
    setRenamingFile(name);
    setRenameValue(name);
    requestAnimationFrame(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); });
  };
  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renamingFile) onRename(renamingFile, trimmed);
    setRenamingFile(null);
  };
  const [colWidths, setColWidths] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("epicorg.filePickerColWidths") || "null");
      if (stored && stored.size > 0 && stored.date > 0) return stored;
    } catch {}
    return FILE_COL_DEFAULTS;
  });

  const handleSort = (column) => {
    setSort((prev) => prev.column === column
      ? { column, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { column, dir: FILE_SORT_DEFAULT_DIR[column] });
  };

  const startResize = useCallback((column, downEvent) => {
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startWidth = colWidths[column];
    const onMove = (ev) => {
      const next = Math.max(FILE_COL_MIN_WIDTH, Math.round(startWidth + (ev.clientX - startX)));
      setColWidths((prev) => {
        const updated = { ...prev, [column]: next };
        try { localStorage.setItem("epicorg.filePickerColWidths", JSON.stringify(updated)); } catch {}
        return updated;
      });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [colWidths]);

  // `files` is the full recursive workspace listing (names like
  // "Epicurus/DeWitt.org" for nested files) — at the workspace root, only
  // root-level files belong in this flat list. Anything in a subfolder is
  // already reachable by clicking into that folder's row above, so
  // including it here too just duplicates the same file twice over.
  const rootFiles = files.filter((f) => !f.name.includes("/"));
  const sorted = [...rootFiles].sort((a, b) => {
    let cmp;
    if (sort.column === "name") cmp = a.name.localeCompare(b.name);
    else if (sort.column === "size") cmp = a.size - b.size;
    else cmp = new Date(a.modTime).getTime() - new Date(b.modTime).getTime();
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const arrow = (column) => sort.column === column ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

  return html`
    <div className="file-picker">
      <div className="file-picker-header">
        <div className="file-picker-header-text">
          <h2>Choose a file</h2>
          <div className="fp-current-path" title=${navPath || workspacePath.current || ""}>
            ${navPath || workspacePath.current || ""}
          </div>
        </div>
        ${onClose && html`
          <button className="file-picker-close" onClick=${onClose} title="Cancel" aria-label="Close">×</button>
        `}
      </div>

      ${atWorkspace
        ? html`
          <div className="file-list" style=${{ "--col-size-width": colWidths.size + "px", "--col-date-width": colWidths.date + "px" }}>
            <div className="file-list-header">
              <button className="file-sort-btn file-col-name" onClick=${() => handleSort("name")}>Name${arrow("name")}</button>
              <div className="file-col-resizable">
                <button className="file-sort-btn file-col-size" onClick=${() => handleSort("size")}>Size${arrow("size")}</button>
                <span className="file-col-resizer" onMouseDown=${(e) => startResize("size", e)} />
              </div>
              <div className="file-col-resizable">
                <button className="file-sort-btn file-col-date" onClick=${() => handleSort("modTime")}>Date${arrow("modTime")}</button>
                <span className="file-col-resizer" onMouseDown=${(e) => startResize("date", e)} />
              </div>
              <span className="file-col-actions"></span>
            </div>
            ${navParent && html`
              <div className="file-item fp-dir-row" onClick=${() => fetchNav(navParent)}>
                <span className="file-col-name file-name-col">
                  <span className="file-icon fp-dir-icon">📁</span>
                  <span className="file-name fp-dir-name">..</span>
                </span>
                <span className="file-col-size"></span>
                <span className="file-col-date"></span>
                <span className="file-col-actions"></span>
              </div>
            `}
            ${navDirs.map((d) => html`
              <div className="file-item fp-dir-row" key=${"d:" + d} onClick=${() => fetchNav((navPath || workspacePath.current) + "/" + d)}>
                <span className="file-col-name file-name-col">
                  <span className="file-icon fp-dir-icon">📁</span>
                  <span className="file-name fp-dir-name">${d}</span>
                </span>
                <span className="file-col-size"></span>
                <span className="file-col-date"></span>
                <span className="file-col-actions"></span>
              </div>
            `)}
            ${sorted.map((f) => html`
              <div className="file-item" key=${f.name} onClick=${() => { if (renamingFile !== f.name) onSelect(f.name); }}>
                <span className="file-col-name file-name-col">
                  <span className="file-icon"><${IconDoc}/></span>
                  ${renamingFile === f.name
                    ? html`
                      <input
                        ref=${(el) => { renameInputRef.current = el; }}
                        className="file-rename-input"
                        value=${renameValue}
                        onClick=${(e) => e.stopPropagation()}
                        onChange=${(e) => setRenameValue(e.target.value)}
                        onBlur=${() => setRenamingFile(null)}
                        onKeyDown=${(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                          if (e.key === "Escape") { e.preventDefault(); setRenamingFile(null); }
                        }}
                      />
                    `
                    : html`<span className="file-name">${f.name}</span>`}
                </span>
                <span className="file-col-size">${tree.formatFileSize(f.size)}</span>
                <span className="file-col-date">${tree.formatFileDate(f.modTime)}</span>
                <span className="file-col-actions">
                  ${confirmingDelete === f.name
                    ? html`
                      <span className="file-delete-confirm" onClick=${(e) => e.stopPropagation()}>
                        <span>Delete?</span>
                        <button className="file-delete-confirm-btn" onClick=${() => { onDelete(f.name); setConfirmingDelete(null); }}>Yes</button>
                        <button className="file-delete-cancel-btn" onClick=${() => setConfirmingDelete(null)}>No</button>
                      </span>
                    `
                    : html`
                      <span className="file-row-actions" onClick=${(e) => e.stopPropagation()}>
                        <button className="file-action-btn" title="Rename" onClick=${() => startRename(f.name)}><${IconPencil} /></button>
                        <button className="file-action-btn file-action-danger" title="Delete" onClick=${() => setConfirmingDelete(f.name)}><${IconTrash} /></button>
                      </span>
                    `}
                </span>
              </div>
            `)}
          </div>
          <div className="file-create">
            <input className="file-create-input" placeholder="new-file.org"
                   value=${newName} onChange=${(e) => setNewName(e.target.value)}
                   onKeyDown=${(e) => {
                     if (e.key === "Enter" && newName.trim()) {
                       onCreate(newName.trim());
                       setNewName("");
                     }
                   }} />
            <button className="file-create-btn" onClick=${() => {
              if (newName.trim()) { onCreate(newName.trim()); setNewName(""); }
            }}>Create</button>
          </div>
        `
        : html`
          <div className="fp-nav-list">
            ${navLoading && html`<div className="fp-nav-loading">Loading…</div>`}
            ${!navLoading && navParent !== null && html`
              <div className="fp-nav-item fp-nav-dir" onClick=${() => fetchNav(navParent)}>
                <span className="fp-nav-icon">📁</span>
                <span className="fp-nav-name">..</span>
              </div>
            `}
            ${!navLoading && navDirs.map((d) => html`
              <div className="fp-nav-item fp-nav-dir" key=${"d:" + d} onClick=${() => fetchNav(navPath + "/" + d)}>
                <span className="fp-nav-icon">📁</span>
                <span className="fp-nav-name">${d}</span>
              </div>
            `)}
            ${!navLoading && navFiles.map((f) => html`
              <div className="fp-nav-item fp-nav-file" key=${"f:" + f} onClick=${() => { onSelect(navPath + "/" + f); onClose && onClose(); }}>
                <span className="fp-nav-icon">📄</span>
                <span className="fp-nav-name">${f}</span>
              </div>
            `)}
            ${!navLoading && navDirs.length === 0 && navFiles.length === 0 && html`
              <div className="fp-nav-empty">No .org files or folders here</div>
            `}
          </div>
        `
      }

      <div className="file-picker-footer">
        ${!atWorkspace && html`
          <button className="file-picker-browse-btn" onClick=${() => fetchNav(null)}
                  title="Return to workspace folder">
            ↵ Back to workspace
          </button>
        `}
        ${atWorkspace && onChangeHomeFolder && html`
          <button className="file-picker-change-folder" onClick=${onChangeHomeFolder}
                  title="Switch to a different workspace folder">
            ⌂ Change home folder…
          </button>
        `}
      </div>
    </div>
  `;
}

// --- Sidebar (Favorites / Recent Files / Bookmarks) ---

function SidebarGlobalBookmarkRow({ entry, onNavigate, onDelete, onDragStart, onDragOver, onDrop }) {
  return html`
    <div className="sidebar-item sidebar-bookmark-item"
         draggable=${true}
         onDragStart=${onDragStart}
         onDragOver=${onDragOver}
         onDrop=${onDrop}>
      <span className="sidebar-drag-handle" title="Drag to reorder">☰</span>
      <span className="sidebar-item-main" onClick=${onNavigate} title=${entry.file}>
        <span className="sidebar-item-name">${entry.name}</span>
      </span>
      <button className="sidebar-bookmark-delete"
              onClick=${(e) => { e.stopPropagation(); onDelete(); }}
              title="Remove bookmark">×</button>
    </div>
  `;
}

function SidebarBookmarkRow({ entry, onNavigate, onDelete, onDragStart, onDragOver, onDrop }) {
  return html`
    <div className="sidebar-item sidebar-bookmark-item"
         draggable=${true}
         onDragStart=${onDragStart}
         onDragOver=${onDragOver}
         onDrop=${onDrop}>
      <span className="sidebar-drag-handle" title="Drag to reorder">☰</span>
      <span className="sidebar-item-main" onClick=${onNavigate}>
        <span className="sidebar-item-name">${entry.bookmark}</span>
      </span>
      <button className="sidebar-bookmark-delete"
              onClick=${(e) => { e.stopPropagation(); onDelete(); }}
              title="Remove bookmark">×</button>
    </div>
  `;
}

function SidebarFileRow({ name, active, isFavorite, onSelect, onToggleFavorite, onRenameStart }) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef(null);
  const isExternal = name.startsWith("/");
  const displayName = isExternal ? pathBasename(name) : name;

  const startRename = (e) => {
    e.stopPropagation();
    setRenameValue(name);
    setRenaming(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  };
  const commitRename = () => {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed && trimmed !== name) onRenameStart?.(name, trimmed);
  };
  const cancelRename = () => { setRenaming(false); setRenameValue(""); };

  return html`
    <div className=${"sidebar-item" + (active ? " active" : "")}>
      ${renaming
        ? html`
          <input ref=${inputRef} className="sidebar-rename-input"
                 value=${renameValue}
                 onChange=${(e) => setRenameValue(e.target.value)}
                 onKeyDown=${(e) => {
                   if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                   if (e.key === "Escape") cancelRename();
                 }}
                 onBlur=${cancelRename} />`
        : html`
          <span className="sidebar-item-main" onClick=${() => onSelect(name)} title=${name}>
            <span className="sidebar-item-icon"><${IconDoc}/></span>
            <span className="sidebar-item-name">${displayName}</span>
          </span>
          ${!isExternal && html`<button className="sidebar-file-rename" onClick=${startRename} title="Rename file">✎</button>`}
          <button className=${"sidebar-star" + (isFavorite ? " sidebar-star-active" : "")}
                  onClick=${(e) => { e.stopPropagation(); onToggleFavorite(name); }}
                  title=${isFavorite ? "Remove from favorites" : "Add to favorites"}>
            ${isFavorite ? "★" : "☆"}
          </button>`
      }
    </div>
  `;
}

function Sidebar({ favorites, recentFiles, currentFile, onSelect, onToggleFavorite, bookmarks, onNavigateToBookmark, onDeleteBookmark, onReorderBookmarks, bookmarkPanelVisible, onToggleBookmarkPanel, textMode, onToggleSidebar, onOpenTodayJournal, onOpenJournalList, onRenameFile, onClearRecentFiles, onOpenQuickSwitcher, onOpenTextSearch, onOpenWorkspace, savedSearches, onRunSavedSearch, onDeleteSavedSearch, navPanelVisible, onToggleNavPanel }) {
  const dragIndexRef = useRef(null);
  const [renameConfirm, setRenameConfirm] = useState(null); // { oldName, newName }
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameResult, setRenameResult] = useState(null); // { filesChanged, replacements }

  const handleRenameStart = (oldName, newName) => setRenameConfirm({ oldName, newName });

  const confirmRename = async () => {
    if (!renameConfirm || renameBusy) return;
    setRenameBusy(true);
    try {
      const result = await onRenameFile(renameConfirm.oldName, renameConfirm.newName);
      setRenameResult(result);
    } catch {}
    setRenameConfirm(null);
    setRenameBusy(false);
  };

  return html`
    <div className="sidebar">
      <div className="panel-icon-strip">
        <button className="panel-toggle-btn active" onClick=${onToggleSidebar}
                title="Close sidebar"><${IconDoc} /></button>
        <button className=${"panel-toggle-btn" + (bookmarkPanelVisible && !textMode ? " active" : "")}
                onClick=${onToggleBookmarkPanel} disabled=${textMode}
                title=${textMode ? "Not available in reveal codes mode" : "Bookmark panel"}><${IconBookmark} /></button>
        <button className="panel-toggle-btn" onClick=${onOpenQuickSwitcher}
                title="Quick switcher (Ctrl+K)"><${IconLightning} /></button>
        <button className="panel-toggle-btn" onClick=${onOpenTextSearch}
                title="Full-text search across all files (Ctrl+Shift+F)"><${IconSearch} /></button>
        <button className="panel-toggle-btn" onClick=${onOpenWorkspace}
                title="Workspace paths — configure included/excluded folders"><${IconWorkspace} /></button>
        <button className=${"panel-toggle-btn" + (navPanelVisible ? " active" : "")}
                onClick=${onToggleNavPanel} disabled=${textMode}
                title=${textMode ? "Not available in reveal codes mode" : "Toggle navigation panel"}><${IconNavPanel} /></button>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-icon">✎</span>
          <span>Journal</span>
        </div>
        <div className="sidebar-item" onClick=${onOpenTodayJournal}>
          <span className="sidebar-item-main">
            <span className="sidebar-item-icon"><${IconJournal} /></span>
            <span className="sidebar-item-name">Today's Journal</span>
          </span>
        </div>
        <div className="sidebar-item" onClick=${onOpenJournalList}>
          <span className="sidebar-item-main">
            <span className="sidebar-item-icon"><${IconAgenda} /></span>
            <span className="sidebar-item-name">Journal List</span>
          </span>
        </div>
      </div>
      ${bookmarks.length > 0 && html`
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-section-icon">◇</span>
            <span>File Bookmarks</span>
          </div>
          ${bookmarks.map((bm, i) => html`
            <${SidebarBookmarkRow}
              key=${bm.bookmark}
              entry=${bm}
              onNavigate=${() => onNavigateToBookmark(bm)}
              onDelete=${() => onDeleteBookmark(bm.bookmark)}
              onDragStart=${() => { dragIndexRef.current = i; }}
              onDragOver=${(e) => e.preventDefault()}
              onDrop=${() => {
                const from = dragIndexRef.current;
                dragIndexRef.current = null;
                if (from === null || from === i) return;
                const names = bookmarks.map((b) => b.bookmark);
                names.splice(i, 0, names.splice(from, 1)[0]);
                onReorderBookmarks(names);
              }} />
          `)}
        </div>
      `}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-icon">⭐</span>
          <span>Saved Searches</span>
        </div>
        ${(!savedSearches || savedSearches.length === 0)
          ? html`<div className="sidebar-empty">Use ☆ in the search panel to save a query here</div>`
          : savedSearches.map((s) => html`
              <div key=${s.id} className="sidebar-item sidebar-saved-search" onClick=${() => onRunSavedSearch?.(s)}>
                <span className="sidebar-item-main">
                  <span className="sidebar-item-icon">⌕</span>
                  <span className="sidebar-item-name" title=${s.query + " (" + (s.scope === "note" ? "this file" : "all files") + ")"}>${s.name}</span>
                  <span className="sidebar-saved-search-scope">${s.scope === "note" ? "file" : "all"}</span>
                </span>
                <button className="sidebar-saved-search-del" title="Delete saved search"
                        onClick=${(e) => { e.stopPropagation(); onDeleteSavedSearch?.(s.id); }}>×</button>
              </div>
            `)
        }
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-icon">☆</span>
          <span>Favorites</span>
        </div>
        ${favorites.length === 0
          ? html`<div className="sidebar-empty">Star a file to pin it here</div>`
          : favorites.map((name) => html`
              <${SidebarFileRow} key=${"fav-" + name} name=${name} active=${name === currentFile}
                isFavorite=${true} onSelect=${onSelect} onToggleFavorite=${onToggleFavorite}
                onRenameStart=${handleRenameStart} />
            `)}
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-icon">↺</span>
          <span style=${{flex:1}}>Recent</span>
          ${recentFiles.length > 0 && html`
            <button className="sidebar-clear-btn" title="Clear recent file list" onClick=${onClearRecentFiles}>✕</button>
          `}
        </div>
        ${recentFiles.length === 0
          ? html`<div className="sidebar-empty">No recent files</div>`
          : recentFiles.map((name) => html`
              <${SidebarFileRow} key=${"recent-" + name} name=${name} active=${name === currentFile}
                isFavorite=${favorites.includes(name)} onSelect=${onSelect} onToggleFavorite=${onToggleFavorite}
                onRenameStart=${handleRenameStart} />
            `)}
      </div>
      ${renameResult && html`
        <div className="sidebar-rename-result" onClick=${() => setRenameResult(null)}>
          Links updated in ${renameResult.filesChanged} file${renameResult.filesChanged !== 1 ? "s" : ""}
          (${renameResult.replacements} link${renameResult.replacements !== 1 ? "s" : ""}) ×
        </div>
      `}
      ${renameConfirm && html`
        <div className="rename-tag-overlay" onClick=${(e) => { if (e.target === e.currentTarget && !renameBusy) setRenameConfirm(null); }}>
          <div className="rename-tag-dialog">
            <div className="rename-tag-title">Rename File</div>
            <div className="rename-tag-msg">
              Rename <strong>${renameConfirm.oldName}</strong> to <strong>${renameConfirm.newName}</strong>
              and update all links to it in the home folder?
            </div>
            <div className="rename-tag-actions">
              <button className="rename-tag-btn-confirm" onClick=${confirmRename} disabled=${renameBusy}>
                ${renameBusy ? "Renaming…" : "Rename + Update Links"}
              </button>
              <button className="rename-tag-btn-cancel" onClick=${() => setRenameConfirm(null)} disabled=${renameBusy}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

// --- App ---

const RECENT_FILES_LIMIT = 8;
const UNDO_LIMIT = 100;
// Actions that change document content, in dispatch order — only these get
// an undo snapshot. Navigation/focus actions and collapse/expand (a view
// state, not content) are deliberately excluded.
const UNDOABLE_ACTIONS = new Set([
  "change-preamble", "change", "change-body", "update-properties", "update-tags", "update-bookmarks",
  "set-status", "set-priority", "cycle-status", "new-sibling", "new-sibling-before", "delete", "duplicate", "indent", "outdent", "move-up", "move-down",
  "indent-only", "outdent-only", "move-up-only", "move-down-only",
  "split-at-cursor", "split-body-at-cursor", "join-with-next",
]);
// Of those, typing actions get debounced into one undo step per "burst"
// rather than one per keystroke.
const COALESCE_UNDO_ACTIONS = new Set(["change", "change-body", "change-preamble"]);
const UNDO_COALESCE_MS = 800;

// A single heading row in the Navigation panel — title only, no body text.
// Expand/collapse here is local UI state, independent of the document's own
// node.collapsed (browsing the table of contents shouldn't alter the actual
// outline's fold state or mark the document dirty).
function NavPanelNode({ node, depth, expandedIds, onToggleExpand, onJump, wrapMode }) {
  const hasKids = node.children?.length > 0;
  const isExpanded = expandedIds.has(node.id);
  return html`
    <div className="nav-panel-item">
      <div className="nav-panel-row" style=${{ paddingLeft: (depth * 14) + "px" }}>
        ${hasKids
          ? html`<button className="nav-panel-tog" onClick=${() => onToggleExpand(node.id)} title=${isExpanded ? "Collapse" : "Expand"}>${isExpanded ? "▼" : "▶"}</button>`
          : html`<span className="nav-panel-leaf"></span>`}
        <span className=${"nav-panel-label" + (wrapMode ? " wrap" : " truncate")}
              onClick=${() => onJump(node.id)}
              title=${node.title || "(untitled)"}
              dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(node.title || "(untitled)") }}>
        </span>
      </div>
      ${hasKids && isExpanded && html`
        <div className="nav-panel-children">
          ${node.children.map((child) => html`
            <${NavPanelNode} key=${child.id} node=${child} depth=${depth + 1}
              expandedIds=${expandedIds} onToggleExpand=${onToggleExpand}
              onJump=${onJump} wrapMode=${wrapMode} />
          `)}
        </div>
      `}
    </div>
  `;
}

function NavPanel({ nodes, wrapMode, onToggleWrap, onJump, onClose }) {
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const onToggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  return html`
    <div className="nav-panel">
      <div className="nav-panel-header">
        <span>Navigation</span>
        <div className="nav-panel-header-actions">
          <button className="nav-panel-wrap-btn" onClick=${onToggleWrap}
                  title=${wrapMode ? "Show one line per heading (truncated)" : "Wrap headings to show full text"}>
            ${wrapMode ? "Truncate" : "Wrap"}
          </button>
          <button className="nav-panel-close" onClick=${onClose} title="Close navigation panel">×</button>
        </div>
      </div>
      <div className="nav-panel-list">
        ${(nodes || []).length === 0
          ? html`<div className="nav-panel-empty">No headings</div>`
          : (nodes || []).map((n) => html`
              <${NavPanelNode} key=${n.id} node=${n} depth=${0}
                expandedIds=${expandedIds} onToggleExpand=${onToggleExpand}
                onJump=${onJump} wrapMode=${wrapMode} />
            `)}
      </div>
    </div>
  `;
}

function FootnotePopup({ popup, onClose, onSave }) {
  const [text, setText] = useState(popup.text || "");
  const [dirty, setDirty] = useState(false);
  const taRef = useRef(null);

  useEffect(() => { taRef.current?.focus(); }, []);

  const save = useCallback(() => {
    if (dirty && text.trim()) onSave(popup.label, text.trim());
    onClose();
  }, [dirty, text, popup.label, onSave, onClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    };
    const onDown = (e) => { if (!e.target.closest(".fn-popup")) onClose(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [save, onClose]);

  const margin = 12, popW = 360;
  const x = Math.max(margin, Math.min(popup.x - popW / 2, window.innerWidth - popW - margin));
  const estH = 170;
  const y = popup.y + 16 + estH > window.innerHeight ? popup.y - estH - 8 : popup.y + 16;

  return html`
    <div className="fn-popup" style=${{ left: x, top: y, width: popW + "px" }}>
      <div className="fn-popup-header">
        <code className="fn-popup-label">[fn:${popup.label}]</code>
        ${popup.notFound && html`<span className="fn-popup-notfound">not yet defined</span>`}
        <button className="fn-popup-close" onClick=${onClose}>×</button>
      </div>
      <textarea
        ref=${taRef}
        className="fn-popup-textarea"
        value=${text}
        rows=${3}
        placeholder="Enter footnote definition…"
        onInput=${(e) => { setText(e.target.value); setDirty(true); }}
      />
      <div className="fn-popup-footer">
        <span className="fn-popup-hint">Ctrl+Enter to save</span>
        <button className="fn-popup-cancel" onClick=${onClose}>Cancel</button>
        <button className="fn-popup-save" onClick=${save} disabled=${!dirty || !text.trim()}>Save</button>
      </div>
    </div>
  `;
}

function FootnoteInsertPopup({ popup, onInsert, onClose }) {
  const [def, setDef] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const confirm = useCallback(() => onInsert(def), [def, onInsert]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirm(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirm, onClose]);

  return html`
    <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fn-insert-dialog">
        <div className="fn-insert-header">
          <span>Insert Footnote <code className="fn-popup-label">[fn:${popup.label}]</code></span>
          <button className="folder-picker-close" onClick=${onClose}>×</button>
        </div>
        <p className="fn-insert-hint">
          The reference <code>[fn:${popup.label}]</code> will be inserted at your cursor.
          Type a citation or stub below — it will be appended to the same note.
        </p>
        <textarea
          ref=${inputRef}
          className="fn-insert-textarea"
          placeholder="e.g. Diogenes Laertius, 10.3 (leave blank for a placeholder)"
          value=${def}
          rows=${3}
          onInput=${(e) => setDef(e.target.value)}
        />
        <div className="fn-insert-footer">
          <button className="fn-insert-cancel" onClick=${onClose}>Cancel</button>
          <button className="fn-insert-confirm" onClick=${confirm}>Insert</button>
        </div>
      </div>
    </div>
  `;
}

function WorkspaceSettingsPanel({
  homeDir, homeFile, journalDir, tagListFile, bookmarkListFile, currentFile,
  statusBarVisible, onToggleStatusBar,
  onChangeHomeDir, onChangeJournalDir, onClearJournalDir,
  onChangeTagListFile, onClearTagListFile,
  onChangeBookmarkListFile, onClearBookmarkListFile,
  onSetHomeFile,
  onClose,
}) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const Row = ({ label, value, onPick, onClear, extra }) => html`
    <div className="wsp-row">
      <span className="wsp-label">${label}</span>
      <span className="wsp-value" title=${value || ""}>${value || html`<em>not set</em>`}</span>
      <div className="wsp-actions">
        ${extra}
        ${onPick && html`<button className="wsp-btn" onClick=${onPick}>Change…</button>`}
        ${onClear && value && html`<button className="wsp-btn wsp-btn-clear" onClick=${onClear} title="Clear">×</button>`}
      </div>
    </div>
  `;

  return html`
    <div className="wsp-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wsp-panel">
        <div className="wsp-header">
          <span className="wsp-title">Workspace Settings</span>
          <button className="oap-close" onClick=${onClose}>×</button>
        </div>
        <${Row} label="Home Folder" value=${homeDir} onPick=${onChangeHomeDir} />
        <${Row} label="Home File" value=${homeFile}
          extra=${html`
            <button className="wsp-btn" disabled=${!currentFile}
                    onClick=${() => { onSetHomeFile(currentFile); onClose(); }}
                    title=${currentFile ? "Set \"" + currentFile + "\" as home file" : "Open a file first"}>
              Set current
            </button>
          `}
          onClear=${() => { onSetHomeFile(null); onClose(); }} />
        <${Row} label="Journal Folder" value=${journalDir || "(same as home folder)"}
          onPick=${onChangeJournalDir}
          onClear=${journalDir ? onClearJournalDir : null} />
        <${Row} label="Tag List File" value=${tagListFile || "(default)"}
          onPick=${onChangeTagListFile}
          onClear=${tagListFile ? onClearTagListFile : null} />
        <${Row} label="Bookmark List File" value=${bookmarkListFile || "(default)"}
          onPick=${onChangeBookmarkListFile}
          onClear=${bookmarkListFile ? onClearBookmarkListFile : null} />
        <div className="wsp-row">
          <span className="wsp-label">Status Bar</span>
          <span className="wsp-value">${statusBarVisible ? "Visible" : "Hidden"}</span>
          <div className="wsp-actions">
            <button className="wsp-btn" onClick=${onToggleStatusBar}>
              ${statusBarVisible ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function StatusBar({ currentFile, homeDir, journalDir, tagListFile, bookmarkListFile, onOpenSettings }) {
  const journalLabel = journalDir ? journalDir : "(workspace default)";
  // Build full absolute path: currentFile is relative when opened from the
  // workspace file list, absolute when opened via the filesystem navigator.
  const fullFilePath = currentFile
    ? (currentFile.startsWith("/") ? currentFile : (homeDir ? homeDir + "/" + currentFile : currentFile))
    : "—";
  return html`
    <div className="status-bar">
      <span className="status-bar-item">
        <span className="status-bar-label">File</span>
        ${fullFilePath}
      </span>
      <span className="status-bar-sep" />
      <span className="status-bar-item">
        <span className="status-bar-label">Home Folder</span>
        ${homeDir || "—"}
      </span>
      <span className="status-bar-sep" />
      <span className="status-bar-item">
        <span className="status-bar-label">Journal</span>
        ${journalLabel}
      </span>
      <span className="status-bar-sep" />
      <span className="status-bar-item">
        <span className="status-bar-label">Tag List</span>
        ${tagListFile || "—"}
      </span>
      <span className="status-bar-sep" />
      <span className="status-bar-item">
        <span className="status-bar-label">Bookmark List</span>
        ${bookmarkListFile || "—"}
      </span>
      <button className="status-bar-settings-btn" onClick=${onOpenSettings} title="Workspace settings">⚙</button>
    </div>
  `;
}

function parseFormatFromPreamble(text) {
  const fmtMatch = (text || "").match(/^#\+EPICORG_FORMAT:\s*(\S+)/mi);
  const lvlMatch = (text || "").match(/^#\+EPICORG_LEVEL_FORMATS:\s*(.+)/mi);
  const fmt = fmtMatch ? fmtMatch[1].trim() : null;
  const levelFmts = {};
  if (lvlMatch) {
    lvlMatch[1].trim().split(",").forEach(pair => {
      const [d, f] = pair.trim().split(":");
      const depth = parseInt(d, 10);
      if (!isNaN(depth) && f) levelFmts[depth] = f.trim();
    });
  }
  return { fmt, levelFmts };
}

function applyFormatToPreamble(text, outlineFormat, levelFormats) {
  let result = (text || "")
    .replace(/^#\+EPICORG_FORMAT:[^\n]*\n?/mi, "")
    .replace(/^#\+EPICORG_LEVEL_FORMATS:[^\n]*\n?/mi, "");

  // Keep #+STARTUP: num in sync with the numbers format for Emacs org-num-mode.
  const startupMatch = result.match(/^#\+STARTUP:([ \t]*)(.*)$/mi);
  if (outlineFormat === "numbers") {
    if (startupMatch) {
      const tokens = startupMatch[2].trim().split(/\s+/).filter(Boolean);
      if (!tokens.includes("num"))
        result = result.replace(/^#\+STARTUP:.*$/mi, `#+STARTUP: ${[...tokens, "num"].join(" ")}`);
    } else {
      result = "#+STARTUP: num\n" + result;
    }
  } else if (startupMatch) {
    const tokens = startupMatch[2].trim().split(/\s+/).filter(t => t !== "num");
    result = tokens.length === 0
      ? result.replace(/^#\+STARTUP:[^\n]*\n?/mi, "")
      : result.replace(/^#\+STARTUP:.*$/mi, `#+STARTUP: ${tokens.join(" ")}`);
  }

  const lines = [];
  if (outlineFormat && outlineFormat !== "bullets") lines.push(`#+EPICORG_FORMAT: ${outlineFormat}`);
  const hasLvl = levelFormats && Object.keys(levelFormats).length > 0;
  if (hasLvl) {
    const lvlStr = Object.entries(levelFormats)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([d, f]) => `${d}:${f}`).join(",");
    lines.push(`#+EPICORG_LEVEL_FORMATS: ${lvlStr}`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" + result : result;
}

// ─── Typography: fonts & heading colors ──────────────────────────────────────
const FONT_GROUPS = [
  { group: "Sans-serif", fonts: [
    { id: "inter",         label: "Inter",           css: "Inter, 'Helvetica Neue', Arial, sans-serif" },
    { id: "system",        label: "System UI",        css: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    { id: "arial",         label: "Arial",            css: "Arial, Helvetica, sans-serif" },
    { id: "calibri",       label: "Calibri",          css: "Calibri, Candara, sans-serif" },
    { id: "candara",       label: "Candara",          css: "Candara, Calibri, sans-serif" },
    { id: "corbel",        label: "Corbel",           css: "Corbel, sans-serif" },
    { id: "franklin",      label: "Franklin Gothic",  css: "'Franklin Gothic Medium', Arial, sans-serif" },
    { id: "gill-sans",     label: "Gill Sans",        css: "'Gill Sans', 'Gill Sans MT', sans-serif" },
    { id: "helvetica",     label: "Helvetica",        css: "Helvetica, Arial, sans-serif" },
    { id: "lucida-grande", label: "Lucida Grande",    css: "'Lucida Grande', 'Lucida Sans Unicode', sans-serif" },
    { id: "optima",        label: "Optima",           css: "Optima, Segoe, sans-serif" },
    { id: "segoe-ui",      label: "Segoe UI",         css: "'Segoe UI', Tahoma, sans-serif" },
    { id: "tahoma",        label: "Tahoma",           css: "Tahoma, Geneva, sans-serif" },
    { id: "trebuchet",     label: "Trebuchet MS",     css: "'Trebuchet MS', Helvetica, sans-serif" },
    { id: "verdana",       label: "Verdana",          css: "Verdana, Geneva, sans-serif" },
  ]},
  { group: "Serif", fonts: [
    { id: "baskerville",   label: "Baskerville",      css: "Baskerville, 'Baskerville Old Face', serif" },
    { id: "book-antiqua",  label: "Book Antiqua",     css: "'Book Antiqua', Palatino, serif" },
    { id: "cambria",       label: "Cambria",          css: "Cambria, Georgia, serif" },
    { id: "constantia",    label: "Constantia",       css: "Constantia, Palatino, serif" },
    { id: "garamond",      label: "Garamond",         css: "Garamond, serif" },
    { id: "georgia",       label: "Georgia",          css: "Georgia, 'Times New Roman', serif" },
    { id: "palatino",      label: "Palatino",         css: "'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
    { id: "times",         label: "Times New Roman",  css: "'Times New Roman', Times, serif" },
  ]},
  { group: "Monospace", fonts: [
    { id: "consolas",       label: "Consolas",         css: "Consolas, 'Courier New', monospace" },
    { id: "courier",        label: "Courier New",      css: "'Courier New', Courier, monospace" },
    { id: "lucida-console", label: "Lucida Console",   css: "'Lucida Console', Monaco, monospace" },
    { id: "menlo",          label: "Menlo",            css: "Menlo, Monaco, 'Courier New', monospace" },
  ]},
];
const FONTS = FONT_GROUPS.flatMap(g => g.fonts);
const FONT_CSS = Object.fromEntries(FONTS.map(f => [f.id, f.css]));

// 12-color palette that reads well on both light and dark backgrounds.
const COLOR_PALETTE = [
  "#c0392b", "#d35400", "#b7950b", "#1e8449",
  "#16a085", "#2980b9", "#7d3c98", "#2c3e50",
  "#e74c3c", "#27ae60", "#1a5276", "#616a6b",
];

function parseFontsFromPreamble(text) {
  const m = (text || "").match(/^#\+EPICORG_FONTS:\s*(.+)/mi);
  if (!m) return { global: null, levels: {} };
  try { const d = JSON.parse(m[1].trim()); return { global: d.global || null, levels: d.levels || {} }; }
  catch { return { global: null, levels: {} }; }
}

function parseColorsFromPreamble(text) {
  const m = (text || "").match(/^#\+EPICORG_COLORS:\s*(.+)/mi);
  if (!m) return { global: null, levels: {} };
  try { const d = JSON.parse(m[1].trim()); return { global: d.global || null, levels: d.levels || {} }; }
  catch { return { global: null, levels: {} }; }
}

function applyFontsToPreamble(text, globalFont, levelFonts) {
  let result = (text || "").replace(/^#\+EPICORG_FONTS:[^\n]*\n?/mi, "");
  const hasLvl = levelFonts && Object.keys(levelFonts).length > 0;
  if (globalFont || hasLvl) {
    result = `#+EPICORG_FONTS: ${JSON.stringify({ global: globalFont || "inter", levels: levelFonts || {} })}\n` + result;
  }
  return result;
}

function applyColorsToPreamble(text, globalColor, levelColors) {
  let result = (text || "").replace(/^#\+EPICORG_COLORS:[^\n]*\n?/mi, "");
  const hasLvl = levelColors && Object.keys(levelColors).length > 0;
  if (globalColor || hasLvl) {
    result = `#+EPICORG_COLORS: ${JSON.stringify({ global: globalColor || null, levels: levelColors || {} })}\n` + result;
  }
  return result;
}

function findInNodes(nodes, query) {
  const q = query.toLowerCase();
  const ids = [];
  const walk = (list) => {
    for (const node of list) {
      if ((node.title || "").toLowerCase().includes(q) || (node.body || "").toLowerCase().includes(q)) ids.push(node.id);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

function highlightMatch(text, query) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (!text || !query.trim()) return esc(text || "");
  const q = query.toLowerCase();
  const parts = [];
  let i = 0;
  while (i < text.length) {
    const idx = text.toLowerCase().indexOf(q, i);
    if (idx === -1) { parts.push(esc(text.slice(i))); break; }
    parts.push(esc(text.slice(i, idx)));
    parts.push(`<mark class="sp-mark">${esc(text.slice(idx, idx + query.length))}</mark>`);
    i = idx + query.length;
  }
  return parts.join("");
}

function countMatches(text, query) {
  if (!text || !query.trim()) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let count = 0, i = 0;
  while (true) {
    const idx = t.indexOf(q, i);
    if (idx === -1) break;
    count++;
    i = idx + q.length;
  }
  return count;
}

// Markdown search results (from the "include .md files" option) can't be
// opened through the normal org-file loader/preview — it parses everything
// as org syntax, so a markdown file would render wrong and, if edited and
// autosaved, get corrupted with org-ified content written back into it.
function isMarkdownFile(name) {
  return /\.md$/i.test(name || "");
}

function buildSnippet(text, query) {
  if (!text) return "";
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return text.slice(0, 120) + (text.length > 120 ? "…" : "");
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function findNodeWithAncestors(nodes, predicate, ancestors = []) {
  for (const node of nodes) {
    if (predicate(node)) return { node, ancestors };
    if (node.children?.length) {
      const found = findNodeWithAncestors(node.children, predicate, [...ancestors, node]);
      if (found) return found;
    }
  }
  return null;
}

// Search panel — sticky top section with three clearly-labelled mode tabs.
// Mode bar stays visible regardless of which tab is active.
// Find tab embeds the FindBar; Search tab shows a compact results list;
// Filter tab focuses the header search and shows a hint.
function SearchPanel({ nodes, currentFile, homeDir,
  findQuery, setFindQuery, findMatchIds, findIdx, findNavigate, findInputRef, setFindOpen,
  replaceQuery, setReplaceQuery, replaceCurrentMatch, replaceAllMatches, replaceMessage,
  filterQuery, setFilterQuery, onFoldToLevel,
  onNavigate, onJumpToNode, onClose,
  onSaveSearch, activeSavedSearch, onActiveSavedSearchConsumed }) {
  const [tab, setTab] = useState("search");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [includeMarkdown, setIncludeMarkdown] = useState(() => {
    try { return localStorage.getItem("epicorg.searchIncludeMarkdown") === "1"; } catch { return false; }
  });
  const toggleIncludeMarkdown = () => {
    setIncludeMarkdown((prev) => {
      const next = !prev;
      try { localStorage.setItem("epicorg.searchIncludeMarkdown", next ? "1" : "0"); } catch {}
      return next;
    });
  };
  const [results, setResults] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [contextNodes, setContextNodes] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  // Raw-text preview for markdown results — separate from contextNodes
  // since markdown isn't parsed into org nodes at all (see isMarkdownFile).
  const [mdPreview, setMdPreview] = useState(null);
  const [mdPreviewLoading, setMdPreviewLoading] = useState(false);
  const [mdMatchIdx, setMdMatchIdx] = useState(0);
  const [mdPathCopied, setMdPathCopied] = useState(false);
  const mdPreviewRef = useRef(null);
  const [panelHeight, setPanelHeight] = useState(380);
  const searchInputRef = useRef(null);
  const filterInputRef = useRef(null);
  const resultsRef = useRef(null);
  const debounceRef = useRef(null);
  const ctxCacheRef = useRef(new Map());
  const mdCacheRef = useRef(new Map());
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const heightAtDrag = useRef(0);

  useEffect(() => {
    const onMove = (e) => {
      if (!isDragging.current) return;
      const delta = e.clientY - dragStartY.current;
      setPanelHeight(Math.max(120, Math.min(window.innerHeight * 0.88, heightAtDrag.current + delta)));
    };
    const onUp = () => { isDragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const onResizeStart = (e) => {
    isDragging.current = true;
    dragStartY.current = e.clientY;
    heightAtDrag.current = panelHeight;
    e.preventDefault();
  };

  const switchTab = (t) => {
    if (t === tab) return;
    // Carry the current search term into the destination tab
    const carry = tab === "filter" ? filterQuery : tab === "find" ? findQuery : query;
    if (tab === "find") { setFindOpen(false); setFindQuery(""); }
    setTab(t);
    if (t === "find") {
      if (carry) setFindQuery(carry);
      setFindOpen(true);
      requestAnimationFrame(() => findInputRef.current?.focus());
    }
    if (t === "filter") {
      if (carry) setFilterQuery(carry);
      requestAnimationFrame(() => filterInputRef.current?.focus());
    }
    if (t === "search") {
      if (carry) setQuery(carry);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  };

  useEffect(() => { requestAnimationFrame(() => searchInputRef.current?.focus()); }, []);

  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  useEffect(() => {
    if (!activeSavedSearch) return;
    setTab("search");
    setQuery(activeSavedSearch.query);
    setScope(activeSavedSearch.scope || "all");
    onActiveSavedSearchConsumed?.();
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [activeSavedSearch]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (tab !== "search" || !query.trim()) { setResults([]); setSelectedIdx(0); return; }
    if (scope === "note") {
      const matches = [];
      const q = query.toLowerCase();
      const walk = (list, ancestors) => {
        for (const node of list) {
          const inTitle = (node.title || "").toLowerCase().includes(q);
          const inBody = (node.body || "").toLowerCase().includes(q);
          if (inTitle || inBody) {
            matches.push({
              nodeId: node.id,
              file: currentFile,
              title: node.title || "",
              breadcrumb: ancestors.map((a) => a.title),
              snippet: buildSnippet(inTitle ? node.title : node.body, query),
            });
          }
          if (node.children?.length) walk(node.children, [...ancestors, node]);
        }
      };
      walk(nodes, []);
      setResults(matches);
      setSelectedIdx(0);
    } else {
      debounceRef.current = setTimeout(() => {
        setLoading(true);
        const url = `/api/search/text?q=${encodeURIComponent(query)}` + (includeMarkdown ? "&md=1" : "");
        api.get(url)
          .then((data) => {
            setResults((data.results || []).map((r) => ({
              nodeId: null,
              file: r.file,
              title: r.title || "",
              breadcrumb: r.ancestors || [],
              snippet: r.context || "",
            })));
            setSelectedIdx(0);
          })
          .catch(() => setResults([]))
          .finally(() => setLoading(false));
      }, 280);
      return () => clearTimeout(debounceRef.current);
    }
  }, [tab, query, scope, nodes, currentFile, includeMarkdown]);

  useEffect(() => {
    resultsRef.current?.children[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const selected = results[selectedIdx] ?? null;

  useEffect(() => {
    if (!selected) { setContextNodes(null); return; }
    if (isMarkdownFile(selected.file)) { setContextNodes(null); return; }
    if (scope === "note") { setContextNodes(nodes); return; }
    if (ctxCacheRef.current.has(selected.file)) {
      setContextNodes(ctxCacheRef.current.get(selected.file)); return;
    }
    setContextLoading(true);
    api.get(`/api/doc/${encodeURIComponent(selected.file)}`)
      .then((d) => { const n = d.nodes || []; ctxCacheRef.current.set(selected.file, n); setContextNodes(n); })
      .catch(() => setContextNodes([]))
      .finally(() => setContextLoading(false));
  }, [selected?.nodeId, selected?.file, scope, nodes]);

  // Read-only raw-text preview for markdown results — fetched separately
  // from the org context above since markdown files are never parsed into
  // nodes (see isMarkdownFile / openResult for why they're not editable).
  useEffect(() => {
    if (!selected || !isMarkdownFile(selected.file)) { setMdPreview(null); return; }
    if (mdCacheRef.current.has(selected.file)) {
      setMdPreview(mdCacheRef.current.get(selected.file)); return;
    }
    setMdPreviewLoading(true);
    api.get(`/api/raw?file=${encodeURIComponent(selected.file)}`)
      .then((d) => { const c = d.content || ""; mdCacheRef.current.set(selected.file, c); setMdPreview(c); })
      .catch(() => setMdPreview(""))
      .finally(() => setMdPreviewLoading(false));
  }, [selected?.file]);

  const mdMatchCount = countMatches(mdPreview, query);

  const ctxFound = contextNodes && selected
    ? findNodeWithAncestors(contextNodes,
        selected.nodeId ? (n) => n.id === selected.nodeId : (n) => n.title === selected.title)
    : null;

  const ctxPreviewRef = useRef(null);

  // Current-match position within the selected result — used both to mark
  // one <mark> distinctly (highlightMatch renders every match, all at once)
  // and to know, from the global nav buttons below, whether stepping past
  // the end/start of this result should just move the index or advance to
  // the next/previous result entirely.
  const [ctxMatchIdx, setCtxMatchIdx] = useState(0);

  const ctxMatchCount = ctxFound
    ? countMatches(ctxFound.node.title, query) + countMatches(ctxFound.node.body, query)
    : 0;

  // When global nav moves to a different result, whether that result should
  // open on its first match (stepping forward) or its last (stepping
  // backward) — the target result's match count isn't known until its
  // context/preview finishes loading, so this is consumed by the reset
  // effects below rather than computed synchronously in globalNext/Prev.
  const [landOnLastMatch, setLandOnLastMatch] = useState(false);

  useEffect(() => {
    if (!selected || !isMarkdownFile(selected.file)) return;
    const count = countMatches(mdPreview, query);
    setMdMatchIdx(landOnLastMatch ? Math.max(0, count - 1) : 0);
    setLandOnLastMatch(false);
  }, [mdPreview, selected?.file, query]);

  useEffect(() => {
    // Deliberately depends on contextNodes (stable — only changes reference
    // when setContextNodes actually runs), not the derived ctxFound, which
    // is a brand-new object literal every render and would re-fire this
    // effect (and reset the index back to 0) after every single render.
    if (!selected || isMarkdownFile(selected.file) || !ctxFound) return;
    const count = countMatches(ctxFound.node.title, query) + countMatches(ctxFound.node.body, query);
    setCtxMatchIdx(landOnLastMatch ? Math.max(0, count - 1) : 0);
    setLandOnLastMatch(false);
  }, [contextNodes, selected?.file, selected?.nodeId, query]);

  // Highlighting is all-matches-at-once via dangerouslySetInnerHTML (see
  // highlightMatch), so "jump to the Nth match" is done post-render: mark
  // the current <mark> distinctly and scroll it into view.
  useEffect(() => {
    const container = mdPreviewRef.current;
    if (!container) return;
    const marks = container.querySelectorAll("mark.sp-mark");
    marks.forEach((m, i) => m.classList.toggle("sp-mark-current", i === mdMatchIdx));
    marks[mdMatchIdx]?.scrollIntoView({ block: "center" });
  }, [mdPreview, mdMatchIdx, query]);

  useEffect(() => {
    // See the contextNodes-vs-ctxFound note above — same reasoning applies
    // here: depending on ctxFound would re-run this (and force-scroll) after
    // every render, fighting any manual scrolling the user does.
    const container = ctxPreviewRef.current;
    if (!container) return;
    const marks = container.querySelectorAll("mark.sp-mark");
    marks.forEach((m, i) => m.classList.toggle("sp-mark-current", i === ctxMatchIdx));
    marks[ctxMatchIdx]?.scrollIntoView({ block: "center" });
  }, [contextNodes, ctxMatchIdx, query]);

  // Global match nav — lives in the search row (next to This file/All
  // files), not per-result. Steps through every occurrence in the selected
  // result first; once at the end (or start), it moves to the next
  // (or previous) result in the list and lands on that result's first
  // (or last) match, wrapping around the whole result list.
  const isSelectedMd = selected && isMarkdownFile(selected.file);
  const curMatchIdx = isSelectedMd ? mdMatchIdx : ctxMatchIdx;
  const curMatchCount = isSelectedMd ? mdMatchCount : ctxMatchCount;

  const globalMatchNext = () => {
    if (results.length === 0) return;
    if (curMatchCount > 0 && curMatchIdx < curMatchCount - 1) {
      if (isSelectedMd) setMdMatchIdx((i) => i + 1); else setCtxMatchIdx((i) => i + 1);
      return;
    }
    if (results.length <= 1) return;
    setLandOnLastMatch(false);
    setSelectedIdx((i) => (i + 1) % results.length);
  };

  const globalMatchPrev = () => {
    if (results.length === 0) return;
    if (curMatchCount > 0 && curMatchIdx > 0) {
      if (isSelectedMd) setMdMatchIdx((i) => i - 1); else setCtxMatchIdx((i) => i - 1);
      return;
    }
    if (results.length <= 1) return;
    setLandOnLastMatch(true);
    setSelectedIdx((i) => (i - 1 + results.length) % results.length);
  };

  const openResult = (r) => {
    if (!r || isMarkdownFile(r.file)) return;
    onClose();
    if (scope === "all") { onNavigate(r.file); }
    else if (r.nodeId) { requestAnimationFrame(() => onJumpToNode(r.nodeId)); }
  };

  const openSelected = () => openResult(selected);

  const onSearchKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); openResult(results[selectedIdx]); return; }
  };

  return html`
    <div className="search-panel" style=${{ height: panelHeight + "px" }}>
      <div className="sp-mode-bar">
        <button className=${"sp-mode-btn" + (tab === "filter" ? " sp-mode-active" : "")}
                onClick=${() => switchTab("filter")}>
          <span className="sp-mode-name">⊟ Filter Headings</span>
          <span className="sp-mode-hint">collapses non-matching headings · depth 1|2|3|4</span>
        </button>
        <button className=${"sp-mode-btn" + (tab === "find" ? " sp-mode-active" : "")}
                onClick=${() => switchTab("find")}>
          <span className="sp-mode-name">⌕ Find in this file</span>
          <span className="sp-mode-hint">highlights every match · navigate with ↑↓ · Ctrl+F</span>
        </button>
        <button className=${"sp-mode-btn" + (tab === "search" ? " sp-mode-active" : "")}
                onClick=${() => switchTab("search")}>
          <span className="sp-mode-name">≡ Search all files</span>
          <span className="sp-mode-hint">full-text across every file in this workspace</span>
        </button>
        <button className="sp-close-btn" onClick=${() => { if (tab === "find") { setFindOpen(false); setFindQuery(""); } onClose(); }}>×</button>
      </div>

      ${tab === "filter" && html`
        <div className="sp-tab-body sp-filter-body">
          <div className="sp-filter-row">
            <input ref=${filterInputRef} type="search" className="sp-input"
                   placeholder="Filter headings…"
                   value=${filterQuery}
                   autoComplete="off" data-form-type="other" data-bwignore="true"
                   onInput=${(e) => setFilterQuery(e.target.value)}
                   onKeyDown=${(e) => { if (e.key === "Escape") { setFilterQuery(""); onClose(); } }} />
            ${filterQuery && html`
              <button className="sp-filter-clear" onClick=${() => setFilterQuery("")} title="Clear filter">×</button>
            `}
          </div>
          <div className="sp-filter-depth">
            <span className="sp-filter-depth-label">Fold to depth:</span>
            ${[1, 2, 3, 4].map((d) => html`
              <button key=${d} className="sp-depth-btn" onClick=${() => onFoldToLevel(d)}
                      title=${"Collapse outline to level " + d + " headings (Alt+" + d + ")"}>${d}</button>
            `)}
          </div>
        </div>
      `}

      ${tab === "find" && html`
        <${FindBar}
          query=${findQuery}
          matchCount=${findMatchIds.length}
          matchIdx=${findIdx}
          onQuery=${setFindQuery}
          onNext=${() => findNavigate(1)}
          onPrev=${() => findNavigate(-1)}
          onClose=${() => { switchTab("search"); }}
          inputRef=${findInputRef}
          replaceQuery=${replaceQuery}
          onReplaceQuery=${setReplaceQuery}
          onReplaceOne=${replaceCurrentMatch}
          onReplaceAll=${replaceAllMatches}
          replaceMessage=${replaceMessage} />
      `}

      ${tab === "search" && html`
        <div className="sp-tab-body sp-search-body">
          <div className="sp-input-row">
            <input ref=${searchInputRef} type="search" className="sp-input"
                   placeholder="Search…"
                   value=${query}
                   autoComplete="off" data-form-type="other" data-bwignore="true"
                   onInput=${(e) => setQuery(e.target.value)}
                   onKeyDown=${onSearchKeyDown} />
            ${query.trim() && html`
              <div className="sp-global-nav">
                <span className="sp-global-nav-count" title="Result position — not every occurrence within this result">
                  ${results.length > 0 ? `${selectedIdx + 1}/${results.length}` : ""}
                </span>
                <button className="find-bar-nav" onClick=${globalMatchPrev} disabled=${results.length === 0}
                        title="Previous match — steps through every occurrence in every result">↑</button>
                <button className="find-bar-nav" onClick=${globalMatchNext} disabled=${results.length === 0}
                        title="Next match — steps through every occurrence in every result">↓</button>
              </div>
            `}
            <div className="sp-scope">
              <button className=${"sp-scope-btn" + (scope === "note" ? " active" : "")}
                      onClick=${() => setScope("note")}>This file</button>
              <button className=${"sp-scope-btn" + (scope === "all" ? " active" : "")}
                      onClick=${() => setScope("all")}>All files</button>
            </div>
            ${query.trim() && html`
              <button className="sp-save-btn" title="Save this search"
                      onClick=${() => { setSaveName(query.trim()); setSaveFormOpen(true); }}>☆</button>
            `}
          </div>
          ${scope === "all" && html`
            <label className="sp-md-toggle">
              <input type="checkbox" checked=${includeMarkdown} onChange=${toggleIncludeMarkdown} />
              Include Markdown (.md) files
            </label>
          `}
          ${saveFormOpen && html`
            <div className="sp-save-form">
              <input className="sp-save-input" autoFocus
                     placeholder="Name this search…"
                     value=${saveName}
                     onInput=${(e) => setSaveName(e.target.value)}
                     onKeyDown=${(e) => {
                       if (e.key === "Enter" && saveName.trim()) {
                         onSaveSearch?.(saveName.trim(), query, scope);
                         setSaveFormOpen(false);
                       }
                       if (e.key === "Escape") setSaveFormOpen(false);
                     }} />
              <button className="sp-save-confirm"
                      disabled=${!saveName.trim()}
                      onClick=${() => { onSaveSearch?.(saveName.trim(), query, scope); setSaveFormOpen(false); }}>
                Save
              </button>
              <button className="sp-save-cancel" onClick=${() => setSaveFormOpen(false)}>Cancel</button>
            </div>
          `}
          <div className="sp-split">
            <div className="sp-results" ref=${resultsRef}>
              ${loading && html`<div className="sp-status">Searching…</div>`}
              ${!loading && !query.trim() && html`<div className="sp-status sp-status-idle">Type to search ${scope === "note" ? "this file" : "all files"}</div>`}
              ${!loading && query.trim() && results.length === 0 && html`<div className="sp-status">No matches</div>`}
              ${results.map((r, i) => html`
                <div key=${i}
                     className=${"sp-result" + (i === selectedIdx ? " selected" : "")}
                     onClick=${() => setSelectedIdx(i)}>
                  <div className="sp-result-body">
                    <div className="sp-result-crumb">
                      ${scope === "all" ? r.file.replace(/\.org$/, "") + (r.breadcrumb.length ? " › " : "") : ""}${r.breadcrumb.join(" › ")}
                      ${isMarkdownFile(r.file) && html`<span className="sp-result-md-badge" title="Markdown file — open manually">md</span>`}
                    </div>
                    <div className="sp-result-title"
                         dangerouslySetInnerHTML=${{ __html: highlightMatch(r.title, query) }} />
                    ${r.snippet && r.snippet !== r.title && html`
                      <div className="sp-result-snippet"
                           dangerouslySetInnerHTML=${{ __html: highlightMatch(r.snippet, query) }} />
                    `}
                  </div>
                  <button className="sp-result-open" title=${isMarkdownFile(r.file) ? "Markdown file — open manually" : "Open and close search panel"}
                          disabled=${isMarkdownFile(r.file)}
                          onClick=${(e) => { e.stopPropagation(); openResult(r); }}>↗</button>
                </div>
              `)}
            </div>
            <div className="sp-context">
              ${!selected && html`<div className="sp-ctx-empty">Select a result to see it in context</div>`}
              ${selected && isMarkdownFile(selected.file) && html`
                <div className="sp-ctx-inner">
                  <div className="sp-ctx-sticky">
                    <div className="sp-ctx-topbar sp-ctx-topbar-md">
                      <span className="sp-ctx-file sp-ctx-file-full" title="Click to copy"
                            onClick=${() => {
                              const full = selected.file.startsWith("/") ? selected.file : (homeDir ? homeDir + "/" + selected.file : selected.file);
                              navigator.clipboard?.writeText(full).then(() => {
                                setMdPathCopied(true);
                                setTimeout(() => setMdPathCopied(false), 1500);
                              }).catch(() => {});
                            }}>
                        ${selected.file.startsWith("/") ? selected.file : (homeDir ? homeDir + "/" + selected.file : selected.file)}
                        ${mdPathCopied && html`<span className="sp-ctx-copied">Copied!</span>`}
                      </span>
                      <span className="sp-ctx-md-note" title="Markdown files can't be opened for editing here — the loader parses everything as org and could corrupt them if saved back">Read-only preview</span>
                    </div>
                  </div>
                  ${mdPreviewLoading && html`<div className="sp-ctx-empty">Loading…</div>`}
                  ${!mdPreviewLoading && html`
                    <pre ref=${mdPreviewRef} className="sp-ctx-md-preview"
                         dangerouslySetInnerHTML=${{ __html: highlightMatch(mdPreview || "", query) }}></pre>
                  `}
                </div>
              `}
              ${selected && !isMarkdownFile(selected.file) && contextLoading && html`<div className="sp-ctx-empty">Loading…</div>`}
              ${selected && !isMarkdownFile(selected.file) && !contextLoading && !ctxFound && html`<div className="sp-ctx-empty">Node not found in current view</div>`}
              ${selected && ctxFound && html`
                <div className="sp-ctx-inner" ref=${ctxPreviewRef}>
                  <div className="sp-ctx-sticky">
                    <div className="sp-ctx-topbar">
                      ${scope === "all" && html`<span className="sp-ctx-file">${selected.file.replace(/\.org$/, "")}</span>`}
                      <button className="sp-ctx-open" onClick=${openSelected}>
                        ${scope === "all" ? "Open note →" : "Jump to →"}
                      </button>
                    </div>
                  </div>
                  ${ctxFound.ancestors.map((a, i) => html`
                    <div key=${i} className="sp-ctx-row sp-ctx-ancestor">
                      ${"  ".repeat(i)}<span className="sp-ctx-bullet">▸</span>
                      <span dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(a.title) }} />
                    </div>
                  `)}
                  <div className="sp-ctx-row sp-ctx-node">
                    ${"  ".repeat(ctxFound.ancestors.length)}<span className="sp-ctx-bullet sp-ctx-cur-bullet">▶</span>
                    <div className="sp-ctx-node-body">
                      <div className="sp-ctx-title"
                           dangerouslySetInnerHTML=${{ __html: highlightMatch(ctxFound.node.title, query) }} />
                      ${ctxFound.node.body && html`
                        <div className="sp-ctx-body"
                             dangerouslySetInnerHTML=${{ __html: highlightMatch(ctxFound.node.body, query) }} />
                      `}
                    </div>
                  </div>
                  ${(ctxFound.node.children || []).slice(0, 8).map((ch, i) => html`
                    <div key=${i} className="sp-ctx-row sp-ctx-child">
                      ${"  ".repeat(ctxFound.ancestors.length + 1)}<span className="sp-ctx-bullet">▸</span>
                      <span dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(ch.title) }} />
                    </div>
                  `)}
                  ${(ctxFound.node.children || []).length > 8 && html`
                    <div className="sp-ctx-more">…${ctxFound.node.children.length - 8} more children</div>
                  `}
                </div>
              `}
            </div>
          </div>
        </div>
      `}
      <div className="sp-resize-handle" onMouseDown=${onResizeStart} />
    </div>
  `;
}

function App() {
  const [files, setFiles] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [recentFiles, setRecentFiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem("epicorg.recentFiles") || "[]"); } catch { return []; }
  });
  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    try { localStorage.removeItem("epicorg.recentFiles"); } catch {}
  }, []);
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    try {
      const v = localStorage.getItem("epicorg.sidebarVisible");
      if (v === "0") return false;
      if (v === "1") return true;
      // No explicit preference yet — default open only on a wide enough screen.
      return window.innerWidth >= 900;
    } catch { return true; }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarVisible((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.sidebarVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [navPanelVisible, setNavPanelVisible] = useState(() => {
    try { return localStorage.getItem("epicorg.navPanelVisible") === "1"; } catch { return false; }
  });
  const toggleNavPanel = useCallback(() => {
    setNavPanelVisible((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.navPanelVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  // Whether each heading's label wraps to show the full text, or stays on a
  // single truncated line (with an ellipsis) — independent of the panel's
  // own expand/collapse state per node.
  const [navPanelWrap, setNavPanelWrap] = useState(() => {
    try { return localStorage.getItem("epicorg.navPanelWrap") === "1"; } catch { return false; }
  });
  const toggleNavPanelWrap = useCallback(() => {
    setNavPanelWrap((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.navPanelWrap", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  // Collapses the top bar down to a small clickable tab in the corner —
  // deliberately never a full "hide entirely" option, since that would take
  // the Settings/hamburger access away with it and leave no way back in
  // short of editing localStorage by hand.
  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    try { return localStorage.getItem("epicorg.headerCollapsed") === "1"; } catch { return false; }
  });
  const toggleHeaderCollapsed = useCallback(() => {
    setHeaderCollapsed((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.headerCollapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [currentFile, setCurrentFile] = useState(null);
  // True until the initial-mount auto-load attempt (last file / default file /
  // sole file) has settled. Keeps the loading screen up instead of flashing
  // the file picker while that file is still being fetched.
  const [autoLoadPending, setAutoLoadPending] = useState(true);
  // Forces the file picker open even though a file is already loaded —
  // used by the "switch file" back-button so Cancel can snap back to the
  // still-intact document instead of having to reload it.
  const [showPicker, setShowPicker] = useState(false);
  const [nodes, setNodes] = useState(null);
  const fnNavIndex = useMemo(() => tree.buildFootnoteIndex(nodes || []), [nodes]);
  const fnNavIndexRef = useRef(fnNavIndex);
  useEffect(() => { fnNavIndexRef.current = fnNavIndex; }, [fnNavIndex]);
  const [fnPopup, setFnPopup] = useState(null);
  const [preamble, setPreamble] = useState("");
  const [hash, setHash] = useState("");
  const [focusedId, setFocusedId] = useState(null);
  // Hoist ("zoom in"): isolates the outline to one node + its descendants.
  // Transient, per-file — not persisted, reset on every file load/switch.
  const [hoistedId, setHoistedId] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [syncStatus, setSyncStatus] = useState(SYNC_SAVED);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((msg, ms = 2000) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), ms);
  }, []);
  const [view, setView] = useState("outline");
  const [tagSearch, setTagSearch] = useState(null); // { tag, results } | null
  const pendingTagNavRef = useRef(null); // { file, title } to navigate to after load
  const pendingJumpIdRef = useRef(null);    // node id to jump+flash to after file loads
  const pendingJumpTitleRef = useRef(null); // node title to jump+flash to after file loads (for external agenda items)
  const [homeDir, setHomeDir] = useState(null);
  const [journalDir, setJournalDir] = useState(null); // null = not yet loaded; "" = default
  const [tagListFile, setTagListFile] = useState(null); // null = not yet loaded; "" = default
  const [bookmarkListFile, setBookmarkListFile] = useState(null); // null = not yet loaded; "" = default
  const [backupMaxVersions, setBackupMaxVersions] = useState(null); // null = not yet loaded; 0 = disabled
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showJournalFolderPicker, setShowJournalFolderPicker] = useState(false);
  const [showTagListFilePicker, setShowTagListFilePicker] = useState(false);
  const [showBookmarkListFilePicker, setShowBookmarkListFilePicker] = useState(false);
  const [showTextSearch, setShowTextSearch] = useState(false);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [workspaceConfig, setWorkspaceConfig] = useState(null);
  const [savedWorkspaceProfiles, setSavedWorkspaceProfiles] = useState([]);
  const [savedSearches, setSavedSearches] = useState(() => {
    try { return JSON.parse(localStorage.getItem("epicorg.savedSearches") || "[]"); } catch { return []; }
  });
  const [activeSavedSearch, setActiveSavedSearch] = useState(null);
  const saveSavedSearch = useCallback((name, query, scope) => {
    setSavedSearches((prev) => {
      const entry = { id: Date.now(), name, query, scope };
      const updated = [...prev, entry];
      localStorage.setItem("epicorg.savedSearches", JSON.stringify(updated));
      return updated;
    });
  }, []);
  const deleteSavedSearch = useCallback((id) => {
    setSavedSearches((prev) => {
      const updated = prev.filter((s) => s.id !== id);
      localStorage.setItem("epicorg.savedSearches", JSON.stringify(updated));
      return updated;
    });
  }, []);
  const runSavedSearch = useCallback((s) => {
    setActiveSavedSearch(s);
    setSearchPanelOpen(true);
  }, []);
  // Unified search results: { type: "tag"|"text", query, results } | null
  const [searchResults, setSearchResults] = useState(null);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const linkPickerTargetRef = useRef(null); // { textarea, cursorPos }
  const [showWikiPicker, setShowWikiPicker] = useState(false);
  const wikiPickerTargetRef = useRef(null); // { textarea, cursorPos }
  const [wikiEntries, setWikiEntries] = useState([]);
  const wikiEntriesRef = useRef([]);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [hoverPopup, setHoverPopup] = useState(null);
  const hoverTimerRef = useRef(null);
  const previewCacheRef = useRef(new Map());
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatchIds, setFindMatchIds] = useState([]);
  const [findIdx, setFindIdx] = useState(0);
  const findInputRef = useRef(null);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [replaceMessage, setReplaceMessage] = useState("");
  const [navState, navDispatch] = useReducer(navReducer, { history: [], index: -1 });
  const histNavRef = useRef(false); // true while back/forward is in progress (suppresses push)
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);
  const toggleTag = useCallback((tag) => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  }, []);
  const clearTags = useCallback(() => setSelectedTags([]), []);
  const [titleFormatMode, setTitleFormatMode] = useState(() => {
    try { const v = localStorage.getItem("epicorg.titleFormatMode"); return v === null ? true : v === "1"; } catch { return true; }
  });
  const toggleTitleFormatMode = useCallback(() => {
    setTitleFormatMode((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.titleFormatMode", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [notesVisible, setNotesVisible] = useState(() => {
    try { return localStorage.getItem("epicorg.notesVisible") !== "0"; } catch { return true; }
  });
  const toggleNotesVisible = useCallback(() => {
    setNotesVisible((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.notesVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [showTagChips, setShowTagChips] = useState(() => {
    try { return localStorage.getItem("epicorg.showTagChips") === "1"; } catch { return false; }
  });
  const toggleShowTagChips = useCallback(() => {
    setShowTagChips((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.showTagChips", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [tagsOnRight, setTagsOnRight] = useState(() => {
    try { return localStorage.getItem("epicorg.tagsOnRight") !== "0"; } catch { return true; }
  });
  const toggleTagsOnRight = useCallback(() => {
    setTagsOnRight((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.tagsOnRight", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  const [statusBarVisible, setStatusBarVisible] = useState(() => {
    try { return localStorage.getItem("epicorg.statusBarVisible") === "1"; } catch { return false; }
  });
  const toggleStatusBarVisible = useCallback(() => {
    setStatusBarVisible((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.statusBarVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  const outlineFormatRef = useRef("bullets");
  const [outlineFormat, setOutlineFormatRaw] = useState(() => {
    try {
      const saved = localStorage.getItem("epicorg.outlineFormat");
      if (saved === "numbers" || saved === "letters" || saved === "upper" || saved === "bullets") {
        outlineFormatRef.current = saved;
        return saved;
      }
      if (localStorage.getItem("epicorg.numberedBullets") === "1") {
        outlineFormatRef.current = "numbers";
        return "numbers";
      }
    } catch {}
    return "bullets";
  });
  const setOutlineFormat = useCallback((fmt) => {
    setOutlineFormatRaw(fmt);
    outlineFormatRef.current = fmt;
    try { localStorage.setItem("epicorg.outlineFormat", fmt); } catch {}
    setPreamble(p => applyFormatToPreamble(p, fmt, levelFormatsRef.current));
  }, []);

  const levelFormatsRef = useRef({});
  const [levelFormats, setLevelFormatsRaw] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("epicorg.levelFormats") || "{}");
      if (typeof saved === "object" && saved !== null) {
        levelFormatsRef.current = saved;
        return saved;
      }
    } catch {}
    return {};
  });
  const setLevelFormat = useCallback((depth, fmt) => {
    setLevelFormatsRaw(prev => {
      const next = { ...prev };
      if (fmt === null) delete next[depth]; else next[depth] = fmt;
      levelFormatsRef.current = next;
      try { localStorage.setItem("epicorg.levelFormats", JSON.stringify(next)); } catch {}
      setPreamble(p => applyFormatToPreamble(p, outlineFormatRef.current, next));
      return next;
    });
  }, []);

  // Font settings (stored in preamble + localStorage fallback)
  const globalFontRef = useRef(null);
  const [globalFont, setGlobalFontRaw] = useState(null);
  const setGlobalFont = useCallback((font) => {
    const val = (!font || font === "inter") ? null : font;
    setGlobalFontRaw(val);
    globalFontRef.current = val;
    setPreamble(p => applyFontsToPreamble(p, val, levelFontsRef.current));
  }, []);

  const levelFontsRef = useRef({});
  const [levelFonts, setLevelFontsRaw] = useState({});
  const setLevelFont = useCallback((depth, font) => {
    setLevelFontsRaw(prev => {
      const next = { ...prev };
      if (!font) delete next[depth]; else next[depth] = font;
      levelFontsRef.current = next;
      setPreamble(p => applyFontsToPreamble(p, globalFontRef.current, next));
      return next;
    });
  }, []);

  // Color settings (stored in preamble)
  const globalColorRef = useRef(null);
  const [globalColor, setGlobalColorRaw] = useState(null);
  const setGlobalColor = useCallback((color) => {
    setGlobalColorRaw(color || null);
    globalColorRef.current = color || null;
    setPreamble(p => applyColorsToPreamble(p, color || null, levelColorsRef.current));
  }, []);

  const levelColorsRef = useRef({});
  const [levelColors, setLevelColorsRaw] = useState({});
  const setLevelColor = useCallback((depth, color) => {
    setLevelColorsRaw(prev => {
      const next = { ...prev };
      if (!color) delete next[depth]; else next[depth] = color;
      levelColorsRef.current = next;
      setPreamble(p => applyColorsToPreamble(p, globalColorRef.current, next));
      return next;
    });
  }, []);

  const [verticalLines, setVerticalLines] = useState(() => {
    try { return localStorage.getItem("epicorg.verticalLines") === "1"; } catch { return false; }
  });
  const toggleVerticalLines = useCallback(() => {
    setVerticalLines((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.verticalLines", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [readingWidth, setReadingWidth] = useState(() => {
    try { const v = localStorage.getItem("epicorg.readingWidth"); return v === null ? true : v === "1"; } catch { return true; }
  });
  const toggleReadingWidth = useCallback(() => {
    setReadingWidth((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.readingWidth", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [toolbarConfig, setToolbarConfig] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TOOLBAR_CONFIG_KEY) || "{}");
      const merged = { ...TOOLBAR_DEFAULTS, ...saved };
      // Migrate old per-key undoRedoVisible if no new config saved yet
      if (!Object.prototype.hasOwnProperty.call(saved, "undoRedo")) {
        merged.undoRedo = localStorage.getItem("epicorg.undoRedoVisible") !== "0";
      }
      return merged;
    } catch { return { ...TOOLBAR_DEFAULTS }; }
  });
  const updateToolbarConfig = useCallback((key, val) => {
    setToolbarConfig((prev) => {
      const next = { ...prev, [key]: val };
      try { localStorage.setItem(TOOLBAR_CONFIG_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const [showToolbarCustomizer, setShowToolbarCustomizer] = useState(false);
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState("view");
  const [theme, setTheme] = useState(() => {
    try {
      const stored = localStorage.getItem("epicorg.theme");
      if (stored === "light" || stored === "dark") return stored;
    } catch {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("epicorg.theme", theme); } catch {}
  }, [theme]);

  // Insert footnote: capture cursor position, then show popup for definition stub.
  const [fnInsertPopup, setFnInsertPopup] = useState(null);

  const insertFootnote = useCallback(() => {
    const el = document.activeElement;
    if (!el || el.tagName !== "TEXTAREA") return;
    const label = nextFootnoteLabel(nodesRef.current);
    setFnInsertPopup({ label, el, cursorPos: el.selectionStart });
  }, []);

  const confirmInsertFootnote = useCallback((defText) => {
    if (!fnInsertPopup) return;
    const { label, el, cursorPos } = fnInsertPopup;
    const ref = `[fn:${label}]`;
    let val = el.value;
    // Insert ref at saved cursor position
    val = val.slice(0, cursorPos) + ref + val.slice(cursorPos);
    // Append definition at end (stub or empty placeholder)
    const stub = defText.trim() || "…";
    const sep = val.endsWith("\n\n") ? "" : val.endsWith("\n") ? "\n" : "\n\n";
    val = val + sep + `[fn:${label}] ${stub}`;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(cursorPos + ref.length, cursorPos + ref.length); });
    setFnInsertPopup(null);
  }, [fnInsertPopup]);

  const insertFootnoteRef = useRef(insertFootnote);
  useEffect(() => { insertFootnoteRef.current = insertFootnote; }, [insertFootnote]);
  useEffect(() => {
    const handler = () => insertFootnoteRef.current();
    document.body.addEventListener("epicInsertFootnote", handler);
    return () => document.body.removeEventListener("epicInsertFootnote", handler);
  }, []);

  // Insert image: show dialog at App level to avoid NodeBody unmounting it.
  const [imgInsertState, setImgInsertState] = useState(null);

  const confirmInsertImage = useCallback((orgText) => {
    if (!imgInsertState) return;
    const { nodeId, cursorPos, body } = imgInsertState;
    const before = body.slice(0, cursorPos);
    const after = body.slice(cursorPos);
    const pre = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    const post = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
    dispatch(nodeId, "change-body", before + pre + orgText + post + after);
    setImgInsertState(null);
  }, [imgInsertState]); // dispatch is stable (declared later in component, safe to omit)

  const imgInsertHandlerRef = useRef(null);
  useEffect(() => { imgInsertHandlerRef.current = (e) => setImgInsertState(e.detail); });
  useEffect(() => {
    const handler = (e) => imgInsertHandlerRef.current?.(e);
    document.body.addEventListener("epicInsertImage", handler);
    return () => document.body.removeEventListener("epicInsertImage", handler);
  }, []);

  // Date stamp
  const [dateStampFmt, setDateStampFmtState] = useState(getDateStampFmt);
  const setDateStampFmt = useCallback((fmt) => {
    setDateStampFmtState(fmt);
    try { localStorage.setItem(DATE_STAMP_KEY, JSON.stringify(fmt)); } catch {}
  }, []);
  const insertDateStamp = useCallback(() => {
    const el = document.activeElement;
    if (!el || el.tagName !== "TEXTAREA") return;
    const stamp = formatDateStamp(new Date(), dateStampFmt);
    const { selectionStart: s, selectionEnd: en, value } = el;
    const newVal = value.slice(0, s) + stamp + value.slice(en);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(el, newVal);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    requestAnimationFrame(() => el.setSelectionRange(s + stamp.length, s + stamp.length));
  }, [dateStampFmt]);
  const insertDateStampRef = useRef(insertDateStamp);
  useEffect(() => { insertDateStampRef.current = insertDateStamp; }, [insertDateStamp]);

  // Shortcut customization
  const [shortcutVer, setShortcutVer] = useState(0);
  const [showShortcutEditor, setShowShortcutEditor] = useState(false);
  const [showOutlineActions, setShowOutlineActions] = useState(false);
  const updateShortcut = useCallback((id, combo) => {
    shortcutOverrides[id] = combo;
    try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcutOverrides)); } catch {}
    setShortcutVer((v) => v + 1);
  }, []);
  const resetShortcut = useCallback((id) => {
    delete shortcutOverrides[id];
    try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcutOverrides)); } catch {}
    setShortcutVer((v) => v + 1);
  }, []);
  const resetAllShortcuts = useCallback(() => {
    for (const k of Object.keys(shortcutOverrides)) delete shortcutOverrides[k];
    try { localStorage.removeItem(SHORTCUTS_KEY); } catch {}
    setShortcutVer((v) => v + 1);
  }, []);

  // Footnote reference clicks — [fn:label] spans rendered by renderOrgInline.
  // Uses capture so the click is intercepted before node edit handlers fire.
  useEffect(() => {
    const onFnClick = (e) => {
      const fnEl = e.target.closest(".org-fn-ref");
      if (!fnEl) return;
      e.preventDefault();
      e.stopPropagation();
      const label = fnEl.dataset.fn;
      const defInfo = fnNavIndexRef.current.defs[label];
      setFnPopup({
        label,
        text: defInfo ? defInfo.text : "",
        notFound: !defInfo,
        x: e.clientX,
        y: e.clientY,
      });
    };
    document.addEventListener("click", onFnClick, true);
    return () => document.removeEventListener("click", onFnClick, true);
  }, []);

  // Handle file drag-and-drop from the OS file manager.
  // Using native document listeners (not React synthetic onDrop) because React's
  // onDrop delegation is unreliable when the drop target is a <textarea> with
  // native drag handling. Document listeners always fire.
  useEffect(() => {
    const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || t === "text/uri-list");

    const onDragOver = (e) => {
      if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "link"; }
    };

    const onDrop = (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const uriList = e.dataTransfer.getData("text/uri-list");
      if (!uriList) return;
      const uris = uriList.split(/\r?\n/).map((u) => u.trim()).filter((u) => /^file:/i.test(u) && !u.startsWith("#"));
      if (!uris.length) return;
      const links = uris.map((uri) => {
        const path = decodeURIComponent(uri.replace(/^file:\/\/[^/]*/i, ""));
        const name = path.split("/").filter(Boolean).pop() || path;
        return `[[file:${path}][${name}]]`;
      }).join(" ");
      const row = e.target.closest?.(".node-row");
      const textarea = row?.querySelector("textarea")
        || (document.activeElement?.tagName === "TEXTAREA" ? document.activeElement : null)
        || document.querySelector(".outline-pane textarea, .raw-text-editor");
      if (!textarea) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end   = textarea.selectionEnd   ?? textarea.value.length;
      const newVal = textarea.value.substring(0, start) + links + textarea.value.substring(end);
      const proto = textarea.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(textarea, newVal);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.setSelectionRange(start + links.length, start + links.length);
    };

    // Paste a bare file path or URL → auto-wrap as an org link, or a
    // browser-copied HTML table → an org-mode table.
    // Only fires when the active element is a textarea (node title or body).
    const onPaste = (e) => {
      const ta = document.activeElement;
      if (!ta || ta.tagName !== "TEXTAREA") return;
      const cd = e.clipboardData || window.clipboardData;

      // Titles are single-line org headlines — a multi-line table can only
      // ever make sense in a body/notes field, so skip conversion there.
      if (!ta.classList.contains("node-title")) {
        const html = cd.getData("text/html");
        if (html && /<table[\s>]/i.test(html)) {
          const doc = new DOMParser().parseFromString(html, "text/html");
          const blocks = htmlToOrgBlocks(doc.body || doc.documentElement);
          // Only intercept if a table actually turned up (the regex above is
          // just a cheap pre-check and can false-positive on escaped text);
          // otherwise fall through to the plain-text paste below.
          if (blocks.some((b) => typeof b !== "string")) {
            e.preventDefault();
            const orgText = blocks
              .map((b) => (typeof b === "string" ? b : tree.serializeOrgTable(b).join("\n")))
              .join("\n\n");
            const start = ta.selectionStart ?? ta.value.length;
            const end   = ta.selectionEnd   ?? ta.value.length;
            const before = ta.value.slice(0, start);
            const after  = ta.value.slice(end);
            // A table only parses as a table when each row starts its own
            // line, so make sure it lands on fresh lines rather than fusing
            // its first/last row onto whatever text is next to the cursor.
            const leadingNl  = before === "" || before.endsWith("\n") ? "" : "\n";
            const trailingNl = after  === "" || after.startsWith("\n") ? "" : "\n";
            const insertText = leadingNl + orgText + trailingNl;
            const newVal = before + insertText + after;
            const proto = window.HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(ta, newVal);
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.setSelectionRange(start + insertText.length, start + insertText.length);
            return;
          }
        }
      }

      const text = cd.getData("text/plain").trim();
      let link;
      if (/^\/[^\s]+$/.test(text)) {
        // Absolute file path → [[file:path][filename]]
        const name = text.split("/").filter(Boolean).pop() || text;
        link = `[[file:${text}][${name}]]`;
      } else if (/^https?:\/\/\S+$/.test(text)) {
        // HTTP/HTTPS URL → [[url][hostname]], upgraded in place to
        // "hostname - Page Title" once the title loads (fetched server-side
        // to sidestep browser CORS restrictions on arbitrary sites).
        let hostname = text;
        try { hostname = new URL(text).hostname.replace(/^www\./, ""); } catch {}
        link = `[[${text}][${hostname}]]`;
        const meta = fieldMetaForTextarea(ta);
        if (meta) {
          const placeholderLink = link;
          fetch("/api/url-title?url=" + encodeURIComponent(text))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              const title = data && data.title && data.title.trim();
              if (!title) return;
              const newLink = `[[${text}][${hostname} - ${title}]]`;
              let current;
              if (meta.field === "change-preamble") {
                current = preambleRef.current;
              } else {
                const node = tree.findNode(nodesRef.current || [], meta.nodeId);
                if (!node) return;
                current = meta.field === "change-body" ? node.body : node.title;
              }
              // Only patch if the placeholder link is still there unmodified —
              // the user may have since edited or deleted it.
              if (typeof current !== "string" || !current.includes(placeholderLink)) return;
              dispatch(meta.nodeId, meta.field, current.replace(placeholderLink, newLink));
            })
            .catch(() => {});
        }
      } else {
        return;
      }
      e.preventDefault();
      const start = ta.selectionStart ?? ta.value.length;
      const end   = ta.selectionEnd   ?? ta.value.length;
      const newVal = ta.value.substring(0, start) + link + ta.value.substring(end);
      const proto = window.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(ta, newVal);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.setSelectionRange(start + link.length, start + link.length);
    };

    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  const [homeFile, setHomeFile] = useState(() => {
    try { return localStorage.getItem("epicorg.homeFile") || null; } catch { return null; }
  });
  const setHomeFilePersisted = useCallback((f) => {
    setHomeFile(f);
    try {
      if (f) localStorage.setItem("epicorg.homeFile", f);
      else localStorage.removeItem("epicorg.homeFile");
    } catch {}
  }, []);
  const [topBarColor, setTopBarColor] = useState(() => {
    try { const v = localStorage.getItem("epicorg.topBarColor"); return v !== null ? v : "green"; } catch { return "green"; }
  });
  const setTopBarColorPersisted = useCallback((color) => {
    setTopBarColor(color);
    try {
      if (color) localStorage.setItem("epicorg.topBarColor", color);
      else localStorage.removeItem("epicorg.topBarColor");
    } catch {}
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const accentHex = resolveTopBarColor(topBarColor);
    if (accentHex) root.style.setProperty("--accent", accentHex);
    else root.style.removeProperty("--accent");
  }, [topBarColor]);
  const [tagPanelVisible, setTagPanelVisible] = useState(() => {
    try {
      const v = localStorage.getItem("epicorg.tagPanelVisible");
      if (v === "1") return true;
      if (v === "0") return false;
      // No explicit preference yet — default open only when there's enough
      // room for the sidebar, main content, AND the tag panel all at once.
      return window.innerWidth >= 1300;
    } catch { return false; }
  });
  const [globalTags, setGlobalTags] = useState([]);
  const globalTagsRef = useRef([]);
  const [tagPanelWidth, setTagPanelWidth] = useState(() => {
    try {
      const s = parseInt(localStorage.getItem("epicorg.tagPanelWidth"), 10);
      if (Number.isFinite(s) && s > 0) return s;
    } catch {}
    return 200;
  });
  const [bookmarkPanelVisible, setBookmarkPanelVisible] = useState(() => {
    try { return localStorage.getItem("epicorg.bookmarkPanelVisible") === "1"; } catch { return false; }
  });
  const [globalBMs, setGlobalBMs] = useState([]);
  const globalBMsRef = useRef([]);
  const [bookmarkPanelWidth, setBookmarkPanelWidth] = useState(() => {
    try {
      const s = parseInt(localStorage.getItem("epicorg.bookmarkPanelWidth"), 10);
      if (Number.isFinite(s) && s > 0) return s;
    } catch {}
    return 200;
  });
  const [detailWidth, setDetailWidth] = useState(() => {
    try {
      const stored = parseInt(localStorage.getItem("epicorg.detailWidth"), 10);
      if (Number.isFinite(stored) && stored > 0) return stored;
    } catch {}
    return Math.round(window.innerWidth * 0.20);
  });
  // The detail pane stays open across navigation once opened — it only
  // closes when the user explicitly clicks the Details toggle. Persisted
  // like the other panel preferences so it stays open across reloads too.
  const [detailVisible, setDetailVisible] = useState(() => {
    try { return localStorage.getItem("epicorg.detailVisible") === "1"; } catch { return false; }
  });
  const setDetailVisiblePersisted = useCallback((v) => {
    setDetailVisible((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try { localStorage.setItem("epicorg.detailVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const setDetailWidthPersisted = useCallback((w) => {
    setDetailWidth(w);
    try { localStorage.setItem("epicorg.detailWidth", String(w)); } catch {}
  }, []);
  const pendingFocusRef = useRef(null);
  const pendingCursorPosRef = useRef(null);
  const inputRefs = useRef({});
  const bodyRefs = useRef({});
  const dragStateRef = useRef(null);  // { nodeId, startX, startY, pending }
  const dragVisualRef = useRef(null);
  const [dragVisual, setDragVisual] = useState(null);
  useEffect(() => { dragVisualRef.current = dragVisual; }, [dragVisual]);
  // The per-node action menu opened from the hover handle (or right-clicking
  // the bullet/handle) — { nodeId, x, y } or null.
  const [nodeMenu, setNodeMenu] = useState(null);
  // Which node's inline body/notes textarea is currently open for editing —
  // body text now lives under each bullet rather than in the detail pane.
  const [bodyEditingId, setBodyEditingId] = useState(null);
  const [bodyPreviewId, setBodyPreviewId] = useState(null);
  const detailPaneRef = useRef(null);
  const dirtyRef = useRef(false);
  const nodesRef = useRef(null);
  const visibleNodesRef = useRef(null);
  const preambleRef = useRef("");
  const hashRef = useRef("");
  const currentFileRef = useRef(null);

  // Text mode: the whole document as raw, editable org text — asterisks,
  // tags, properties drawers and all — instead of the structured outline.
  const [textMode, setTextMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [textModeError, setTextModeError] = useState(false);
  const textModeRef = useRef(false);
  const rawTextRef = useRef("");
  const textDirtyRef = useRef(false);
  useEffect(() => { textModeRef.current = textMode; }, [textMode]);
  useEffect(() => { rawTextRef.current = rawText; }, [rawText]);

  // Undo/redo — a stack of {nodes, preamble} snapshots. Safe to store by
  // reference rather than deep-cloning: every tree.js mutation returns new
  // objects rather than mutating in place, so a past snapshot never changes
  // out from under us. Per-file: cleared on load/switch, since undo history
  // from a different document isn't meaningful.
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const undoCoalesceKeyRef = useRef(null);
  const undoCoalesceTimerRef = useRef(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const isFiltering = !!searchQuery || selectedTags.length > 0;
  // Hoisting swaps in just the focused node (as the lone "root") before any
  // text/tag filtering is applied on top — self-healing if the hoisted node
  // ever disappears (deleted, file switched), since the lookup just fails
  // and isHoisted naturally becomes false again.
  const hoistedNode = hoistedId ? tree.findNode(nodes || [], hoistedId) : null;
  const isHoisted = !!hoistedNode;
  const hoistBaseNodes = hoistedNode ? [hoistedNode] : nodes;
  const visibleNodes = useMemo(
    () => isFiltering && hoistBaseNodes ? tree.filterTree(hoistBaseNodes, searchQuery, selectedTags) : hoistBaseNodes,
    [hoistBaseNodes, searchQuery, selectedTags, isFiltering]
  );
  const toggleHoist = useCallback(() => {
    setHoistedId((prev) => {
      if (prev) return null;
      return focusedId && focusedId !== "preamble" ? focusedId : prev;
    });
  }, [focusedId]);
  // Explicit-target version for the node action menu, which can be opened on
  // any node regardless of keyboard focus — toggleHoist above infers its
  // target from focusedId, which would silently hoist the wrong node here.
  const toggleHoistNode = useCallback((id) => {
    setHoistedId((prev) => (prev === id ? null : id));
  }, []);
  const allTags = useMemo(() => nodes ? tree.collectAllTags(nodes) : [], [nodes]);
  const bookmarks = useMemo(() => nodes ? tree.collectBookmarks(nodes) : [], [nodes]);

  // Bookmark order is persisted per-file in localStorage (by bookmark name, not
  // node ID, since IDs are ephemeral). Reloads when the current file changes.
  const [bookmarkOrder, setBookmarkOrder] = useState([]);
  const bookmarkOrderRef = useRef([]);
  useEffect(() => { bookmarkOrderRef.current = bookmarkOrder; }, [bookmarkOrder]);
  useEffect(() => {
    if (!currentFile) { setBookmarkOrder([]); return; }
    try {
      const stored = JSON.parse(localStorage.getItem("epicorg.bookmarkOrder." + currentFile) || "[]");
      setBookmarkOrder(Array.isArray(stored) ? stored : []);
    } catch { setBookmarkOrder([]); }
  }, [currentFile]);

  // Merge document order with stored order: stored order first, then any new
  // bookmarks (not yet in the order) appended at the end.
  const orderedBookmarks = useMemo(() => {
    const byName = {};
    for (const bm of bookmarks) byName[bm.bookmark] = bm;
    const result = [];
    for (const name of bookmarkOrder) {
      if (byName[name]) result.push(byName[name]);
    }
    for (const bm of bookmarks) {
      if (!bookmarkOrder.includes(bm.bookmark)) result.push(bm);
    }
    return result;
  }, [bookmarks, bookmarkOrder]);

  const updateBookmarkOrder = useCallback((newOrder) => {
    setBookmarkOrder(newOrder);
    const file = currentFileRef.current;
    if (file) {
      try { localStorage.setItem("epicorg.bookmarkOrder." + file, JSON.stringify(newOrder)); } catch {}
    }
  }, []);

  // Global bookmarks — loaded from server config, persisted to ~/.config/epicorg/bookmarks.json.
  const [globalBookmarks, setGlobalBookmarks] = useState([]);
  const globalBookmarksRef = useRef([]);
  useEffect(() => { globalBookmarksRef.current = globalBookmarks; }, [globalBookmarks]);

  // Pending global bookmark navigation: when clicking a global bookmark in
  // a different file, store the GBOOKMARK name here; once nodes load, we
  // find and focus the matching node.
  const pendingGlobalBookmarkRef = useRef(null);

  useEffect(() => {
    api.get("/api/global-bookmarks").then((d) => setGlobalBookmarks(d.bookmarks || [])).catch(() => {});
  }, []);
  useEffect(() => {
    api.get("/api/global-tags").then((d) => {
      const tags = d.tags || [];
      setGlobalTags(tags);
      globalTagsRef.current = tags;
    }).catch(() => {});
  }, []);
  useEffect(() => {
    api.get("/api/bookmarks").then((d) => {
      const bms = d.bookmarks || [];
      setGlobalBMs(bms);
      globalBMsRef.current = bms;
    }).catch(() => {});
  }, []);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { preambleRef.current = preamble; }, [preamble]);
  useEffect(() => { hashRef.current = hash; }, [hash]);
  useEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setSyncStatus(SYNC_DIRTY);
  }, []);

  const [apptDialog, setApptDialog] = useState(null); // null or { defaultDate: "YYYY-MM-DD" }

  const clearUndoHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    undoCoalesceKeyRef.current = null;
    clearTimeout(undoCoalesceTimerRef.current);
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  // Snapshots the pre-mutation state for undo, before dispatch applies an
  // undoable action. A burst of typing into the same field coalesces into
  // a single snapshot rather than one per keystroke.
  const maybeSnapshotForUndo = useCallback((action, nodeId) => {
    if (!UNDOABLE_ACTIONS.has(action)) return;
    const coalesces = COALESCE_UNDO_ACTIONS.has(action);
    const key = nodeId + ":" + action;
    if (coalesces && undoCoalesceKeyRef.current === key) {
      clearTimeout(undoCoalesceTimerRef.current);
      undoCoalesceTimerRef.current = setTimeout(() => { undoCoalesceKeyRef.current = null; }, UNDO_COALESCE_MS);
      return;
    }
    undoStackRef.current.push({ nodes: nodesRef.current, preamble: preambleRef.current });
    if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
    if (coalesces) {
      undoCoalesceKeyRef.current = key;
      clearTimeout(undoCoalesceTimerRef.current);
      undoCoalesceTimerRef.current = setTimeout(() => { undoCoalesceKeyRef.current = null; }, UNDO_COALESCE_MS);
    } else {
      undoCoalesceKeyRef.current = null;
    }
  }, []);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const prev = undoStackRef.current.pop();
    redoStackRef.current.push({ nodes: nodesRef.current, preamble: preambleRef.current });
    undoCoalesceKeyRef.current = null;
    setNodes(prev.nodes);
    setPreamble(prev.preamble);
    markDirty();
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, [markDirty]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const next = redoStackRef.current.pop();
    undoStackRef.current.push({ nodes: nodesRef.current, preamble: preambleRef.current });
    undoCoalesceKeyRef.current = null;
    setNodes(next.nodes);
    setPreamble(next.preamble);
    markDirty();
    setCanRedo(redoStackRef.current.length > 0);
    setCanUndo(true);
  }, [markDirty]);

  const foldToLevel = useCallback((level) => {
    setNodes((prev) => prev ? tree.foldToLevel(prev, level) : prev);
    markDirty();
  }, [markDirty]);

  // Unlike "Expand All" (which only unfolds headings), this also force-shows
  // inline notes — a single command for "reveal absolutely everything",
  // regardless of whichever state notes visibility happened to be in.
  const expandAllWithNotes = useCallback(() => {
    foldToLevel(9);
    setNotesVisible(true);
    try { localStorage.setItem("epicorg.notesVisible", "1"); } catch {}
  }, [foldToLevel]);

  // Save an edited footnote definition back into the node body that contains it.
  const saveFootnoteDef = useCallback((label, newText) => {
    const defInfo = fnNavIndexRef.current.defs[label];
    if (!defInfo) return;
    setNodes((prev) => {
      const node = tree.findNode(prev, defInfo.nodeId);
      if (!node || !node.body) return prev;
      const lines = node.body.split("\n");
      let replaced = false;
      const updated = lines.map((line) => {
        if (replaced) return line;
        const m = /^\[fn:([^\]]+)\]\s+.+/.exec(line.trim());
        if (m && m[1].trim() === label) { replaced = true; return `[fn:${label}] ${newText}`; }
        return line;
      });
      if (!replaced) updated.push(`[fn:${label}] ${newText}`);
      return tree.updateNodeField(prev, defInfo.nodeId, "body", updated.join("\n"));
    });
    markDirty();
  }, [markDirty]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (matchShortcut("commandPalette", e)) {
        e.preventDefault(); setShowHelp((v) => !v); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "/")) {
        e.preventDefault();
        setFilterExpanded(true);
        requestAnimationFrame(() => {
          const el = searchInputRef.current;
          if (el) { el.focus(); el.select(); }
        });
        return;
      }
      if (matchShortcut("textSearch", e)) {
        e.preventDefault(); setShowTextSearch(true); return;
      }
      if (matchShortcut("copyFormatted", e)) {
        e.preventDefault(); copyFormattedRef.current?.(); return;
      }
      if (matchShortcut("copyPlain", e)) {
        e.preventDefault(); copyPlainRef.current?.(); return;
      }
      if (matchShortcut("hoist", e)) {
        e.preventDefault(); toggleHoistRef.current?.(); return;
      }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBackRef.current?.(); return; }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goForwardRef.current?.(); return; }
      if (e.altKey && e.key >= "1" && e.key <= "9" && !textModeRef.current) {
        e.preventDefault(); foldToLevel(parseInt(e.key));
      }
      // Unified document-level undo/redo. Ctrl+Y is a fixed secondary for redo.
      if ((e.ctrlKey || e.metaKey) && !textModeRef.current) {
        if (matchShortcut("redo", e) || e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
        if (matchShortcut("undo", e)) { e.preventDefault(); undo(); return; }
        if (matchShortcut("insertFootnote", e)) { e.preventDefault(); insertFootnoteRef.current(); return; }
        if (matchShortcut("insertDateStamp", e)) { e.preventDefault(); insertDateStampRef.current(); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [foldToLevel, undo, redo]);

  // Focus effect
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id !== null) {
      pendingFocusRef.current = null;
      requestAnimationFrame(() => {
        const el = inputRefs.current[id];
        if (el) {
          el.focus();
          if (el.setSelectionRange) {
            const pos = pendingCursorPosRef.current !== null ? pendingCursorPosRef.current : (el.value?.length || 0);
            pendingCursorPosRef.current = null;
            el.selectionStart = el.selectionEnd = pos;
          }
          // The textarea may be off-screen at -9999px when overlay mode is active,
          // so scroll the .node-row (always in the real layout) instead.
          const row = document.querySelector(`.node-row[data-node-id="${id}"]`);
          (row || el).scrollIntoView({ block: "nearest" });
        }
      });
    }
  });

  const focusedIdRef = useRef(focusedId);
  useEffect(() => { focusedIdRef.current = focusedId; }, [focusedId]);

  const focusNode = useCallback((id) => {
    setFocusedId(id);
    pendingFocusRef.current = id;
  }, []);

  const jumpToNode = useCallback((id) => {
    // If hoisted into a subtree that doesn't contain the destination, the
    // hoisted view would just filter the target out entirely — clicking a
    // nav-panel/bookmark/search entry outside the isolated subtree would
    // silently do nothing. Un-hoist first so navigation always succeeds.
    setHoistedId((prevHoist) =>
      prevHoist && !tree.isDescendantOrSelf(nodesRef.current || [], prevHoist, id) ? null : prevHoist
    );
    setNodes((prev) => tree.uncollapseToNode(prev, id));
    focusNode(id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = document.querySelector(`.node-row[data-node-id="${id}"]`);
        if (row) {
          row.scrollIntoView({ block: "center", behavior: "smooth" });
          row.classList.remove("jump-flash");
          void row.offsetWidth;
          row.classList.add("jump-flash");
          setTimeout(() => row.classList.remove("jump-flash"), 2000);
        }
      });
    });
  }, [focusNode]);

  // After a file loads, check if we're waiting to navigate to a global bookmark.
  useEffect(() => {
    if (!nodes || !pendingGlobalBookmarkRef.current) return;
    const name = pendingGlobalBookmarkRef.current;
    pendingGlobalBookmarkRef.current = null;
    const found = tree.findNodeByProperty(nodes, "BOOKMARK", name);
    if (found) {
      setNodes((prev) => tree.uncollapseToNode(prev, found.id));
      focusNode(found.id);
      navDispatch({ type: "patch", title: found.title });
    }
  }, [nodes, focusNode, navDispatch]);

  // After a file loads via tag/text-search result click, find the node by title and focus it.
  useEffect(() => {
    if (!nodes || !pendingTagNavRef.current) return;
    const { title } = pendingTagNavRef.current;
    pendingTagNavRef.current = null;
    const found = tree.findNodeByTitle(nodes, title);
    if (found) {
      setNodes((prev) => tree.uncollapseToNode(prev, found.id));
      focusNode(found.id);
      navDispatch({ type: "patch", title: found.title });
    }
  }, [nodes, focusNode, navDispatch]);

  // After a file loads via journal node click, jump to the specific node.
  useEffect(() => {
    if (!nodes || !pendingJumpIdRef.current) return;
    const id = pendingJumpIdRef.current;
    pendingJumpIdRef.current = null;
    jumpToNode(id);
  }, [nodes, jumpToNode]);

  // After navigating to a file from an external agenda item, jump to the node by title.
  useEffect(() => {
    if (!nodes || !pendingJumpTitleRef.current) return;
    const title = pendingJumpTitleRef.current;
    pendingJumpTitleRef.current = null;
    function findByTitle(ns) {
      for (const n of ns) {
        if (n.title === title) return n;
        if (n.children?.length > 0) { const f = findByTitle(n.children); if (f) return f; }
      }
      return null;
    }
    const found = findByTitle(nodes);
    if (found) jumpToNode(found.id);
  }, [nodes, jumpToNode]);

  const searchTag = useCallback(async (tag) => {
    setTagSearch({ tag, results: null });
    setSearchResults({ type: "tag", query: tag, results: null });
    setView("search");
    try {
      const data = await api.get("/api/search/tag?q=" + encodeURIComponent(tag));
      const r = data.results || [];
      setTagSearch({ tag, results: r });
      setSearchResults({ type: "tag", query: tag, results: r });
    } catch {
      setTagSearch({ tag, results: [] });
      setSearchResults({ type: "tag", query: tag, results: [] });
    }
  }, []);

  // Listen for the [[ trigger fired from node textareas.
  useEffect(() => {
    const handler = (e) => {
      linkPickerTargetRef.current = e.detail;
      setShowLinkPicker(true);
    };
    document.body.addEventListener("epicLinkTrigger", handler);
    return () => document.body.removeEventListener("epicLinkTrigger", handler);
  }, []);

  const insertFileLink = useCallback((filename, title) => {
    const target = linkPickerTargetRef.current;
    setShowLinkPicker(false);
    if (!target) return;
    const { textarea, cursorPos } = target;
    const link = `[[file:${filename}][${title}]]`;
    const before = textarea.value.substring(0, cursorPos - 2); // -2 removes the [[
    const after = textarea.value.substring(cursorPos);
    const newVal = before + link + after;
    const proto = window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(textarea, newVal);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const newCursor = before.length + link.length;
    textarea.setSelectionRange(newCursor, newCursor);
    textarea.focus();
  }, []);

  const createFileForLink = useCallback(async (filename, title) => {
    await api.post("/api/files", { filename, title });
    const data = await api.get("/api/files");
    setFiles(data.files || []);
    insertFileLink(filename, title);
  }, [insertFileLink]);

  // Wiki-link picker: opens when [[ is typed in a body textarea.
  useEffect(() => {
    const handler = (e) => {
      wikiPickerTargetRef.current = e.detail;
      setShowWikiPicker(true);
    };
    document.body.addEventListener("epicWikiLinkTrigger", handler);
    return () => document.body.removeEventListener("epicWikiLinkTrigger", handler);
  }, []);

  // Keep wikiEntriesRef in sync for use in the nav handler (avoids re-registering).
  useEffect(() => { wikiEntriesRef.current = wikiEntries; }, [wikiEntries]);

  // Refresh wiki entries when the file list changes.
  useEffect(() => {
    api.get("/api/wikilinks").then((data) => setWikiEntries(Array.isArray(data) ? data : [])).catch(() => {});
  }, [files]);

  const insertWikiLink = useCallback((title) => {
    const target = wikiPickerTargetRef.current;
    setShowWikiPicker(false);
    if (!target) return;
    const { textarea, cursorPos } = target;
    const link = `[[${title}]]`;
    const before = textarea.value.substring(0, cursorPos - 2); // -2 removes the [[
    const after = textarea.value.substring(cursorPos);
    const proto = window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(textarea, before + link + after);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const newCursor = before.length + link.length;
    requestAnimationFrame(() => { textarea.focus(); textarea.setSelectionRange(newCursor, newCursor); });
  }, []);

  const createNoteForWikiLink = useCallback(async (title) => {
    const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + ".org";
    try {
      await api.post("/api/files", { filename, title });
      const data = await api.get("/api/files");
      setFiles(data.files || []);
    } catch {}
    insertWikiLink(title);
  }, [insertWikiLink]);

  const createAndLoadNote = useCallback(async (title) => {
    const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + ".org";
    try {
      await api.post("/api/files", { filename, title });
      const data = await api.get("/api/files");
      setFiles(data.files || []);
      setShowQuickSwitcher(false);
      loadFileRef.current?.(filename);
    } catch {}
  }, []);

  // Navigate to a note when a wiki-link is clicked in any body preview.
  // Uses the existing loadFileRef (declared later, kept in sync there) — the closure
  // captures the binding without triggering TDZ; the ref is set before any click can fire.
  useEffect(() => {
    const handler = (e) => {
      const name = e.detail.name;
      const entry = wikiEntriesRef.current.find(
        (en) => en.title.toLowerCase() === name.toLowerCase()
      );
      if (entry) { setHoverPopup(null); loadFileRef.current?.(entry.file); }
    };
    document.body.addEventListener("epicWikiNav", handler);
    return () => document.body.removeEventListener("epicWikiNav", handler);
  }, []);

  // Hover preview: show a popup with the linked note's content after a short delay.
  useEffect(() => {
    const onHover = (e) => {
      const { name, rect, over } = e.detail;
      if (over) {
        clearTimeout(hoverTimerRef.current);
        const entry = wikiEntriesRef.current.find((en) => en.title.toLowerCase() === name.toLowerCase());
        if (!entry) return;
        hoverTimerRef.current = setTimeout(async () => {
          let data = previewCacheRef.current.get(entry.file);
          if (!data) {
            try {
              data = await api.get(`/api/doc/${encodeURIComponent(entry.file)}`);
              previewCacheRef.current.set(entry.file, data);
            } catch { return; }
          }
          setHoverPopup({ rect, data, title: entry.title, file: entry.file });
        }, 350);
      } else {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => setHoverPopup(null), 120);
      }
    };
    document.body.addEventListener("epicWikiHover", onHover);
    return () => { document.body.removeEventListener("epicWikiHover", onHover); clearTimeout(hoverTimerRef.current); };
  }, []);

  // Ctrl+K quick switcher.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "k" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setShowQuickSwitcher((s) => !s);
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  // Ctrl+F find in note.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "f" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      }
      if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
        setFindQuery("");
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [findOpen]);

  // Clear the "Replaced N" feedback once the user changes what they're
  // searching/replacing for, so it doesn't linger and look stale.
  useEffect(() => { setReplaceMessage(""); }, [findQuery, replaceQuery]);

  // Recompute matches when query or nodes change.
  useEffect(() => {
    document.querySelectorAll(".node-row.find-match, .node-row.find-match-current").forEach((el) => {
      el.classList.remove("find-match", "find-match-current");
    });
    if (!findOpen || !findQuery.trim()) { setFindMatchIds([]); setFindIdx(0); return; }
    const ids = findInNodes(nodes, findQuery.trim());
    setFindMatchIds(ids);
    setFindIdx(0);
  }, [findOpen, findQuery, nodes]);

  // Highlight current match in DOM.
  useEffect(() => {
    document.querySelectorAll(".node-row.find-match, .node-row.find-match-current").forEach((el) => {
      el.classList.remove("find-match", "find-match-current");
    });
    for (const id of findMatchIds) {
      document.querySelector(`.node-row[data-node-id="${id}"]`)?.classList.add("find-match");
    }
    if (findMatchIds[findIdx]) {
      const el = document.querySelector(`.node-row[data-node-id="${findMatchIds[findIdx]}"]`);
      el?.classList.add("find-match-current");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [findMatchIds, findIdx]);

  const findNavigate = useCallback((dir) => {
    setFindIdx((i) => {
      const next = i + dir;
      if (next < 0) return findMatchIds.length - 1;
      if (next >= findMatchIds.length) return 0;
      return next;
    });
  }, [findMatchIds]);

  // Replaces all occurrences of findQuery within the currently-matched node
  // only (title + body), then advances — a step-through-and-confirm flow.
  const replaceCurrentMatch = useCallback(() => {
    const nodeId = findMatchIds[findIdx];
    if (!nodeId || !findQuery.trim() || !nodes) return;
    const { nodes: updated, count } = tree.replaceInTree(nodes, findQuery, replaceQuery, nodeId);
    if (count === 0) return;
    setNodes(updated);
    markDirty();
    setReplaceMessage(`Replaced ${count} in this item`);
  }, [nodes, findMatchIds, findIdx, findQuery, replaceQuery, markDirty]);

  // Replaces every occurrence of findQuery across the whole file at once.
  const replaceAllMatches = useCallback(() => {
    if (!findQuery.trim() || !nodes) return;
    const { nodes: updated, count } = tree.replaceInTree(nodes, findQuery, replaceQuery);
    if (count === 0) { setReplaceMessage("No matches found"); return; }
    setNodes(updated);
    markDirty();
    setReplaceMessage(`Replaced ${count} occurrence${count === 1 ? "" : "s"}`);
  }, [nodes, findQuery, replaceQuery, markDirty]);

  const runTextSearch = useCallback(async (query, includeMarkdown) => {
    setShowTextSearch(false);
    setSearchResults({ type: "text", query, results: null });
    setView("search");
    try {
      const url = "/api/search/text?q=" + encodeURIComponent(query) + (includeMarkdown ? "&md=1" : "");
      const data = await api.get(url);
      setSearchResults({ type: "text", query, results: data.results || [] });
    } catch {
      setSearchResults({ type: "text", query, results: [] });
    }
  }, []);

  // Load file list on mount. The file the user last had open (persisted
  // across refreshes) takes priority over the launch -file default, so
  // switching files and refreshing doesn't bounce you back to the file the
  // server happened to be started with.
  useEffect(() => {
    api.get("/api/files").then((data) => {
      const f = data.files || [];
      setFiles(f);
      let lastFile = null;
      try { lastFile = localStorage.getItem("epicorg.lastFile"); } catch {}
      let toLoad = null;
      if (lastFile && (lastFile.startsWith("/") || f.some((file) => file.name === lastFile))) toLoad = lastFile;
      else if (data.default && f.some((file) => file.name === data.default)) toLoad = data.default;
      else if (f.length === 1) toLoad = f[0].name;
      if (toLoad) loadFile(toLoad).finally(() => setAutoLoadPending(false));
      else setAutoLoadPending(false);
    }).catch(() => setAutoLoadPending(false));
  }, []);

  // Fetch and track home directory.
  useEffect(() => {
    api.get("/api/homedir").then((d) => setHomeDir(d.dir)).catch(() => {});
    api.get("/api/journaldir").then((d) => setJournalDir(d.dir)).catch(() => {});
    api.get("/api/taglistfile").then((d) => setTagListFile(d.file)).catch(() => {});
    api.get("/api/bookmarklistfile").then((d) => setBookmarkListFile(d.file)).catch(() => {});
    api.get("/api/backupsettings").then((d) => setBackupMaxVersions(d.maxVersions)).catch(() => {});
    api.get("/api/workspace").then((d) => setWorkspaceConfig(d)).catch(() => {});
    api.get("/api/saved-workspaces").then((d) => setSavedWorkspaceProfiles(d.workspaces || [])).catch(() => {});
  }, []);

  const changeHomeDir = useCallback(async (dir) => {
    await api.post("/api/homedir", { dir });
    setHomeDir(dir);
    setShowFolderPicker(false);
    setTagSearch(null);
    // Reload file list from new dir
    const data = await api.get("/api/files");
    const f = data.files || [];
    setFiles(f);
    // Reload bookmarks and tags from new dir
    api.get("/api/bookmarks").then((d) => {
      const bms = d.bookmarks || [];
      setGlobalBMs(bms);
      globalBMsRef.current = bms;
    }).catch(() => {});
    api.get("/api/global-tags").then((d) => {
      const tags = d.tags || [];
      setGlobalTags(tags);
      globalTagsRef.current = tags;
    }).catch(() => {});
    // Clear current file since it belongs to the old dir
    setCurrentFile(null);
    setNodes(null);
    setPreamble("");
    setHash("");
    setGlobalFontRaw(null); globalFontRef.current = null;
    setLevelFontsRaw({}); levelFontsRef.current = {};
    setGlobalColorRaw(null); globalColorRef.current = null;
    setLevelColorsRaw({}); levelColorsRef.current = {};
  }, []);

  const saveWorkspace = useCallback(async (cfg) => {
    const saved = await api.put("/api/workspace", cfg);
    setWorkspaceConfig(saved);
    setShowWorkspaceModal(false);
    // Reload file list so workspace changes take effect immediately.
    const data = await api.get("/api/files");
    setFiles(data.files || []);
  }, []);

  const changeJournalDir = useCallback(async (dir) => {
    await api.post("/api/journaldir", { dir });
    setJournalDir(dir);
    setShowJournalFolderPicker(false);
  }, []);

  const clearJournalDir = useCallback(async () => {
    await api.post("/api/journaldir", { dir: "" });
    setJournalDir("");
  }, []);

  const changeBackupMaxVersions = useCallback(async (n) => {
    const saved = await api.post("/api/backupsettings", { maxVersions: n });
    setBackupMaxVersions(saved.maxVersions);
  }, []);

  const reloadGlobalTags = useCallback(() => {
    api.get("/api/global-tags").then((d) => {
      const tags = d.tags || [];
      setGlobalTags(tags);
      globalTagsRef.current = tags;
    }).catch(() => {});
  }, []);

  const changeTagListFile = useCallback(async (file) => {
    await api.post("/api/taglistfile", { file });
    setTagListFile(file);
    setShowTagListFilePicker(false);
    reloadGlobalTags();
  }, [reloadGlobalTags]);

  const clearTagListFile = useCallback(async () => {
    await api.post("/api/taglistfile", { file: "" });
    setTagListFile("");
    reloadGlobalTags();
  }, [reloadGlobalTags]);

  const reloadGlobalBMs = useCallback(() => {
    api.get("/api/bookmarks").then((d) => {
      const bms = d.bookmarks || [];
      setGlobalBMs(bms);
      globalBMsRef.current = bms;
    }).catch(() => {});
  }, []);

  const changeBookmarkListFile = useCallback(async (file) => {
    await api.post("/api/bookmarklistfile", { file });
    setBookmarkListFile(file);
    setShowBookmarkListFilePicker(false);
    reloadGlobalBMs();
  }, [reloadGlobalBMs]);

  const clearBookmarkListFile = useCallback(async () => {
    await api.post("/api/bookmarklistfile", { file: "" });
    setBookmarkListFile("");
    reloadGlobalBMs();
  }, [reloadGlobalBMs]);

  // Favorites are shared workspace state (stored server-side), unlike
  // Recent Files which is local browsing history.
  useEffect(() => {
    api.get("/api/favorites").then((data) => setFavorites(data.favorites || [])).catch(() => {});
  }, []);

  const toggleFavorite = useCallback(async (name) => {
    const makeFavorite = !favorites.includes(name);
    try {
      const data = await api.put("/api/favorites", { filename: name, favorite: makeFavorite });
      setFavorites(data.favorites || []);
    } catch (err) {
      // Leave favorites as-is; the next load will reconcile with the server.
    }
  }, [favorites]);

  const loadFile = useCallback(async (name) => {
    const data = await api.get(docUrl(name));
    setShowPicker(false);
    setTextMode(false);
    setHoistedId(null);
    setBodyPreviewId(null);
    setCurrentFile(name);
    setNodes(data.nodes || []);
    setPreamble(data.preamble || "");
    setHash(data.hash || "");
    // Restore format settings from file (overrides localStorage).
    const { fmt, levelFmts } = parseFormatFromPreamble(data.preamble || "");
    const resolvedFmt = fmt || "bullets";
    setOutlineFormatRaw(resolvedFmt);
    outlineFormatRef.current = resolvedFmt;
    try { localStorage.setItem("epicorg.outlineFormat", resolvedFmt); } catch {}
    setLevelFormatsRaw(levelFmts);
    levelFormatsRef.current = levelFmts;
    try { localStorage.setItem("epicorg.levelFormats", JSON.stringify(levelFmts)); } catch {}
    // Restore typography settings from file.
    const { global: gFont, levels: lFonts } = parseFontsFromPreamble(data.preamble || "");
    setGlobalFontRaw(gFont); globalFontRef.current = gFont;
    setLevelFontsRaw(lFonts); levelFontsRef.current = lFonts;
    const { global: gColor, levels: lColors } = parseColorsFromPreamble(data.preamble || "");
    setGlobalColorRaw(gColor); globalColorRef.current = gColor;
    setLevelColorsRaw(lColors); levelColorsRef.current = lColors;
    dirtyRef.current = false;
    // Merge any new tags from this file into the global tag list.
    const fileTags = tree.collectAllTags(data.nodes || []);
    if (fileTags.length > 0) {
      const cur = globalTagsRef.current;
      const newTags = fileTags.filter(t => !tagExistsInTree(cur, t)).map(t => ({ name: t, children: [], collapsed: false }));
      if (newTags.length > 0) {
        const updated = [...cur, ...newTags];
        globalTagsRef.current = updated;
        setGlobalTags(updated);
        api.put("/api/global-tags", { tags: updated }).catch(() => {});
      }
    }
    clearUndoHistory();
    setSyncStatus(SYNC_SAVED);
    try { localStorage.setItem("epicorg.lastFile", name); } catch {}
    setRecentFiles((prev) => {
      const next = [name, ...prev.filter((n) => n !== name)].slice(0, RECENT_FILES_LIMIT);
      try { localStorage.setItem("epicorg.recentFiles", JSON.stringify(next)); } catch {}
      return next;
    });
    const flat = tree.flattenVisible(data.nodes || []);
    if (flat.length > 0) focusNode(flat[0].id);
    if (!histNavRef.current) navDispatch({ type: "push", entry: { file: name, title: null } });
  }, [focusNode, clearUndoHistory, navDispatch]);

  // Saved workspace profiles: named presets bundling home dir, tag list,
  // bookmark list, journal dir, and home file, so switching between e.g. the
  // GitHub examples folder and a personal notes vault is a single click
  // instead of reconfiguring four settings by hand each time.
  const saveCurrentAsWorkspaceProfile = useCallback(async (name) => {
    const profile = {
      name,
      homeDir: homeDir || "",
      tagListFile: tagListFile || "",
      bookmarkListFile: bookmarkListFile || "",
      journalDir: journalDir || "",
      homeFile: homeFile || "",
    };
    const next = [...savedWorkspaceProfiles.filter((p) => p.name !== name), profile];
    const saved = await api.put("/api/saved-workspaces", { workspaces: next });
    setSavedWorkspaceProfiles(saved.workspaces || []);
  }, [savedWorkspaceProfiles, homeDir, tagListFile, bookmarkListFile, journalDir, homeFile]);

  const deleteWorkspaceProfile = useCallback(async (name) => {
    const next = savedWorkspaceProfiles.filter((p) => p.name !== name);
    const saved = await api.put("/api/saved-workspaces", { workspaces: next });
    setSavedWorkspaceProfiles(saved.workspaces || []);
  }, [savedWorkspaceProfiles]);

  const switchToWorkspaceProfile = useCallback(async (profile) => {
    // Close Settings first: changeHomeDir clears currentFile, which unmounts
    // the document view (Settings included) until the new home file loads —
    // leaving Settings open would just reset its tab back to "View" on remount.
    setShowSettings(false);
    await changeHomeDir(profile.homeDir);
    // Reset search paths to just the new home dir — otherwise the file list
    // keeps showing whatever multi-root paths were configured for the
    // previous workspace, which no longer makes sense in the new context.
    const wsCfg = await api.put("/api/workspace", { paths: [{ path: profile.homeDir, included: true }] });
    setWorkspaceConfig(wsCfg);
    await changeTagListFile(profile.tagListFile || "");
    await changeBookmarkListFile(profile.bookmarkListFile || "");
    await changeJournalDir(profile.journalDir || "");
    setHomeFilePersisted(profile.homeFile || null);
    // changeHomeDir already fetched the file list, but before the search-path
    // reset above took effect — fetch it once more so it reflects that reset.
    const data = await api.get("/api/files");
    setFiles(data.files || []);
    if (profile.homeFile) {
      await loadFile(profile.homeFile);
      setView("outline");
    }
  }, [changeHomeDir, changeTagListFile, changeBookmarkListFile, changeJournalDir, setHomeFilePersisted, loadFile, setView]);

  const goToJournalDate = useCallback(async (dateStr) => {
    if (!dateStr) return;
    try {
      const d = await api.post("/api/journal", { date: dateStr });
      loadFile(d.filename);
      setView("outline");
    } catch {}
  }, [loadFile, setView]);

  const openApptDialog = useCallback(() => {
    const m = currentFile?.match(/journal\/(\d{4}-\d{2}-\d{2})\.org/);
    setApptDialog({ defaultDate: m ? m[1] : todayDateStr() });
  }, [currentFile]);

  const confirmAddAppointment = useCallback(async ({ title, date, time, reminder }) => {
    setApptDialog(null);
    try {
      const d = await api.post("/api/journal", { date });
      await loadFile(d.filename);
      setView("outline");
      const nn = tree.newNode(title);
      nn.status = "TODO";
      // SCHEDULED must live in the :PROPERTIES: drawer (nn.properties), not
      // the body — this app's parser only recognizes it there (see
      // scanItemsForDates in internal/orgfile/agenda.go), unlike vanilla
      // org-mode's bare planning-line convention.
      nn.properties = { SCHEDULED: tree.formatOrgScheduled(date, time) };
      if (reminder) nn.properties.REMINDER = reminder;
      setNodes((prev) => [...(prev || []), nn]);
      markDirty();
      requestAnimationFrame(() => focusNode(nn.id));
    } catch {}
  }, [loadFile, setView, setNodes, markDirty, focusNode]);

  const exportToHtml = useCallback(() => {
    if (!currentFile) return;
    const html = generateExportHtml(nodes, preamble, currentFile, theme, resolveTopBarColor(topBarColor), outlineFormat, levelFormats);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile.replace(/\.org$/, "") + ".html";
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, preamble, currentFile, theme, topBarColor]);

  const exportToMarkdown = useCallback(() => {
    if (!currentFile) return;
    const md = generateMarkdown(nodes, preamble, currentFile);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile.replace(/\.org$/, "") + ".md";
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, preamble, currentFile]);

  const importFromMarkdown = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseMdToNodes(e.target.result);
      setNodes(result.nodes);
      if (result.preamble) setPreamble(result.preamble);
      markDirty();
    };
    reader.readAsText(file);
  }, [setNodes, setPreamble, markDirty]);

  const exportToOrg = useCallback(async () => {
    if (!currentFile || !nodesRef.current) return;
    try {
      const result = await api.post("/api/render", {
        preamble: preambleRef.current,
        nodes: nodesRef.current,
      });
      const content = result.text || "";
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pathBasename(currentFile) || "export.org";
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  }, [currentFile]);

  // Write text to clipboard with multiple fallbacks so it works across browsers
  // and privacy-hardened Chromium builds (Thorium, Brave, etc.).
  const writeToClipboard = useCallback(async (htmlStr, plainStr) => {
    // 1. Modern async Clipboard API with both types
    if (htmlStr && navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([htmlStr], { type: "text/html" }),
            "text/plain": new Blob([plainStr], { type: "text/plain" }),
          }),
        ]);
        return true;
      } catch {}
    }
    // 2. Plain text via async API
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(plainStr);
        return true;
      } catch {}
    }
    // 3. Legacy execCommand fallback (works even without clipboard permission)
    try {
      const ta = document.createElement("textarea");
      ta.value = plainStr;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {}
    return false;
  }, []);

  // Returns {type:"selection", items:[{node,depth}]} when the user has drag-selected
  // rows in the outline, otherwise {type:"subtree", nodes:[...]} for focused node / whole tree.
  const getCopySource = useCallback(() => {
    if (!nodes) return null;
    const base = hoistedId ? (tree.findNode(nodes, hoistedId)?.children || []) : nodes;

    // 1. Browser text selection spanning one or more outline rows
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const rows = [...document.querySelectorAll(".node-row[data-node-id]")];
      const selectedRows = rows.filter((r) => range.intersectsNode(r));
      if (selectedRows.length > 0) {
        const items = [];
        for (const row of selectedRows) {
          const id = row.dataset.nodeId;
          const depth = parseInt(row.dataset.depth || "0", 10);
          const node = tree.findNode(base, id);
          if (node) items.push({ node, depth });
        }
        if (items.length > 0) return { type: "selection", items };
      }
    }

    // 2. Focused node + its subtree
    if (focusedId && focusedId !== "preamble") {
      const focused = tree.findNode(base, focusedId);
      if (focused) return { type: "subtree", nodes: [focused] };
    }

    // 3. Entire visible tree
    return { type: "subtree", nodes: base };
  }, [nodes, hoistedId, focusedId]);

  const copyAsFormatted = useCallback(async () => {
    const src = getCopySource();
    if (!src) return;
    let htmlBody, plain;
    if (src.type === "selection") {
      htmlBody = tree.selectionToHtml(src.items);
      plain    = tree.selectionToPlainText(src.items);
    } else {
      htmlBody = tree.treeToHtml(src.nodes);
      plain    = tree.treeToPlainText(src.nodes);
    }
    const htmlFull = `<!DOCTYPE html><html><body>${htmlBody}</body></html>`;
    const ok = await writeToClipboard(htmlFull, plain);
    if (ok) { showToast("Copied to clipboard"); setSyncStatus(SYNC_COPIED); setTimeout(() => setSyncStatus(SYNC_SAVED), 2000); }
  }, [getCopySource, writeToClipboard, showToast]);

  const copyAsPlain = useCallback(async () => {
    const src = getCopySource();
    if (!src) return;
    const plain = src.type === "selection"
      ? tree.selectionToPlainText(src.items)
      : tree.treeToPlainText(src.nodes);
    const ok = await writeToClipboard(null, plain);
    if (ok) { showToast("Copied to clipboard"); setSyncStatus(SYNC_COPIED); setTimeout(() => setSyncStatus(SYNC_SAVED), 2000); }
  }, [getCopySource, writeToClipboard, showToast]);

  const canGoBack = navState.index > 0;
  const canGoForward = navState.index < navState.history.length - 1;

  const goBackRef = useRef(null);
  const goForwardRef = useRef(null);

  const goBack = useCallback(async () => {
    if (navState.index <= 0) return;
    const entry = navState.history[navState.index - 1];
    histNavRef.current = true;
    navDispatch({ type: "back" });
    if (entry.view) {
      setView(entry.view);
    } else if (entry.file !== currentFileRef.current) {
      if (entry.title) pendingTagNavRef.current = { title: entry.title };
      await loadFile(entry.file);
    } else if (entry.title) {
      const found = tree.findNodeByTitle(nodesRef.current, entry.title);
      if (found) { setNodes((prev) => tree.uncollapseToNode(prev, found.id)); focusNode(found.id); }
    }
    histNavRef.current = false;
  }, [navState, loadFile, focusNode, navDispatch]);

  const goForward = useCallback(async () => {
    if (navState.index >= navState.history.length - 1) return;
    const entry = navState.history[navState.index + 1];
    histNavRef.current = true;
    navDispatch({ type: "forward" });
    if (entry.view) {
      setView(entry.view);
    } else if (entry.file !== currentFileRef.current) {
      if (entry.title) pendingTagNavRef.current = { title: entry.title };
      await loadFile(entry.file);
    } else if (entry.title) {
      const found = tree.findNodeByTitle(nodesRef.current, entry.title);
      if (found) { setNodes((prev) => tree.uncollapseToNode(prev, found.id)); focusNode(found.id); }
    }
    histNavRef.current = false;
  }, [navState, loadFile, focusNode, navDispatch]);

  useEffect(() => { goBackRef.current = goBack; }, [goBack]);
  useEffect(() => { goForwardRef.current = goForward; }, [goForward]);

  const copyFormattedRef = useRef(null);
  const copyPlainRef = useRef(null);
  useEffect(() => { copyFormattedRef.current = copyAsFormatted; }, [copyAsFormatted]);
  useEffect(() => { copyPlainRef.current = copyAsPlain; }, [copyAsPlain]);
  const toggleHoistRef = useRef(null);
  useEffect(() => { toggleHoistRef.current = toggleHoist; }, [toggleHoist]);

  const enterTextMode = useCallback(async () => {
    if (!nodesRef.current) return;
    setTextModeError(false);
    try {
      const result = await api.post("/api/render", {
        preamble: preambleRef.current,
        nodes: nodesRef.current,
      });
      rawTextRef.current = result.text || "";
      setRawText(result.text || "");
      textDirtyRef.current = false;
      setTextMode(true);
    } catch (err) {
      setTextModeError(true);
    }
  }, []);

  const exitTextMode = useCallback(async () => {
    setTextModeError(false);
    try {
      const result = await api.post("/api/parse", {
        text: rawTextRef.current,
        collapsed: tree.collapsedMap(nodesRef.current || []),
      });
      // One undo boundary for the whole text-mode session — undoing after
      // returning to the outline reverts the entire raw-text edit at once.
      // (Edits within the session itself rely on the textarea's own native
      // undo, same as any plain text field.)
      undoStackRef.current.push({ nodes: nodesRef.current, preamble: preambleRef.current });
      if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
      redoStackRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
      setNodes(result.nodes || []);
      setPreamble(result.preamble || "");
      nodesRef.current = result.nodes || [];
      preambleRef.current = result.preamble || "";
      markDirty();
      setTextMode(false);
    } catch (err) {
      setTextModeError(true);
    }
  }, [markDirty]);

  const toggleTextMode = useCallback(() => {
    if (textModeRef.current) exitTextMode();
    else enterTextMode();
  }, [enterTextMode, exitTextMode]);

  // Three-way cycle: plain → formatted → reveal codes → plain
  const cycleViewMode = useCallback(() => {
    if (textModeRef.current) {
      exitTextMode();
      setTitleFormatMode(false);
      try { localStorage.setItem("epicorg.titleFormatMode", "0"); } catch {}
    } else if (titleFormatMode) {
      enterTextMode();
      setTitleFormatMode(false);
      try { localStorage.setItem("epicorg.titleFormatMode", "0"); } catch {}
    } else {
      setTitleFormatMode(true);
      try { localStorage.setItem("epicorg.titleFormatMode", "1"); } catch {}
    }
  }, [enterTextMode, exitTextMode, titleFormatMode]);

  const setViewMode = useCallback((mode) => {
    if (mode === "plain") {
      if (textModeRef.current) exitTextMode();
      setTitleFormatMode(false);
      try { localStorage.setItem("epicorg.titleFormatMode", "0"); } catch {}
    } else if (mode === "formatted") {
      if (textModeRef.current) exitTextMode();
      setTitleFormatMode(true);
      try { localStorage.setItem("epicorg.titleFormatMode", "1"); } catch {}
    } else if (mode === "reveal") {
      setTitleFormatMode(false);
      try { localStorage.setItem("epicorg.titleFormatMode", "0"); } catch {}
      if (!textModeRef.current) enterTextMode();
    }
  }, [enterTextMode, exitTextMode]);

  const handleCreateFile = useCallback(async (name) => {
    if (!name.endsWith(".org")) name += ".org";
    await api.post("/api/files", { filename: name });
    const data = await api.get("/api/files");
    setFiles(data.files || []);
    loadFile(name);
  }, [loadFile]);

  const handleDeleteFile = useCallback(async (name) => {
    await api.del("/api/files/" + encodeURIComponent(name));
    const data = await api.get("/api/files");
    setFiles(data.files || []);
    setFavorites((prev) => prev.filter((n) => n !== name));
    setRecentFiles((prev) => {
      const next = prev.filter((n) => n !== name);
      try { localStorage.setItem("epicorg.recentFiles", JSON.stringify(next)); } catch {}
      return next;
    });
    if (currentFileRef.current === name) {
      // The open file is gone — there's nothing to seamlessly continue
      // editing, so drop back to the picker.
      setCurrentFile(null);
      setNodes(null);
      setPreamble("");
      try {
        if (localStorage.getItem("epicorg.lastFile") === name) localStorage.removeItem("epicorg.lastFile");
      } catch {}
    }
  }, []);

  const handleRenameFile = useCallback(async (oldName, newName) => {
    const result = await api.put("/api/files/" + encodeURIComponent(oldName), { newName });
    const finalName = result.filename || newName;
    const data = await api.get("/api/files");
    setFiles(data.files || []);
    setFavorites((prev) => prev.map((n) => (n === oldName ? finalName : n)));
    setRecentFiles((prev) => {
      const next = prev.map((n) => (n === oldName ? finalName : n));
      try { localStorage.setItem("epicorg.recentFiles", JSON.stringify(next)); } catch {}
      return next;
    });
    if (currentFileRef.current === oldName) {
      setCurrentFile(finalName);
      try { localStorage.setItem("epicorg.lastFile", finalName); } catch {}
    }
    return result; // includes { filesChanged, replacements } for the sidebar notice
  }, []);

  // Background sync — also polls disk for external changes while idle, so
  // edits made outside epicorg (another editor, git pull, etc.) aren't
  // silently discarded by the next autosave.
  useEffect(() => {
    const interval = setInterval(async () => {
      const file = currentFileRef.current;
      if (!file || !nodesRef.current) return;

      if (textModeRef.current && textDirtyRef.current) {
        // Raw text has diverged from the node tree — reparse before any
        // save, so what gets written reflects the user's edits instead of
        // the stale tree captured when text mode was entered.
        textDirtyRef.current = false;
        setSyncStatus(SYNC_SAVING);
        try {
          const parsed = await api.post("/api/parse", {
            text: rawTextRef.current,
            collapsed: tree.collapsedMap(nodesRef.current),
          });
          setNodes(parsed.nodes || []);
          setPreamble(parsed.preamble || "");
          nodesRef.current = parsed.nodes || [];
          preambleRef.current = parsed.preamble || "";
          dirtyRef.current = true;
        } catch (err) {
          textDirtyRef.current = true;
          setSyncStatus(SYNC_ERROR);
          return;
        }
      }

      if (!dirtyRef.current) {
        // No local edits to lose — safe to pick up external changes
        // directly. Skipped while in text mode: adopting an external
        // change there would clobber whatever the user is mid-typing.
        if (textModeRef.current) return;
        try {
          const probe = await api.get(hashUrl(file));
          if (probe.hash && probe.hash !== hashRef.current) {
            const data = await api.get(docUrl(file));
            setNodes(data.nodes || []);
            setPreamble(data.preamble || "");
            setHash(data.hash || "");
            hashRef.current = data.hash || "";
            clearUndoHistory();
            setSyncStatus(SYNC_RELOADED);
          }
        } catch (err) {
          // Transient probe failure — try again next tick.
        }
        return;
      }

      dirtyRef.current = false;
      setSyncStatus(SYNC_SAVING);
      try {
        const result = await api.put(docUrl(file), {
          hash: hashRef.current,
          preamble: preambleRef.current,
          nodes: nodesRef.current,
        });
        setHash(result.hash);
        hashRef.current = result.hash;
        if (result.externalChange) {
          // The file changed on disk since our base; the server already
          // merged it. Adopt the merged result instead of re-overwriting it
          // on the next save.
          setNodes(result.nodes || []);
          setPreamble(result.preamble || "");
          clearUndoHistory();
          setSyncStatus(result.conflict ? SYNC_CONFLICT : SYNC_MERGED);
        } else {
          setSyncStatus(SYNC_SAVED);
        }
      } catch (err) {
        dirtyRef.current = true;
        setSyncStatus(SYNC_ERROR);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Popup reminders — polls the same workspace-wide agenda scan the Agenda
  // view uses, looking for SCHEDULED items whose REMINDER offset has come
  // due. Runs at the App level (not inside AgendaView) so it fires no
  // matter which view/file is open. Dismissed reminders are remembered in
  // localStorage, keyed by file+title+raw timestamp (node ids are ephemeral
  // and can't be used — see CLAUDE.md), so they don't reappear on reload
  // and a rescheduled item (new timestamp) is treated as a fresh reminder.
  const [dueReminders, setDueReminders] = useState([]);
  const dismissedRemindersRef = useRef(null);
  if (!dismissedRemindersRef.current) {
    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem("epicorg.dismissedReminders") || "[]"); } catch {}
    dismissedRemindersRef.current = new Set(dismissed);
  }

  const reminderKey = (it) => `${it.file}|${it.nodeTitle}|${it.scheduledRaw}`;

  const persistDismissedReminders = () => {
    try {
      const all = Array.from(dismissedRemindersRef.current);
      // Cap growth — keep only the most recently dismissed 500 keys.
      const trimmed = all.length > 500 ? all.slice(all.length - 500) : all;
      localStorage.setItem("epicorg.dismissedReminders", JSON.stringify(trimmed));
    } catch {}
  };

  const dismissReminder = useCallback((key) => {
    dismissedRemindersRef.current.add(key);
    persistDismissedReminders();
    setDueReminders((prev) => prev.filter((r) => r._key !== key));
  }, []);

  const checkReminders = useCallback(async () => {
    try {
      const data = await api.get("/api/agenda");
      const items = data.items || [];
      const now = Date.now();
      const due = [];
      for (const it of items) {
        if (it.kind !== "scheduled" || !it.reminder) continue;
        if (it.status === "DONE" || it.status === "CANCELLED") continue;
        const minutesBefore = parseInt(it.reminder, 10);
        if (Number.isNaN(minutesBefore)) continue;
        const when = new Date(`${it.date}T${it.time || "00:00"}:00`);
        if (Number.isNaN(when.getTime())) continue;
        if (now < when.getTime() - minutesBefore * 60000) continue;
        const key = reminderKey(it);
        if (dismissedRemindersRef.current.has(key)) continue;
        due.push({ ...it, _key: key });
      }
      setDueReminders((prev) => {
        const known = new Set(prev.map((p) => p._key));
        const fresh = due.filter((d) => !known.has(d._key));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    } catch {}
  }, []);

  useEffect(() => {
    checkReminders();
    const interval = setInterval(checkReminders, 60000);
    return () => clearInterval(interval);
  }, [checkReminders]);

  // Save on unload
  useEffect(() => {
    const handler = () => {
      if (!dirtyRef.current || !nodesRef.current || !currentFileRef.current) return;
      const body = JSON.stringify({
        hash: hashRef.current, preamble: preambleRef.current, nodes: nodesRef.current,
      });
      navigator.sendBeacon(
        docUrl(currentFileRef.current),
        new Blob([body], { type: "application/json" })
      );
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // When the user returns to this tab, re-focus whichever node (or preamble)
  // was focused before they left, so keyboard navigation resumes seamlessly.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const id = focusedIdRef.current;
      if (!id) return;
      const el = inputRefs.current[id];
      if (el) el.focus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Track the last outline textarea that had focus so applyMarkerToFocused
  // can target it even after the command palette or OAP has stolen focus.
  // Body notes render outside their node's .node-row (as a sibling, not a
  // descendant), so they're matched by class rather than the row ancestor.
  useEffect(() => {
    const onFocusIn = (e) => {
      if (e.target.tagName === "TEXTAREA"
          && (e.target.closest(".node-row, .preamble-row") || e.target.classList.contains("node-body-textarea"))) {
        _setLastOutlineTextarea(e.target);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Keep a stable ref to loadFile so the delegated link handler below always
  // calls the current version without re-registering the listener on every render.
  const loadFileRef = useRef(null);
  useEffect(() => { loadFileRef.current = loadFile; }, [loadFile]);

  // Delegated handler for [[file:...]] org links rendered via dangerouslySetInnerHTML.
  // Bare .org filenames (no path separators) are opened in-app; everything
  // else is handed to xdg-open on the server.
  useEffect(() => {
    const handler = (e) => {
      const link = e.target.closest(".org-file-link");
      if (!link) return;
      e.stopPropagation();
      const path = link.getAttribute("data-file-path");
      if (path && path.endsWith(".org") && !path.includes("/") && !path.includes("\\")) {
        // Bare .org filename: load in-app instead of following the href.
        e.preventDefault();
        loadFileRef.current?.(path);
      }
      // All other .org-file-link elements have a real file:// href —
      // don't preventDefault so the browser navigates natively.
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);

  const handleAgendaSelect = useCallback((item) => {
    // TodoView passes a plain ID string; AgendaView passes a full item object.
    if (typeof item === "string") { setView("outline"); jumpToNode(item); return; }
    if (item.file && item.file !== currentFile) {
      navDispatch({ type: "push", entry: { view: "agenda" } });
      pendingJumpTitleRef.current = item.title;
      loadFile(item.file);
      setView("outline");
    } else {
      setView("outline");
      jumpToNode(item.id);
    }
  }, [jumpToNode, currentFile, loadFile, navDispatch]);

  // Dispatch: all operations are local state mutations
  const dispatch = useCallback((nodeId, action, value) => {
    maybeSnapshotForUndo(action, nodeId);

    const navTree = visibleNodesRef.current || nodesRef.current || [];
    const flat = [{ id: "preamble" }, ...tree.flattenVisible(navTree)];
    const idx = flat.findIndex((n) => n.id === nodeId);

    if (action === "focus") {
      if (nodeId === "preamble") {
        // The preamble has no editable surface in the outline itself (unlike
        // a regular node's title) — the detail pane is the only way to see
        // or edit it, so focusing it should reveal that pane, not hide it.
        setFocusedId(nodeId);
        setDetailVisiblePersisted(true);
        return;
      }
      // Deliberately doesn't close the detail pane on navigation — once
      // open, it stays open across items (showing whichever is focused)
      // until explicitly closed via the Details toggle.
      setFocusedId(nodeId);
      return;
    }

    if (action === "release-focus") { setFocusedId(null); return; }

    if (action === "edit-title") { focusNode(nodeId); return; }

    if (action === "preview-body") {
      setBodyPreviewId(nodeId);
      return;
    }

    if (action === "edit-body") {
      setBodyPreviewId(null);
      setBodyEditingId(nodeId);
      pendingFocusRef.current = null; // Prevent focus effect from refocusing title textarea
      requestAnimationFrame(() => { bodyRefs.current[nodeId]?.focus(); });
      return;
    }

    if (action === "stop-edit-body") {
      setBodyEditingId((prev) => (prev === nodeId ? null : prev));
      return;
    }

    if (action === "focus-outline") {
      setBodyEditingId((prev) => (prev === nodeId ? null : prev));
      setFocusedId(nodeId);
      requestAnimationFrame(() => {
        const el = inputRefs.current[nodeId];
        if (el) { el.focus(); if (el.setSelectionRange) el.selectionStart = el.selectionEnd = el.value?.length || 0; }
      });
      return;
    }

    if (action === "focus-body") {
      // Preamble's content has no inline equivalent (it isn't a bulleted
      // item), so it still lives in the detail pane. Every other node's
      // notes are now inline under its bullet.
      if (nodeId === "preamble") {
        setDetailVisiblePersisted(true);
        requestAnimationFrame(() => { detailPaneRef.current?.focusBody(); });
        return;
      }
      pendingFocusRef.current = null; // Prevent focus effect from refocusing title textarea
      setBodyEditingId(nodeId);
      requestAnimationFrame(() => { bodyRefs.current[nodeId]?.focus(); });
      return;
    }
    if (action === "nav-up" && idx > 0) { focusNode(flat[idx - 1].id); return; }
    if (action === "nav-down" && idx < flat.length - 1) { focusNode(flat[idx + 1].id); return; }

    if (nodeId === "preamble") {
      if (action === "change-preamble") { setPreamble(value); markDirty(); }
      return;
    }

    if (action === "change") { setNodes((p) => tree.updateNodeField(p, nodeId, "title", value)); markDirty(); return; }
    if (action === "change-body") { setNodes((p) => tree.updateNodeField(p, nodeId, "body", value)); markDirty(); return; }
    if (action === "update-properties") { setNodes((p) => tree.updateNodeField(p, nodeId, "properties", value)); markDirty(); return; }
    if (action === "update-tags") { setNodes((p) => tree.updateNodeField(p, nodeId, "tags", value)); markDirty(); return; }
    if (action === "update-bookmarks") {
      setNodes((prev) => {
        const n = tree.findNode(prev, nodeId);
        if (!n) return prev;
        const props = { ...(n.properties || {}) };
        if (value.length > 0) { props.BOOKMARKS = value.join(" "); } else { delete props.BOOKMARKS; }
        return tree.updateNodeField(prev, nodeId, "properties", props);
      });
      markDirty();
      return;
    }
    if (action === "set-status") { setNodes((p) => tree.updateNodeField(p, nodeId, "status", value)); markDirty(); return; }
    if (action === "set-priority") { setNodes((p) => tree.updateNodeField(p, nodeId, "priority", value)); markDirty(); return; }

    if (action === "cycle-status") {
      setNodes((p) => {
        const node = tree.findNode(p, nodeId);
        return node ? tree.updateNodeField(p, nodeId, "status", tree.nextStatus(node.status)) : p;
      });
      markDirty(); return;
    }

    if (action === "toggle") {
      setNodes((p) => {
        const node = tree.findNode(p, nodeId);
        return node ? tree.updateNodeField(p, nodeId, "collapsed", !node.collapsed) : p;
      });
      markDirty(); return;
    }

    if (action === "new-sibling") {
      setSearchQuery("");
      setNodes((p) => {
        const { nodes: updated, newId } = tree.insertSiblingAfter(p, nodeId);
        requestAnimationFrame(() => focusNode(newId));
        return updated;
      });
      markDirty(); return;
    }

    if (action === "new-sibling-before") {
      // The current node keeps its id and content, so it (and its cursor
      // position) stays focused automatically via React's key-based
      // reconciliation — no explicit refocus needed.
      setSearchQuery("");
      setNodes((p) => tree.insertSiblingBefore(p, nodeId).nodes);
      markDirty(); return;
    }

    if (action === "delete") {
      const prevId = idx > 1 ? flat[idx - 1].id : (flat.length > 2 ? flat[2]?.id : null);
      setNodes((p) => tree.removeNode(p, nodeId));
      if (prevId && prevId !== "preamble") focusNode(prevId);
      markDirty(); return;
    }

    if (action === "duplicate") {
      setNodes((p) => {
        const { nodes: updated, newId } = tree.duplicateNode(p, nodeId);
        requestAnimationFrame(() => focusNode(newId));
        return updated;
      });
      markDirty(); return;
    }

    if (action === "indent") { setNodes((p) => tree.indentNode(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "outdent") { setNodes((p) => tree.outdentNode(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "move-up") { setNodes((p) => tree.moveNodeUp(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "move-down") { setNodes((p) => tree.moveNodeDown(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "indent-only") { setNodes((p) => tree.indentNodeOnly(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "outdent-only") { setNodes((p) => tree.outdentNodeOnly(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "move-up-only") { setNodes((p) => tree.moveNodeUpOnly(p, nodeId)); focusNode(nodeId); markDirty(); return; }
    if (action === "move-down-only") { setNodes((p) => tree.moveNodeDownOnly(p, nodeId)); focusNode(nodeId); markDirty(); return; }

    if (action === "split-at-cursor") {
      const pos = typeof value === "number" ? value : 0;
      setNodes((p) => {
        const { nodes: updated, newId } = tree.splitNode(p, nodeId, pos);
        requestAnimationFrame(() => focusNode(newId));
        return updated;
      });
      markDirty(); return;
    }

    if (action === "join-with-next") {
      const curNode = flat[idx];
      const cursorPos = curNode ? (curNode.title || "").length : 0;
      pendingCursorPosRef.current = cursorPos;
      setNodes((p) => tree.joinNodes(p, nodeId).nodes);
      focusNode(nodeId);
      markDirty(); return;
    }

    if (action === "split-body-at-cursor") {
      const pos = typeof value === "number" ? value : 0;
      setNodes((p) => {
        const { nodes: updated, newId } = tree.splitBodyAtCursor(p, nodeId, pos);
        setBodyPreviewId(null);
        setBodyEditingId(newId);
        setFocusedId(newId);
        requestAnimationFrame(() => {
          const el = bodyRefs.current[newId];
          if (el) { el.focus(); el.selectionStart = el.selectionEnd = 0; }
        });
        return updated;
      });
      markDirty(); return;
    }
  }, [focusNode, markDirty, maybeSnapshotForUndo]);

  // Cleans up the selected text via dispatch (not a raw DOM "input" event)
  // because a body note's textarea unmounts into a formatted preview the
  // instant it blurs (see "stop-edit-body" above) — by the time this command
  // runs from the palette, focus has already left the textarea and it's been
  // detached from the tree, so el.closest(...) can no longer find its node.
  // _lastOutlineTextareaMeta was captured earlier, while still attached.
  const cleanUpSelectedText = useCallback(() => {
    const isLive = document.activeElement?.tagName === "TEXTAREA";
    const el = isLive ? document.activeElement : _lastOutlineTextarea;
    if (!el || el.tagName !== "TEXTAREA") return;
    const meta = isLive ? fieldMetaForTextarea(el) : _lastOutlineTextareaMeta;
    if (!meta) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    if (start === end) return;
    const cleaned = cleanUpText(value.slice(start, end));
    const newVal = value.slice(0, start) + cleaned + value.slice(end);
    dispatch(meta.nodeId, meta.field, newVal);
    requestAnimationFrame(() => {
      if (document.body.contains(el)) el.setSelectionRange(start, start + cleaned.length);
    });
  }, [dispatch]);

  // Splits whichever field (title or note) was last focused at the cursor —
  // the palette (and a rebindable shortcut, see handleKey/onKeyDown above)
  // equivalent of Ctrl+Shift+S. Deliberately cursor-position-based rather
  // than selection-based: a range selection collapses/gets lost the instant
  // the palette steals focus, but a single cursor position can't. Uses
  // _lastOutlineTextarea rather than inputRefs/bodyRefs directly for the
  // same reason as cleanUpSelectedText above — a body note's textarea in
  // particular unmounts into a preview the instant it blurs.
  const splitAtCursorLocation = useCallback(() => {
    const isLive = document.activeElement?.tagName === "TEXTAREA";
    const el = isLive ? document.activeElement : _lastOutlineTextarea;
    if (!el || el.tagName !== "TEXTAREA") return;
    const meta = isLive ? fieldMetaForTextarea(el) : _lastOutlineTextareaMeta;
    if (!meta || (meta.field !== "change" && meta.field !== "change-body")) return;
    const action = meta.field === "change-body" ? "split-body-at-cursor" : "split-at-cursor";
    dispatch(meta.nodeId, action, el.selectionStart);
  }, [dispatch]);

  const onNodeHandleMouseDown = useCallback((nodeId, e) => {
    dragStateRef.current = { nodeId, startX: e.clientX, startY: e.clientY, pending: true };
  }, []);

  const onNodeHandleMenu = useCallback((nodeId, x, y) => {
    setNodeMenu({ nodeId, x, y });
  }, []);

  useEffect(() => {
    const INDENT = 24;
    let rafId = null;
    let lastX = 0, lastY = 0;

    const computeDrop = (mouseX, mouseY) => {
      const content = document.querySelector(".outline-content");
      if (!content || !dragStateRef.current) return null;
      const cr = content.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".node-row[data-node-id]")];
      if (!rows.length) return null;
      const ns = nodesRef.current;
      const dragId = dragStateRef.current.nodeId;

      const vis = rows.filter(r => !tree.isDescendantOrSelf(ns, dragId, r.dataset.nodeId));
      let afterEl = null;
      for (const row of vis) {
        const r = row.getBoundingClientRect();
        if (mouseY > r.top + r.height / 2) afterEl = row;
        else break;
      }

      const afterId = afterEl ? afterEl.dataset.nodeId : null;
      const afterDepth = afterEl ? parseInt(afterEl.dataset.depth) : -1;
      const afterIdx = afterEl ? vis.indexOf(afterEl) : -1;
      const belowEl = vis[afterIdx + 1] || null;
      const belowDepth = belowEl ? parseInt(belowEl.dataset.depth) : 0;

      const maxDepth = afterDepth + 1;
      const minDepth = belowEl ? belowDepth : 0;
      const rawDepth = Math.round((mouseX - cr.left - 16) / INDENT);
      const targetDepth = Math.max(minDepth, Math.min(maxDepth, Math.max(0, rawDepth)));

      let lineY;
      if (afterEl) {
        const ar = afterEl.getBoundingClientRect();
        lineY = belowEl ? (ar.bottom + belowEl.getBoundingClientRect().top) / 2 : ar.bottom + 4;
      } else {
        const br = vis[0]?.getBoundingClientRect();
        lineY = br ? br.top - 4 : cr.top;
      }

      return { afterId, targetDepth, lineY, lineLeft: cr.left + targetDepth * INDENT + 16 };
    };

    const onMove = (e) => {
      if (!dragStateRef.current) return;
      lastX = e.clientX; lastY = e.clientY;
      const ds = dragStateRef.current;

      if (ds.pending) {
        if (Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY) < 5) return;
        ds.pending = false;
        document.body.classList.add("dnd-dragging");
      }

      const pane = document.querySelector(".outline-pane");
      if (pane) {
        const pr = pane.getBoundingClientRect();
        if (e.clientY < pr.top + 60) pane.scrollBy(0, -8);
        else if (e.clientY > pr.bottom - 60) pane.scrollBy(0, 8);
      }

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!dragStateRef.current || dragStateRef.current.pending) return;
        const drop = computeDrop(lastX, lastY);
        const dragNode = tree.findNode(nodesRef.current, dragStateRef.current.nodeId);
        setDragVisual(drop ? { ghostTitle: dragNode?.title || "", ghostX: lastX, ghostY: lastY, ...drop } : null);
      });
    };

    const onUp = (e) => {
      if (!dragStateRef.current) return;
      const ds = dragStateRef.current;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      document.body.classList.remove("dnd-dragging");

      if (ds.pending) {
        // A click on the handle with no real drag — open its action menu,
        // rather than moving anything.
        setNodeMenu({ nodeId: ds.nodeId, x: e.clientX, y: e.clientY });
      } else {
        const dv = dragVisualRef.current;
        if (dv) { setNodes(prev => tree.moveDragNode(prev, ds.nodeId, dv.afterId, dv.targetDepth)); markDirty(); }
      }
      dragStateRef.current = null;
      setDragVisual(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.body.classList.remove("dnd-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dispatch, markDirty]);

  const joinFocusedWithNext = useCallback(() => {
    const id = focusedIdRef.current;
    if (!id || id === "preamble") return;
    dispatch(id, "join-with-next");
  }, [dispatch]);

  const outlineAction = useCallback((action) => {
    const id = focusedIdRef.current;
    if (id && id !== "preamble") dispatch(id, action);
  }, [dispatch]);

  // Called by AgendaScheduleEditor for current-file nodes only.
  const handleAgendaEditNode = useCallback((nodeId, newProps) => {
    dispatch(nodeId, "update-properties", newProps);
    markDirty();
  }, [dispatch, markDirty]);

  const navigateToBookmark = useCallback((bm) => {
    setHoistedId((prevHoist) =>
      prevHoist && !tree.isDescendantOrSelf(nodesRef.current || [], prevHoist, bm.id) ? null : prevHoist
    );
    setNodes((prev) => tree.uncollapseToNode(prev, bm.id));
    focusNode(bm.id);
  }, [focusNode]);

  const deleteBookmark = useCallback((bookmarkName) => {
    const bm = bookmarks.find((b) => b.bookmark === bookmarkName);
    if (!bm) return;
    const node = tree.findNode(nodesRef.current || [], bm.id);
    if (!node) return;
    const updated = { ...(node.properties || {}) };
    delete updated.BOOKMARK;
    dispatch(bm.id, "update-properties", updated);
    updateBookmarkOrder(bookmarkOrderRef.current.filter((n) => n !== bookmarkName));
  }, [bookmarks, dispatch, updateBookmarkOrder]);

  const saveGlobalBookmarks = useCallback((list) => {
    setGlobalBookmarks(list);
    globalBookmarksRef.current = list;
    api.put("/api/global-bookmarks", { bookmarks: list }).catch(() => {});
  }, []);

  const navigateToGlobalBookmark = useCallback((bm) => {
    if (bm.file === currentFileRef.current) {
      const node = tree.findNodeByProperty(nodesRef.current || [], "BOOKMARK", bm.name);
      if (node) {
        setNodes((prev) => tree.uncollapseToNode(prev, node.id));
        focusNode(node.id);
      }
    } else {
      pendingGlobalBookmarkRef.current = bm.name;
      loadFile(bm.file);
    }
  }, [focusNode, loadFile]);

  const deleteGlobalBookmark = useCallback((name) => {
    saveGlobalBookmarks(globalBookmarksRef.current.filter((b) => b.name !== name));
  }, [saveGlobalBookmarks]);

  const reorderGlobalBookmarks = useCallback((reordered) => {
    saveGlobalBookmarks(reordered);
  }, [saveGlobalBookmarks]);

  const toggleGlobalBookmark = useCallback((bookmarkName, makeGlobal) => {
    if (!bookmarkName) return;
    const file = currentFileRef.current;
    let updated = globalBookmarksRef.current.filter((b) => !(b.name === bookmarkName && b.file === file));
    if (makeGlobal) updated = [...updated, { name: bookmarkName, file }];
    saveGlobalBookmarks(updated);
  }, [saveGlobalBookmarks]);

  const renameGlobalBookmark = useCallback((oldName, newName) => {
    if (!oldName) return;
    const file = currentFileRef.current;
    const wasGlobal = globalBookmarksRef.current.some((b) => b.name === oldName && b.file === file);
    if (!wasGlobal) return;
    let updated = globalBookmarksRef.current.filter((b) => !(b.name === oldName && b.file === file));
    if (newName) updated = [...updated, { name: newName, file }];
    saveGlobalBookmarks(updated);
  }, [saveGlobalBookmarks]);

  const updateGlobalTags = useCallback((newTags) => {
    setGlobalTags(newTags);
    globalTagsRef.current = newTags;
    api.put("/api/global-tags", { tags: newTags }).catch(() => {});
  }, []);

  const addTagToItem = useCallback((tagName) => {
    const fId = focusedIdRef.current;
    if (!fId || fId === "preamble") return;
    const node = tree.findNode(nodesRef.current || [], fId);
    if (!node) return;
    const tags = node.tags || [];
    if (!tags.includes(tagName)) dispatch(node.id, "update-tags", [...tags, tagName]);
  }, [dispatch]);

  const addToGlobalTags = useCallback((tagName) => {
    setGlobalTags((prev) => {
      if (tagExistsInTree(prev, tagName)) return prev;
      const updated = [...prev, { name: tagName, children: [], collapsed: false }];
      globalTagsRef.current = updated;
      api.put("/api/global-tags", { tags: updated }).catch(() => {});
      return updated;
    });
  }, []);

  const nestTag = useCallback((sourceName, targetName) => {
    if (sourceName === targetName) return;
    setGlobalTags((prev) => {
      const sourceTag = (() => { const [, t] = removeTagFromTree(prev, sourceName); return t; })();
      if (!sourceTag) return prev;
      // Don't allow nesting under a descendant of the source (would create a cycle)
      if (tagExistsInTree(sourceTag.children || [], targetName)) return prev;
      const [withoutSource] = removeTagFromTree(prev, sourceName);
      const updated = addTagAsChild(withoutSource, targetName, sourceTag);
      globalTagsRef.current = updated;
      api.put("/api/global-tags", { tags: updated }).catch(() => {});
      return updated;
    });
  }, []);

  const updateGlobalBMs = useCallback((newBMs) => {
    setGlobalBMs(newBMs);
    globalBMsRef.current = newBMs;
    api.put("/api/bookmarks", { bookmarks: newBMs }).catch(() => {});
  }, []);

  const addBMToItem = useCallback((bmName) => {
    const fId = focusedIdRef.current;
    if (!fId || fId === "preamble") return;
    const node = tree.findNode(nodesRef.current || [], fId);
    if (!node) return;
    const bms = (node.properties?.BOOKMARKS || "").split(" ").filter(Boolean);
    if (!bms.includes(bmName)) dispatch(node.id, "update-bookmarks", [...bms, bmName]);
  }, [dispatch]);

  const addToGlobalBMs = useCallback((bmName) => {
    setGlobalBMs((prev) => {
      if (tagExistsInTree(prev, bmName)) return prev;
      const updated = [...prev, { name: bmName, children: [], collapsed: false }];
      globalBMsRef.current = updated;
      api.put("/api/bookmarks", { bookmarks: updated }).catch(() => {});
      return updated;
    });
  }, []);

  const nestBM = useCallback((sourceName, targetName) => {
    if (sourceName === targetName) return;
    setGlobalBMs((prev) => {
      const sourceBM = (() => { const [, t] = removeTagFromTree(prev, sourceName); return t; })();
      if (!sourceBM) return prev;
      if (tagExistsInTree(sourceBM.children || [], targetName)) return prev;
      const [withoutSource] = removeTagFromTree(prev, sourceName);
      const updated = addTagAsChild(withoutSource, targetName, sourceBM);
      globalBMsRef.current = updated;
      api.put("/api/bookmarks", { bookmarks: updated }).catch(() => {});
      return updated;
    });
  }, []);

  const openBookmarkFile = useCallback(() => {
    if (bookmarkListFile && homeDir && bookmarkListFile.startsWith(homeDir + "/")) {
      setCurrentFile(bookmarkListFile.slice(homeDir.length + 1));
    } else if (bookmarkListFile) {
      setCurrentFile(bookmarkListFile);
    } else {
      setCurrentFile("Bookmarks.org");
    }
  }, [bookmarkListFile, homeDir]);

  const setBookmarkPanelWidthPersisted = useCallback((w) => {
    setBookmarkPanelWidth(w);
    try { localStorage.setItem("epicorg.bookmarkPanelWidth", String(w)); } catch {}
  }, []);

  const toggleBookmarkPanel = useCallback(() => {
    setBookmarkPanelVisible((v) => {
      const next = !v;
      try { localStorage.setItem("epicorg.bookmarkPanelVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // When navigating away from TagList.org or Bookmarks.org, reload so any edits take effect.
  const prevFileRef = useRef(null);
  useEffect(() => {
    const effectiveTagFile = tagListFile && homeDir && tagListFile.startsWith(homeDir + "/")
      ? tagListFile.slice(homeDir.length + 1)
      : "TagList.org";
    const effectiveBMFile = bookmarkListFile && homeDir && bookmarkListFile.startsWith(homeDir + "/")
      ? bookmarkListFile.slice(homeDir.length + 1)
      : "Bookmarks.org";
    if (prevFileRef.current === effectiveTagFile && currentFile !== effectiveTagFile) {
      api.get("/api/global-tags").then((d) => {
        const tags = d.tags || [];
        setGlobalTags(tags);
        globalTagsRef.current = tags;
      }).catch(() => {});
    }
    if (prevFileRef.current === effectiveBMFile && currentFile !== effectiveBMFile) {
      api.get("/api/bookmarks").then((d) => {
        const bms = d.bookmarks || [];
        setGlobalBMs(bms);
        globalBMsRef.current = bms;
      }).catch(() => {});
    }
    prevFileRef.current = currentFile;
  }, [currentFile, tagListFile, bookmarkListFile, homeDir]);

  const openTagFile = useCallback(() => {
    if (tagListFile && homeDir && tagListFile.startsWith(homeDir + "/")) {
      setCurrentFile(tagListFile.slice(homeDir.length + 1));
    } else {
      setCurrentFile("TagList.org");
    }
  }, [tagListFile, homeDir]);

  const setTagPanelWidthPersisted = useCallback((w) => {
    setTagPanelWidth(w);
    try { localStorage.setItem("epicorg.tagPanelWidth", String(w)); } catch {}
  }, []);

  const toggleTagPanel = useCallback(() => {
    setTagPanelVisible((v) => {
      const next = !v;
      try { localStorage.setItem("epicorg.tagPanelVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // Multi-node delete: drag-select across whole rows and press Delete/Backspace.
  // A node only counts as "selected" here when every part of it (title, and
  // body if shown — they're DOM siblings, not nested) lies entirely inside
  // the range. A selection that merely starts or ends mid-text in a
  // boundary node is a normal text selection that happens to cross a node
  // boundary, not a request to delete that whole node — treating it as one
  // would silently destroy far more than the user selected.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);

      const els = [...document.querySelectorAll(".node-row[data-node-id], .node-body-preview[data-node-id]")];
      const byNode = new Map();
      for (const el of els) {
        const id = el.dataset.nodeId;
        if (!byNode.has(id)) byNode.set(id, []);
        byNode.get(id).push(el);
      }

      const boundsRange = document.createRange();
      const fullyCovers = (el) => {
        boundsRange.selectNodeContents(el);
        return range.compareBoundaryPoints(Range.START_TO_START, boundsRange) <= 0
            && range.compareBoundaryPoints(Range.END_TO_END, boundsRange) >= 0;
      };

      const selectedIds = [];
      for (const [id, parts] of byNode) {
        if (!parts.some((el) => range.intersectsNode(el))) continue;
        if (!parts.every(fullyCovers)) return; // partial coverage — bail, delete nothing
        selectedIds.push(id);
      }
      if (selectedIds.length < 2) return;

      e.preventDefault();
      sel.removeAllRanges();
      [...selectedIds].reverse().forEach((id) => dispatch(id, "delete"));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const focusedDepth = useMemo(() => {
    if (!focusedId || focusedId === "preamble" || !nodes) return -1;
    const search = (arr, id, d) => { for (const n of (arr || [])) { if (n.id === id) return d; const r = search(n.children, id, d + 1); if (r >= 0) return r; } return -1; };
    return search(nodes, focusedId, 0);
  }, [focusedId, nodes]);

  // Loading state. Also covers the brief window where the file list has
  // arrived but the auto-load of the last/default/sole file is still in
  // flight — without this, the file picker would flash before that file
  // finishes loading.
  if (files === null || (!currentFile && autoLoadPending)) return html`<div className="empty">Loading...</div>`;

  // File picker (no file selected, or the user explicitly asked to switch)
  if (!currentFile || showPicker) {
    return html`
      <div className="app-shell">
        <${Header} onHelp=${() => setShowHelp(true)} syncStatus=${syncStatus}
                    view=${view} setView=${setView} currentFile=${null}
                    theme=${theme} onToggleTheme=${toggleTheme} />
        <${FilePicker} files=${files} onSelect=${loadFile} onCreate=${handleCreateFile}
          onRename=${handleRenameFile} onDelete=${handleDeleteFile}
          onClose=${currentFile ? () => setShowPicker(false) : null}
          onChangeHomeFolder=${() => setShowFolderPicker(true)} />
      </div>
    `;
  }

  // Document loading
  if (nodes === null) return html`<div className="empty">Loading...</div>`;

  const isPreambleFocused = focusedId === "preamble";
  const focusedNode = (!isPreambleFocused && focusedId) ? tree.findNode(nodes, focusedId) : null;
  const detailNode = isPreambleFocused ? { body: preamble } : focusedNode;
  const detailKey = isPreambleFocused ? "preamble" : focusedId;
  visibleNodesRef.current = visibleNodes;

  // Drop favorites/recents for files that no longer exist (renamed/deleted).
  // Absolute paths (opened via filesystem navigator) are always kept — they
  // live outside the workspace file list but are still valid.
  const existingNames = new Set((files || []).map((f) => f.name));
  const validFavorites = favorites.filter((name) => name.startsWith("/") || existingNames.has(name));
  const validRecentFiles = recentFiles.filter((name) => name.startsWith("/") || existingNames.has(name));

  // Global bookmark names for current file — used to split sidebar sections and
  // drive the checkbox in the detail pane.
  const globalNamesForFile = new Set(globalBookmarks.filter((b) => b.file === currentFile).map((b) => b.name));
  const fileOnlyBookmarks = orderedBookmarks.filter((bm) => !globalNamesForFile.has(bm.bookmark));
  const focusedBookmarkName = focusedNode?.properties?.BOOKMARK || "";
  const isBookmarkGlobal = !!focusedBookmarkName && globalNamesForFile.has(focusedBookmarkName);

  return html`
    <div className="app-shell">
      ${headerCollapsed && html`
        <button className="header-collapsed-tab" onClick=${toggleHeaderCollapsed}
                style=${{ background: resolveTopBarColor(topBarColor) || "var(--panel-bg)", color: resolveTopBarColor(topBarColor) ? "#fff" : "var(--text)" }}
                title="Show top bar">▾</button>
      `}
      ${!headerCollapsed && html`
      <${Header} onHelp=${() => setShowHelp(true)} syncStatus=${syncStatus}
                  view=${view} setView=${setView} currentFile=${currentFile}
                  searchQuery=${searchQuery} setSearchQuery=${setSearchQuery}
                  searchInputRef=${searchInputRef}
                  filterExpanded=${filterExpanded} setFilterExpanded=${setFilterExpanded}
                  allTags=${allTags} selectedTags=${selectedTags}
                  onToggleTag=${toggleTag} onClearTags=${clearTags}
                  detailVisible=${detailVisible}
                  onToggleDetails=${() => setDetailVisiblePersisted((v) => !v)}
                  titleFormatMode=${titleFormatMode} onToggleTitleFormat=${toggleTitleFormatMode}
                  textMode=${textMode} onToggleTextMode=${toggleTextMode} textModeError=${textModeError}
                  onCycleViewMode=${cycleViewMode} onSetViewMode=${setViewMode}
                  canUndo=${canUndo} canRedo=${canRedo} onUndo=${undo} onRedo=${redo}
                  notesVisible=${notesVisible} onToggleNotesVisible=${toggleNotesVisible}
                  outlineFormat=${outlineFormat} onSetOutlineFormat=${setOutlineFormat} levelFormats=${levelFormats} onSetLevelFormat=${setLevelFormat}
                  globalFont=${globalFont} onSetGlobalFont=${setGlobalFont} levelFonts=${levelFonts} onSetLevelFont=${setLevelFont}
                  globalColor=${globalColor} onSetGlobalColor=${setGlobalColor} levelColors=${levelColors} onSetLevelColor=${setLevelColor}
                  verticalLines=${verticalLines} onToggleVerticalLines=${toggleVerticalLines}
                  showTagChips=${showTagChips} onToggleShowTagChips=${toggleShowTagChips}
                  tagsOnRight=${tagsOnRight} onToggleTagsOnRight=${toggleTagsOnRight}
                  isHoisted=${isHoisted} canToggleHoist=${isHoisted || (focusedId && focusedId !== "preamble")} onToggleHoist=${toggleHoist}
                  readingWidth=${readingWidth} onToggleReadingWidth=${toggleReadingWidth}
                  sidebarVisible=${sidebarVisible} onToggleSidebar=${toggleSidebar}
                  onFoldToLevel=${foldToLevel}
                  theme=${theme} onToggleTheme=${toggleTheme}
                  topBarColor=${topBarColor} onSetTopBarColor=${setTopBarColorPersisted}
                  tagPanelVisible=${tagPanelVisible} onToggleTagPanel=${toggleTagPanel}
                  bookmarkPanelVisible=${bookmarkPanelVisible} onToggleBookmarkPanel=${toggleBookmarkPanel}
                  onBack=${() => setShowPicker(true)}
                  homeDir=${homeDir} onPickHomeDir=${() => setShowFolderPicker(true)}
                  journalDir=${journalDir} onPickJournalDir=${() => setShowJournalFolderPicker(true)}
                  onClearJournalDir=${clearJournalDir}
                  tagListFile=${tagListFile} onPickTagListFile=${() => setShowTagListFilePicker(true)}
                  onClearTagListFile=${clearTagListFile}
                  bookmarkListFile=${bookmarkListFile} onPickBookmarkListFile=${() => setShowBookmarkListFilePicker(true)}
                  onClearBookmarkListFile=${clearBookmarkListFile}
                  onOpenTextSearch=${() => setShowTextSearch(true)}
                  onOpenSearchPanel=${() => setSearchPanelOpen((v) => !v)}
                  searchPanelOpen=${searchPanelOpen}
                  canGoBack=${canGoBack} canGoForward=${canGoForward}
                  onGoBack=${goBack} onGoForward=${goForward}
                  homeFile=${homeFile} onGoHome=${() => { if (homeFile) { loadFile(homeFile); setView("outline"); } }}
                  onSetHomeFile=${setHomeFilePersisted}
                  toolbarConfig=${toolbarConfig}
                  statusBarVisible=${statusBarVisible} onToggleStatusBar=${toggleStatusBarVisible}
                  dateStampFmt=${dateStampFmt} onSetDateStampFmt=${setDateStampFmt}
                  onShowShortcutEditor=${() => setShowShortcutEditor(true)}
                  onShowOutlineActions=${() => setShowOutlineActions(true)}
                  onShowToolbarCustomizer=${() => setShowToolbarCustomizer(true)}
                  onOpenSettings=${(sec) => { setShowSettings(true); if (sec) setSettingsSection(sec); }}
                  onExportToOrg=${exportToOrg}
                  onExportToHtml=${exportToHtml} />
      `}
      ${showOutlineActions && html`
        <${OutlineActionsPanel}
          focusedId=${focusedId}
          onAction=${outlineAction}
          onClose=${() => setShowOutlineActions(false)} />`}
      ${nodeMenu && html`
        <${NodeActionMenu}
          x=${nodeMenu.x} y=${nodeMenu.y} nodeId=${nodeMenu.nodeId}
          isHoisted=${hoistedId === nodeMenu.nodeId}
          dispatch=${dispatch} onToggleHoistNode=${toggleHoistNode}
          onClose=${() => setNodeMenu(null)} />`}
      ${showHelp && html`<${CommandPalette} commands=${buildCommands({
          undo, redo, canUndo, canRedo,
          goBack, goForward, canGoBack, canGoForward,
          toggleTheme, toggleTitleFormatMode, toggleTextMode, cycleViewMode,
          titleFormatMode, textMode,
          toggleNotesVisible, notesVisible,
          outlineFormat, setOutlineFormat, levelFormats, setLevelFormat, focusedDepth,
          toggleVerticalLines, verticalLines,
          toggleReadingWidth, readingWidth,
          toggleSidebar, sidebarVisible,
          toggleNavPanel, toggleHeaderCollapsed,
          toggleHoist, isHoisted,
          toggleTagPanel, tagPanelVisible,
          toggleBookmarkPanel, bookmarkPanelVisible,
          foldToLevel, expandAllWithNotes,
          setView, view,
          setShowPicker, setShowTextSearch, setShowFolderPicker,
          setShowHelp, insertFootnote, insertDateStamp,
          joinFocusedWithNext,
                exportToHtml, exportToOrg, exportToMarkdown, currentFile,
          copyAsFormatted, copyAsPlain,
          clearRecentFiles,
          setFindOpen, findInputRef,
          cleanUpSelectedText, splitAtCursorLocation,
        })} onClose=${() => setShowHelp(false)} />`}
      ${showShortcutEditor && html`
        <${ShortcutEditor}
          shortcutVer=${shortcutVer}
          onUpdate=${updateShortcut}
          onReset=${resetShortcut}
          onResetAll=${resetAllShortcuts}
          onClose=${() => setShowShortcutEditor(false)} />
      `}
      ${showToolbarCustomizer && html`
        <${ToolbarCustomizer}
          toolbarConfig=${toolbarConfig}
          onUpdate=${updateToolbarConfig}
          onClose=${() => setShowToolbarCustomizer(false)} />
      `}
      ${apptDialog && html`
        <${AppointmentDialog}
          defaultDate=${apptDialog.defaultDate}
          onConfirm=${confirmAddAppointment}
          onCancel=${() => setApptDialog(null)} />
      `}
      ${dueReminders.length > 0 && html`
        <${ReminderPopup}
          reminder=${dueReminders[0]}
          queueLength=${dueReminders.length}
          onOpen=${(it) => { dismissReminder(it._key); handleAgendaSelect({ file: it.file, title: it.nodeTitle, id: null }); }}
          onDismiss=${(it) => dismissReminder(it._key)} />
      `}
      ${showFolderPicker && html`
        <${FolderPicker}
          initialPath=${homeDir || "/"}
          onSelect=${changeHomeDir}
          onCancel=${() => setShowFolderPicker(false)} />
      `}
      ${showJournalFolderPicker && html`
        <${FolderPicker}
          initialPath=${journalDir || homeDir || "/"}
          onSelect=${changeJournalDir}
          onCancel=${() => setShowJournalFolderPicker(false)} />
      `}
      ${showTagListFilePicker && html`
        <${OrgFilePicker}
          initialPath=${tagListFile ? pathDirname(tagListFile) : (homeDir || "/")}
          onSelect=${changeTagListFile}
          onCancel=${() => setShowTagListFilePicker(false)} />
      `}
      ${showBookmarkListFilePicker && html`
        <${OrgFilePicker}
          initialPath=${bookmarkListFile ? pathDirname(bookmarkListFile) : (homeDir || "/")}
          onSelect=${changeBookmarkListFile}
          onCancel=${() => setShowBookmarkListFilePicker(false)} />
      `}
      ${showTextSearch && html`
        <${TextSearchDialog}
          onSearch=${runTextSearch}
          onCancel=${() => setShowTextSearch(false)} />
      `}
      ${showWorkspaceModal && html`
        <${WorkspaceModal}
          workspaceConfig=${workspaceConfig}
          homeDir=${homeDir}
          onSave=${saveWorkspace}
          onCancel=${() => setShowWorkspaceModal(false)} />
      `}
      ${showLinkPicker && html`
        <${FileLinkPicker}
          files=${files}
          onSelect=${insertFileLink}
          onCreate=${createFileForLink}
          onCancel=${() => setShowLinkPicker(false)} />
      `}
      ${showWikiPicker && html`
        <${WikiLinkPicker}
          entries=${wikiEntries}
          onSelect=${insertWikiLink}
          onCreate=${createNoteForWikiLink}
          onCancel=${() => setShowWikiPicker(false)} />
      `}
      ${showQuickSwitcher && html`
        <${QuickSwitcher}
          entries=${wikiEntries}
          currentFile=${currentFile}
          onSelect=${(file) => { setShowQuickSwitcher(false); loadFile(file); }}
          onCreate=${createAndLoadNote}
          onCancel=${() => setShowQuickSwitcher(false)} />
      `}
      ${hoverPopup && html`
        <${WikiHoverPopup}
          popup=${hoverPopup}
          onMouseEnter=${() => clearTimeout(hoverTimerRef.current)}
          onMouseLeave=${() => { hoverTimerRef.current = setTimeout(() => setHoverPopup(null), 120); }} />
      `}
      <div className="app-layout">
        ${sidebarVisible && html`
          <${Sidebar} favorites=${validFavorites} recentFiles=${validRecentFiles} currentFile=${currentFile}
            onSelect=${loadFile} onToggleFavorite=${toggleFavorite}
            bookmarks=${fileOnlyBookmarks}
            onNavigateToBookmark=${navigateToBookmark}
            onDeleteBookmark=${deleteBookmark}
            onReorderBookmarks=${updateBookmarkOrder}
            bookmarkPanelVisible=${bookmarkPanelVisible} onToggleBookmarkPanel=${toggleBookmarkPanel}
            textMode=${textMode} onToggleSidebar=${toggleSidebar}
            onOpenTodayJournal=${async () => {
              try { const d = await api.post("/api/journal", {}); loadFile(d.filename); setView("outline"); } catch {}
            }}
            onOpenJournalList=${() => setView("journal")}
            onRenameFile=${handleRenameFile}
            onClearRecentFiles=${clearRecentFiles}
            onOpenQuickSwitcher=${() => setShowQuickSwitcher(true)}
            onOpenTextSearch=${() => setShowTextSearch(true)}
            onOpenWorkspace=${() => setShowWorkspaceModal(true)}
            savedSearches=${savedSearches}
            onRunSavedSearch=${runSavedSearch}
            onDeleteSavedSearch=${deleteSavedSearch}
            navPanelVisible=${navPanelVisible} onToggleNavPanel=${toggleNavPanel} />
        `}
        ${navPanelVisible && !textMode && html`
          <${NavPanel} nodes=${nodes} wrapMode=${navPanelWrap}
            onToggleWrap=${toggleNavPanelWrap} onJump=${jumpToNode} onClose=${toggleNavPanel} />
        `}
        ${bookmarkPanelVisible && !textMode && html`
          <${BookmarkPanel} globalBMs=${globalBMs}
            onUpdateBMs=${updateGlobalBMs}
            onNestBM=${nestBM}
            onAddBMToItem=${addBMToItem}
            onEditBookmarkFile=${openBookmarkFile}
            onPickBookmarkListFile=${() => setShowBookmarkListFilePicker(true)}
            bookmarkListFile=${bookmarkListFile}
            width=${bookmarkPanelWidth}
            onWidthChange=${setBookmarkPanelWidthPersisted}
            focusedNode=${focusedNode}
            dispatch=${dispatch}
            onAddToGlobalBMs=${addToGlobalBMs} />
        `}
        ${view === "outline" && textMode && html`
          <div className="outline-pane">
            <textarea
              className="raw-text-editor"
              value=${rawText}
              spellCheck="false"
              onChange=${(e) => { setRawText(e.target.value); textDirtyRef.current = true; }}
              onKeyDown=${(e) => {
                const marker = formatMarkerForKey(e);
                if (marker) {
                  e.preventDefault();
                  wrapSelectionWithMarker(e, marker, (v) => { setRawText(v); textDirtyRef.current = true; });
                }
              }}
            />
          </div>
        `}
        ${view === "outline" && !textMode && html`
          <div className="outline-pane" onMouseDown=${(e) => {
            if (titleFormatMode && focusedId && !e.target.closest(".node-row")) {
              setFocusedId(null);
            }
          }}>
            ${searchPanelOpen && html`
              <${SearchPanel}
                nodes=${nodes}
                currentFile=${currentFile}
                homeDir=${homeDir}
                findQuery=${findQuery}
                setFindQuery=${setFindQuery}
                findMatchIds=${findMatchIds}
                findIdx=${findIdx}
                findNavigate=${findNavigate}
                findInputRef=${findInputRef}
                setFindOpen=${setFindOpen}
                replaceQuery=${replaceQuery}
                setReplaceQuery=${setReplaceQuery}
                replaceCurrentMatch=${replaceCurrentMatch}
                replaceAllMatches=${replaceAllMatches}
                replaceMessage=${replaceMessage}
                filterQuery=${searchQuery}
                setFilterQuery=${setSearchQuery}
                onFoldToLevel=${foldToLevel}
                onNavigate=${loadFile}
                onJumpToNode=${jumpToNode}
                onClose=${() => setSearchPanelOpen(false)}
                onSaveSearch=${saveSavedSearch}
                activeSavedSearch=${activeSavedSearch}
                onActiveSavedSearchConsumed=${() => setActiveSavedSearch(null)} />
            `}
            ${!searchPanelOpen && findOpen && html`
              <${FindBar}
                query=${findQuery}
                matchCount=${findMatchIds.length}
                matchIdx=${findIdx}
                onQuery=${setFindQuery}
                onNext=${() => findNavigate(1)}
                onPrev=${() => findNavigate(-1)}
                onClose=${() => { setFindOpen(false); setFindQuery(""); }}
                inputRef=${findInputRef}
                replaceQuery=${replaceQuery}
                onReplaceQuery=${setReplaceQuery}
                onReplaceOne=${replaceCurrentMatch}
                onReplaceAll=${replaceAllMatches}
                replaceMessage=${replaceMessage} />
            `}
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              ${!isFiltering && !isHoisted && html`<${PreambleRow} focused=${isPreambleFocused} preamble=${preamble} dispatch=${dispatch} inputRefs=${inputRefs} />`}
              ${visibleNodes.length === 0 ? html`
                <div className="empty" onClick=${() => {
                  if (isFiltering) { setSearchQuery(""); clearTags(); return; }
                  const nn = tree.newNode();
                  setNodes([nn]); focusNode(nn.id); markDirty();
                }}>${isFiltering ? "No matches — click to clear filters" : "Click or press any key to start"}</div>
              ` : visibleNodes.map((node, i) => html`
                <${OutlineNode} key=${node.id} node=${node} focusedId=${focusedId}
                  dispatch=${dispatch} inputRefs=${inputRefs} depth=${0}
                  titleFormatMode=${titleFormatMode} notesVisible=${notesVisible}
                  outlineFormat=${outlineFormat} levelFormats=${levelFormats} siblingIndex=${i + 1}
                  verticalLines=${verticalLines} showTagChips=${showTagChips}
                  tagsOnRight=${tagsOnRight} onSearchTag=${searchTag}
                  bodyEditingId=${bodyEditingId} bodyPreviewId=${bodyPreviewId} bodyRefs=${bodyRefs}
                  onNodeHandleMouseDown=${onNodeHandleMouseDown}
                  onNodeHandleMenu=${onNodeHandleMenu}
                  nodeMenuOpenId=${nodeMenu?.nodeId}
                  globalFont=${globalFont} levelFonts=${levelFonts}
                  globalColor=${globalColor} levelColors=${levelColors} />
              `)}
              ${!isFiltering && currentFile && html`
                <${BacklinksSection}
                  currentFile=${currentFile}
                  wikiEntries=${wikiEntries}
                  onNavigate=${loadFile} />
              `}
            </div>
          </div>
        `}
        ${view === "agenda" && html`
          <div className="outline-pane">
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              <${AgendaView} nodes=${nodes} currentFile=${currentFile} onSelect=${handleAgendaSelect}
                onEditNode=${handleAgendaEditNode} searchQuery=${searchQuery} selectedTags=${selectedTags}
                onGoToDate=${goToJournalDate} onNewAppointment=${openApptDialog} />
            </div>
          </div>
        `}
        ${view === "todo" && html`
          <div className="outline-pane">
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              <${TodoView} nodes=${nodes} currentFile=${currentFile} onSelect=${handleAgendaSelect} searchQuery=${searchQuery} selectedTags=${selectedTags} />
            </div>
          </div>
        `}
        ${view === "journal" && html`
          <div className="outline-pane">
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              <${JournalView}
                onOpenFile=${(filename) => { navDispatch({ type: "push", entry: { view: "journal" } }); loadFile(filename); setView("outline"); }}
                onOpenFileWithDetail=${(filename) => { navDispatch({ type: "push", entry: { view: "journal" } }); loadFile(filename); setView("outline"); setDetailVisiblePersisted(true); }}
                onOpenFileAt=${(filename, nodeId) => {
                  if (currentFile === filename) {
                    setView("outline");
                    jumpToNode(nodeId);
                  } else {
                    navDispatch({ type: "push", entry: { view: "journal" } });
                    pendingJumpIdRef.current = nodeId;
                    loadFile(filename);
                    setView("outline");
                  }
                }}
                onGoToDate=${goToJournalDate}
                onNewAppointment=${openApptDialog}
                searchQuery=${searchQuery}
              />
            </div>
          </div>
        `}
        ${view === "search" && searchResults && html`
          <div className="outline-pane">
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              <${SearchResultsView}
                searchResults=${searchResults}
                currentFile=${currentFile}
                onBack=${() => setView("outline")}
                onNavigate=${async (r) => {
                  pendingTagNavRef.current = { file: r.file, title: r.title };
                  await loadFile(r.file);
                  setView("outline");
                }}
              />
            </div>
          </div>
        `}
        ${tagPanelVisible && !textMode && html`
          <${TagPanel} globalTags=${globalTags}
            onUpdateTags=${updateGlobalTags}
            onNestTag=${nestTag}
            onAddTagToItem=${addTagToItem}
            onEditTagFile=${openTagFile}
            onPickTagListFile=${() => setShowTagListFilePicker(true)}
            tagListFile=${tagListFile}
            selectedTags=${selectedTags}
            onToggleTag=${toggleTag}
            onClearTags=${clearTags}
            width=${tagPanelWidth}
            onWidthChange=${setTagPanelWidthPersisted}
            onSearch=${searchTag}
            onReloadTags=${reloadGlobalTags}
            focusedNode=${focusedNode}
            dispatch=${dispatch}
            onAddToGlobalTags=${addToGlobalTags} />
        `}
        <${DetailPane} ref=${detailPaneRef} key=${detailKey} node=${detailNode} isPreamble=${isPreambleFocused}
          dispatch=${dispatch} inputRefs=${inputRefs}
          width=${detailWidth} visible=${detailVisible}
          onWidthChange=${setDetailWidthPersisted}
          onOpen=${() => setDetailVisiblePersisted(true)}
          onClose=${() => setDetailVisiblePersisted(false)}
          titleFormatMode=${titleFormatMode}
          globalTags=${globalTags}
          tagPanelVisible=${tagPanelVisible} onToggleTagPanel=${toggleTagPanel}
          textMode=${textMode} selectedTags=${selectedTags} />
      </div>
      ${statusBarVisible && html`
        <${StatusBar} currentFile=${currentFile} homeDir=${homeDir} journalDir=${journalDir} tagListFile=${tagListFile} bookmarkListFile=${bookmarkListFile}
          onOpenSettings=${() => setShowSettings(true)} />
      `}
      ${showSettings && html`
        <${SettingsModal}
          initialSection=${settingsSection}
          syncStatus=${syncStatus}
          onClose=${() => { setShowSettings(false); setSettingsSection("view"); }}
          theme=${theme} onToggleTheme=${toggleTheme}
          topBarColor=${topBarColor} onSetTopBarColor=${setTopBarColorPersisted}
          outlineFormat=${outlineFormat} onSetOutlineFormat=${setOutlineFormat}
          levelFormats=${levelFormats} onSetLevelFormat=${setLevelFormat}
          globalFont=${globalFont} onSetGlobalFont=${setGlobalFont}
          levelFonts=${levelFonts} onSetLevelFont=${setLevelFont}
          globalColor=${globalColor} onSetGlobalColor=${setGlobalColor}
          levelColors=${levelColors} onSetLevelColor=${setLevelColor}
          verticalLines=${verticalLines} onToggleVerticalLines=${toggleVerticalLines}
          readingWidth=${readingWidth} onToggleReadingWidth=${toggleReadingWidth}
          showTagChips=${showTagChips} onToggleShowTagChips=${toggleShowTagChips}
          tagsOnRight=${tagsOnRight} onToggleTagsOnRight=${toggleTagsOnRight}
          homeDir=${homeDir}
          onChangeHomeDir=${() => { setShowSettings(false); setShowFolderPicker(true); }}
          homeFile=${homeFile} onSetHomeFile=${setHomeFilePersisted} currentFile=${currentFile}
          journalDir=${journalDir}
          onChangeJournalDir=${() => { setShowSettings(false); setShowJournalFolderPicker(true); }}
          onClearJournalDir=${() => { setShowSettings(false); clearJournalDir(); }}
          statusBarVisible=${statusBarVisible} onToggleStatusBar=${toggleStatusBarVisible}
          headerCollapsed=${headerCollapsed} onToggleHeaderCollapsed=${toggleHeaderCollapsed}
          titleFormatMode=${titleFormatMode} onToggleTitleFormat=${toggleTitleFormatMode}
          notesVisible=${notesVisible} onToggleNotesVisible=${toggleNotesVisible}
          dateStampFmt=${dateStampFmt} onSetDateStampFmt=${setDateStampFmt}
          tagListFile=${tagListFile}
          onChangeTagListFile=${() => { setShowSettings(false); setShowTagListFilePicker(true); }}
          onClearTagListFile=${() => { setShowSettings(false); clearTagListFile(); }}
          bookmarkListFile=${bookmarkListFile}
          onChangeBookmarkListFile=${() => { setShowSettings(false); setShowBookmarkListFilePicker(true); }}
          onClearBookmarkListFile=${() => { setShowSettings(false); clearBookmarkListFile(); }}
          backupMaxVersions=${backupMaxVersions}
          onChangeBackupMaxVersions=${changeBackupMaxVersions}
          shortcutVer=${shortcutVer} onUpdateShortcut=${updateShortcut}
          onResetShortcut=${resetShortcut} onResetAllShortcuts=${resetAllShortcuts}
          toolbarConfig=${toolbarConfig} onUpdateToolbarConfig=${updateToolbarConfig}
          view=${view} onSetView=${setView}
          textMode=${textMode} onSetViewMode=${setViewMode}
          isHoisted=${isHoisted} canToggleHoist=${isHoisted || (focusedId && focusedId !== "preamble")}
          onToggleHoist=${toggleHoist}
          onFoldToLevel=${foldToLevel}
          onExportToOrg=${exportToOrg} onExportToHtml=${exportToHtml} onExportToMarkdown=${exportToMarkdown} onImportFromMarkdown=${importFromMarkdown}
          tagPanelVisible=${tagPanelVisible} onToggleTagPanel=${toggleTagPanel}
          bookmarkPanelVisible=${bookmarkPanelVisible} onToggleBookmarkPanel=${toggleBookmarkPanel}
          workspaceConfig=${workspaceConfig}
          onConfigureWorkspace=${() => { setShowSettings(false); setShowWorkspaceModal(true); }}
          savedWorkspaceProfiles=${savedWorkspaceProfiles}
          onSaveCurrentAsWorkspaceProfile=${saveCurrentAsWorkspaceProfile}
          onDeleteWorkspaceProfile=${deleteWorkspaceProfile}
          onSwitchWorkspaceProfile=${switchToWorkspaceProfile} />
      `}
    </div>
    ${fnPopup && html`<${FootnotePopup} popup=${fnPopup} onClose=${() => setFnPopup(null)} onSave=${saveFootnoteDef} />`}
    ${fnInsertPopup && html`<${FootnoteInsertPopup} popup=${fnInsertPopup} onInsert=${confirmInsertFootnote} onClose=${() => setFnInsertPopup(null)} />`}
    ${imgInsertState && html`<${InsertImageDialog} onInsert=${confirmInsertImage} onClose=${() => setImgInsertState(null)} />`}
    ${dragVisual && html`
      <div className="dnd-ghost" style=${{ left: dragVisual.ghostX + 14, top: dragVisual.ghostY }}>
        ${dragVisual.ghostTitle || html`<em>untitled</em>`}
      </div>
      <div className="dnd-drop-line" style=${{ top: dragVisual.lineY, left: dragVisual.lineLeft }} />
    `}
    <${Toast} message=${toastMsg} />
  `;
}

const FOLD_LEVELS = [1, 2, 3, 4];

// --- Toolbar icons ---
// Inline SVG (not emoji/icon-font glyphs) so they render identically on
// every machine regardless of installed system fonts. They inherit
// currentColor, so active/hover/dark-mode styling all come for free from
// the surrounding button's CSS.

const ICON_PROPS = { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" };

const TOPBAR_COLORS = { green: "#166534", blue: "#225167", red: "#991b1b" };
// Resolve a topBarColor value (named key or raw "#rrggbb") to a hex string.
function resolveTopBarColor(c) {
  if (!c) return null;
  return TOPBAR_COLORS[c] || (c.startsWith("#") ? c : null);
}

function IconSun() {
  return html`<svg ...${ICON_PROPS}>
    <circle cx="12" cy="12" r="4"/>
    <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
    <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
    <line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/>
    <line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>
  </svg>`;
}

function IconMoon() {
  return html`<svg ...${ICON_PROPS}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

function navReducer(state, action) {
  switch (action.type) {
    case "push": {
      // Don't duplicate if same file+title as current entry
      const cur = state.history[state.index];
      if (cur && cur.file === action.entry.file && !action.entry.title && !cur.title) return state;
      const history = [...state.history.slice(0, state.index + 1), action.entry];
      const trimmed = history.length > 100 ? history.slice(history.length - 100) : history;
      return { history: trimmed, index: trimmed.length - 1 };
    }
    case "patch": {
      if (state.index < 0) return state;
      const history = state.history.slice();
      history[state.index] = { ...history[state.index], title: action.title };
      return { history, index: state.index };
    }
    case "back":
      return state.index > 0 ? { ...state, index: state.index - 1 } : state;
    case "forward":
      return state.index < state.history.length - 1 ? { ...state, index: state.index + 1 } : state;
    default: return state;
  }
}

function IconNavBack() {
  return html`<svg ...${ICON_PROPS} strokeWidth="2.75"><polyline points="15 18 9 12 15 6"/></svg>`;
}
function IconNavForward() {
  return html`<svg ...${ICON_PROPS} strokeWidth="2.75"><polyline points="9 18 15 12 9 6"/></svg>`;
}

function IconDoc() {
  return html`<svg width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 1h7l3 3v11H2V1z"/>
    <path d="M9 1v3h3"/>
    <line x1="4" y1="7" x2="10" y2="7"/>
    <line x1="4" y1="10" x2="10" y2="10"/>
    <line x1="4" y1="13" x2="7" y2="13"/>
  </svg>`;
}

function IconUndo() {
  return html`
    <svg ...${ICON_PROPS} strokeWidth="2.5">
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  `;
}

function IconRedo() {
  return html`
    <svg ...${ICON_PROPS} strokeWidth="2.5">
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  `;
}

function IconSidebar() {
  return html`
    <svg ...${ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  `;
}

function IconNavPanel() {
  return html`
    <svg ...${ICON_PROPS}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="15" y2="12" />
      <line x1="3" y1="18" x2="18" y2="18" />
    </svg>
  `;
}

// Dynalist-style per-node handle: even-length centered lines read as a
// dedicated grip/menu control, distinct from IconNavPanel's uneven lines.
function IconNodeHandle() {
  return html`
    <svg ...${ICON_PROPS}>
      <line x1="5" y1="7" x2="19" y2="7" />
      <line x1="5" y1="12" x2="19" y2="12" />
      <line x1="5" y1="17" x2="19" y2="17" />
    </svg>
  `;
}

function IconBookmark() {
  return html`<svg ...${ICON_PROPS}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
}

function IconOutline() {
  return html`
    <svg ...${ICON_PROPS}>
      <circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="6" x2="20" y2="6" />
      <circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="18" x2="20" y2="18" />
    </svg>
  `;
}

function IconTodo() {
  return html`
    <svg ...${ICON_PROPS}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <polyline points="7 12 10.5 15.5 17 9" />
    </svg>
  `;
}

function IconAgenda() {
  return html`
    <svg ...${ICON_PROPS}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  `;
}

function IconDetails() {
  return html`
    <svg ...${ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  `;
}

function IconHome() {
  return html`
    <svg ...${ICON_PROPS}>
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>
      <polyline points="9 21 9 13 15 13 15 21"/>
    </svg>
  `;
}

function IconJournal() {
  return html`
    <svg ...${ICON_PROPS}>
      <rect x="3" y="2" width="18" height="20" rx="2" />
      <line x1="8" y1="2" x2="8" y2="22" />
      <line x1="11" y1="7" x2="18" y2="7" />
      <line x1="11" y1="11" x2="18" y2="11" />
      <line x1="11" y1="15" x2="16" y2="15" />
    </svg>
  `;
}

// Plain mode icon: simple "Aa"
function IconModePlain() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24">
      <text x="12" y="17" fontSize="13" fontWeight="400" textAnchor="middle" fill="currentColor">Aa</text>
    </svg>
  `;
}

// Formatted mode icon: bold "Aa"
function IconModeFormatted() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24">
      <text x="12" y="17" fontSize="13" fontWeight="700" textAnchor="middle" fill="currentColor">Aa</text>
    </svg>
  `;
}

// Reveal codes icon: </>
function IconModeReveal() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7 8 3 12 7 16" />
      <polyline points="17 8 21 12 17 16" />
      <line x1="13" y1="6" x2="11" y2="18" />
    </svg>
  `;
}

function IconFormatted() { return html`<${IconModeFormatted} />`; }
function IconTextMode()   { return html`<${IconModeReveal} />`; }
function IconLightning() {
  return html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>`;
}

function IconSearchPanel() {
  return html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="6" x2="6" y2="1"/>
    <line x1="12" y1="6" x2="12" y2="1"/>
    <line x1="12" y1="6" x2="18" y2="1"/>
    <line x1="9" y1="7.5" x2="3" y2="7.5"/>
    <line x1="15" y1="7.5" x2="21" y2="7.5"/>
    <rect x="9" y="6" width="6" height="3" rx="0.5"/>
    <path d="M10 9 L8 21 L16 21 L14 9 Z"/>
    <line x1="6" y1="21" x2="18" y2="21"/>
  </svg>`;
}

// Hoist: corners point inward (toward each other) when off — clicking
// narrows the view. Once hoisted, they point outward — clicking expands
// back to the full outline. Same convention as a fullscreen toggle, just
// inverted, since hoisting narrows rather than expands.
function IconHoistOff() {
  return html`
    <svg ...${ICON_PROPS}>
      <polyline points="3 8 8 8 8 3" />
      <polyline points="21 8 16 8 16 3" />
      <polyline points="16 21 16 16 21 16" />
      <polyline points="3 16 8 16 8 21" />
    </svg>
  `;
}

function IconHoistOn() {
  return html`
    <svg ...${ICON_PROPS}>
      <polyline points="8 3 3 3 3 8" />
      <polyline points="16 3 21 3 21 8" />
      <polyline points="21 16 21 21 16 21" />
      <polyline points="8 21 3 21 3 16" />
    </svg>
  `;
}

function IconNotes() {
  return html`
    <svg ...${ICON_PROPS}>
      <circle cx="7" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="17" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  `;
}

function IconMoveNode() {
  return html`
    <svg ...${ICON_PROPS} fill="currentColor" stroke="none">
      <path d="M12 3 9 7h2v4H7V9l-4 3 4 3v-2h4v4H9l3 4 3-4h-2v-4h4v2l4-3-4-3v2h-4V7h2z"/>
    </svg>
  `;
}

function IconHamburger() {
  return html`
    <svg ...${ICON_PROPS}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  `;
}

function IconTag() {
  return html`
    <svg ...${ICON_PROPS}>
      <path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.59-6.59a2.43 2.43 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  `;
}

const SMALL_ICON_PROPS = { ...ICON_PROPS, width: "14", height: "14" };

function IconSearch() {
  return html`
    <svg ...${SMALL_ICON_PROPS}>
      <circle cx="10" cy="10" r="6" />
      <line x1="14.9" y1="14.9" x2="20" y2="20" />
    </svg>
  `;
}

function IconFilter() {
  return html`
    <svg ...${SMALL_ICON_PROPS}>
      <polygon points="3 4 21 4 14 12.5 14 19 10 21 10 12.5 3 4" />
    </svg>
  `;
}

function IconWorkspace() {
  return html`
    <svg ...${ICON_PROPS}>
      <rect x="3" y="3" width="7" height="5" rx="1"/>
      <rect x="14" y="3" width="7" height="5" rx="1"/>
      <line x1="6.5" y1="8" x2="6.5" y2="12"/>
      <line x1="17.5" y1="8" x2="17.5" y2="12"/>
      <line x1="6.5" y1="12" x2="17.5" y2="12"/>
      <line x1="12" y1="12" x2="12" y2="16"/>
      <rect x="8" y="16" width="8" height="5" rx="1"/>
    </svg>
  `;
}

function IconInfo() {
  return html`
    <svg ...${ICON_PROPS}>
      <circle cx="12" cy="12" r="9"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8" strokeWidth="3.5"/>
    </svg>
  `;
}

function IconCommandPalette() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 9 12 4 7" />
      <line x1="12" y1="17" x2="20" y2="17" />
    </svg>
  `;
}

function IconPencil() {
  return html`
    <svg ...${SMALL_ICON_PROPS}>
      <path d="M17 3a2.83 2.83 0 0 1 4 4L7 21l-4 1 1-4Z" />
    </svg>
  `;
}

function IconTrash() {
  return html`
    <svg ...${SMALL_ICON_PROPS}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  `;
}

function IconWidth() {
  return html`
    <svg ...${ICON_PROPS}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <polyline points="7 8 3 12 7 16" />
      <polyline points="17 8 21 12 17 16" />
    </svg>
  `;
}

function IconPin() {
  return html`
    <svg ...${ICON_PROPS} viewBox="0 0 24 24">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  `;
}

// Hover preview popup for wiki-links — appears after a short delay when hovering [[Title]].
function WikiHoverPopup({ popup, onMouseEnter, onMouseLeave }) {
  const { rect, data, title } = popup;
  const nodes = (data.nodes || []).slice(0, 5);
  const W = 320, margin = 10;
  let left = rect.left;
  if (left + W > window.innerWidth - margin) left = window.innerWidth - W - margin;
  left = Math.max(margin, left);
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const showAbove = spaceBelow < 220 && rect.top > 220;

  return html`
    <div className="wiki-hover-popup"
         style=${{
           left: left + "px",
           top: showAbove ? rect.top - margin + "px" : rect.bottom + margin + "px",
           transform: showAbove ? "translateY(-100%)" : "none",
         }}
         onMouseEnter=${onMouseEnter}
         onMouseLeave=${onMouseLeave}>
      <div className="whp-title">${title}</div>
      ${nodes.length > 0 ? html`
        <div className="whp-nodes">
          ${nodes.map((n, i) => html`
            <div key=${i} className="whp-node">
              <span className="whp-bullet">·</span>
              <span className="whp-text"
                    dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(n.title) }} />
              ${n.body ? html`<div className="whp-body">${n.body.length > 120 ? n.body.slice(0, 120) + "…" : n.body}</div>` : null}
            </div>
          `)}
          ${(data.nodes || []).length > 5 ? html`
            <div className="whp-more">…${(data.nodes || []).length - 5} more items</div>
          ` : null}
        </div>
      ` : html`<div className="whp-empty">Empty note</div>`}
    </div>
  `;
}

// Find in note bar — Ctrl+F, sticky at top of outline pane.
function FindBar({ query, matchCount, matchIdx, onQuery, onNext, onPrev, onClose, inputRef,
                    replaceQuery, onReplaceQuery, onReplaceOne, onReplaceAll, replaceMessage }) {
  return html`
    <div className="find-bar">
      <div className="find-bar-row">
        <input ref=${inputRef} type="search" className="find-bar-input"
               placeholder="Find in file…"
               value=${query}
               autoComplete="off"
               data-form-type="other"
               data-bwignore="true"
               onInput=${(e) => onQuery(e.target.value)}
               onKeyDown=${(e) => {
                 if (e.key === "Escape") { e.preventDefault(); onClose(); }
                 else if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
                 else if (e.key === "F3") { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
               }} />
        <span className="find-bar-count">
          ${matchCount > 0 ? `${matchIdx + 1} / ${matchCount}` : query.trim() ? "No matches" : ""}
        </span>
        <button className="find-bar-nav" onClick=${onPrev} disabled=${matchCount === 0} title="Previous (Shift+Enter)">↑</button>
        <button className="find-bar-nav" onClick=${onNext} disabled=${matchCount === 0} title="Next (Enter)">↓</button>
        <button className="find-bar-close" onClick=${onClose} title="Close (Esc)">×</button>
      </div>
      <div className="find-bar-row">
        <input type="text" className="find-bar-input"
               placeholder="Replace with…"
               value=${replaceQuery}
               autoComplete="off"
               data-form-type="other"
               data-bwignore="true"
               onInput=${(e) => onReplaceQuery(e.target.value)}
               onKeyDown=${(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }} />
        <button className="find-bar-replace-btn" onClick=${onReplaceOne}
                disabled=${matchCount === 0} title="Replace all occurrences in the current match, then move to the next">Replace</button>
        <button className="find-bar-replace-btn" onClick=${onReplaceAll}
                disabled=${!query.trim()} title="Replace every occurrence in the whole file">Replace All</button>
        ${replaceMessage && html`<span className="find-bar-replace-msg">${replaceMessage}</span>`}
      </div>
    </div>
  `;
}

// Quick switcher — Ctrl+K opens a modal to jump to any note by title.
function QuickSwitcher({ entries, currentFile, onSelect, onCreate, onCancel }) {
  const [filter, setFilter] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return entries.filter((e) =>
      !q || e.title.toLowerCase().includes(q) || e.file.toLowerCase().includes(q)
    );
  }, [entries, filter]);

  const trimmed = filter.trim();
  const exactMatch = filtered.some((e) => e.title.toLowerCase() === trimmed.toLowerCase());
  const showCreate = !!trimmed && !exactMatch;
  const totalItems = filtered.length + (showCreate ? 1 : 0);

  useEffect(() => { setHighlighted(0); }, [filter]);

  useEffect(() => {
    listRef.current?.children[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, totalItems - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted < filtered.length) { onSelect(filtered[highlighted].file); return; }
      if (showCreate && highlighted === filtered.length) { onCreate(trimmed); return; }
      return;
    }
  };

  return html`
    <div className="folder-picker-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="quick-switcher">
        <input ref=${inputRef} className="qs-input" type="search"
               placeholder="Jump to note…"
               value=${filter}
               autoComplete="off"
               data-form-type="other"
               data-lpignore="true"
               data-bwignore="true"
               onInput=${(e) => setFilter(e.target.value)}
               onKeyDown=${onKeyDown} />
        <div className="qs-list" ref=${listRef}>
          ${filtered.map((entry, i) => html`
            <div key=${entry.file}
                 className=${"qs-item" + (i === highlighted ? " highlighted" : "") + (entry.file === currentFile ? " qs-current" : "")}
                 onClick=${() => onSelect(entry.file)}
                 onMouseEnter=${() => setHighlighted(i)}>
              <span className="qs-title">${entry.title}</span>
              <span className="qs-file">${entry.file}</span>
            </div>
          `)}
          ${showCreate && html`
            <div className=${"qs-item qs-create" + (highlighted === filtered.length ? " highlighted" : "")}
                 onClick=${() => onCreate(trimmed)}
                 onMouseEnter=${() => setHighlighted(filtered.length)}>
              <span className="qs-create-label">+ Create note "${trimmed}"</span>
            </div>
          `}
          ${!showCreate && filtered.length === 0 && html`<div className="qs-empty">Type to search notes</div>`}
        </div>
        <div className="qs-hint">↑↓ navigate · Enter open · Esc dismiss · Ctrl+K toggle</div>
      </div>
    </div>
  `;
}

// Wiki-link picker — triggered by typing [[ in a node body textarea.
// Shows a filterable list of note titles; selecting one inserts [[Title]].
function WikiLinkPicker({ entries, onSelect, onCreate, onCancel }) {
  const [filter, setFilter] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = entries.filter((e) =>
    !filter || e.title.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => { setHighlighted(0); }, [filter]);

  useEffect(() => {
    const el = listRef.current?.children[highlighted];
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const trimmed = filter.trim();
  const exactMatch = filtered.some((e) => e.title.toLowerCase() === trimmed.toLowerCase());
  const showCreate = !!trimmed && !exactMatch;
  const totalItems = filtered.length + (showCreate ? 1 : 0);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, totalItems - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted < filtered.length) onSelect(filtered[highlighted].title);
      else if (showCreate) onCreate(trimmed);
      return;
    }
  };

  return html`
    <div className="folder-picker-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="file-link-picker">
        <div className="text-search-header">
          <span className="text-search-title">Link to Note</span>
          <button className="folder-picker-close" onClick=${onCancel}>×</button>
        </div>
        <div className="file-link-picker-body">
          <input
            ref=${inputRef}
            className="text-search-input"
            type="text"
            placeholder="Search notes by title…"
            value=${filter}
            onInput=${(e) => setFilter(e.target.value)}
            onKeyDown=${onKeyDown}
          />
          <div className="file-link-list" ref=${listRef}>
            ${filtered.map((entry, i) => html`
              <div key=${entry.file}
                   className=${"file-link-item" + (i === highlighted ? " highlighted" : "")}
                   onClick=${() => onSelect(entry.title)}
                   onMouseEnter=${() => setHighlighted(i)}>
                <span className="file-link-filename">${entry.title}</span>
                <span className="file-link-ext" style=${{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "11px" }}>${entry.file}</span>
              </div>
            `)}
            ${showCreate ? html`
              <div className=${"file-link-item file-link-create-item" + (highlighted >= filtered.length ? " highlighted" : "")}
                   onClick=${() => onCreate(trimmed)}
                   onMouseEnter=${() => setHighlighted(filtered.length)}>
                <span className="file-link-create-icon">＋</span>
                <span className="file-link-create-label">Create note </span>
                <span className="file-link-filename">${trimmed}</span>
              </div>
            ` : filtered.length === 0 ? html`
              <div className="file-link-empty">No notes match "${filter}"</div>
            ` : null}
          </div>
          <div className="file-link-hint">↑↓ to navigate · Enter to select · Esc to dismiss</div>
        </div>
      </div>
    </div>
  `;
}

// Backlinks section — shows linked references and unlinked mentions at the
// bottom of the outline. Both are fetched together when the current file changes.
function BacklinksSection({ currentFile, wikiEntries, onNavigate }) {
  const [backlinks, setBacklinks] = useState(null);
  const [unlinked, setUnlinked] = useState(null);
  const [open, setOpen] = useState(true);
  const [unlinkedOpen, setUnlinkedOpen] = useState(true);

  useEffect(() => {
    if (!currentFile) { setBacklinks([]); setUnlinked([]); return; }
    const entry = wikiEntries.find((e) => e.file === currentFile);
    if (!entry) { setBacklinks([]); setUnlinked([]); return; }
    const qs = `file=${encodeURIComponent(currentFile)}&title=${encodeURIComponent(entry.title)}`;
    setBacklinks(null);
    setUnlinked(null);
    api.get(`/api/backlinks?${qs}`)
      .then((d) => setBacklinks(d.backlinks || []))
      .catch(() => setBacklinks([]));
    api.get(`/api/unlinked?${qs}`)
      .then((d) => setUnlinked(d.mentions || []))
      .catch(() => setUnlinked([]));
  }, [currentFile, wikiEntries]);

  const hasBacklinks = backlinks && backlinks.length > 0;
  const hasUnlinked = unlinked && unlinked.length > 0;
  if (!hasBacklinks && !hasUnlinked) return null;

  return html`
    <div className="backlinks-section">
      ${hasBacklinks && html`
        <div className="backlinks-header" onClick=${() => setOpen((o) => !o)}>
          <span className="backlinks-title">
            ${open ? "▾" : "▸"} Linked References (${backlinks.length})
          </span>
        </div>
        ${open && html`
          <div className="backlinks-list">
            ${backlinks.map((bl, i) => html`
              <div key=${i} className="backlink-item" onClick=${() => onNavigate(bl.file)}>
                <span className="backlink-file">${bl.file.replace(/\.org$/, "")}</span>
                <span className="backlink-node-title">${bl.title}</span>
                ${bl.context ? html`<span className="backlink-context">${bl.context}</span>` : null}
              </div>
            `)}
          </div>
        `}
      `}
      ${hasUnlinked && html`
        <div className="backlinks-header" onClick=${() => setUnlinkedOpen((o) => !o)}>
          <span className="backlinks-title unlinked-title">
            ${unlinkedOpen ? "▾" : "▸"} Unlinked Mentions (${unlinked.length})
          </span>
        </div>
        ${unlinkedOpen && html`
          <div className="backlinks-list">
            ${unlinked.map((bl, i) => html`
              <div key=${i} className="backlink-item unlinked-item" onClick=${() => onNavigate(bl.file)}>
                <span className="backlink-file">${bl.file.replace(/\.org$/, "")}</span>
                <span className="backlink-node-title">${bl.title}</span>
                ${bl.context ? html`<span className="backlink-context">${bl.context}</span>` : null}
              </div>
            `)}
          </div>
        `}
      `}
    </div>
  `;
}

// File link picker — triggered by typing [[ in a node title or body.
// Shows a filterable list of org files; selecting one inserts an org link.
function FileLinkPicker({ files, onSelect, onCreate, onCancel }) {
  const [filter, setFilter] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = files.filter((f) =>
    f.name.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => { setHighlighted(0); }, [filter]);

  // Keep highlighted item scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[highlighted];
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const select = (name) => {
    const title = name.replace(/\.org$/, "").replace(/[-_]/g, " ");
    onSelect(name, title);
  };

  // Derive a candidate filename and title from what the user typed.
  const trimmed = filter.trim();
  const newFileName = trimmed
    ? (trimmed.toLowerCase().endsWith(".org") ? trimmed : trimmed + ".org")
    : null;
  const newFileTitle = newFileName ? newFileName.replace(/\.org$/i, "") : "";
  const showCreate = !!newFileName && filtered.length === 0;

  const doCreate = () => { if (showCreate) onCreate(newFileName, newFileTitle); };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) select(filtered[highlighted].name);
      else doCreate();
      return;
    }
  };

  return html`
    <div className="folder-picker-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="file-link-picker">
        <div className="text-search-header">
          <span className="text-search-title">Link to File</span>
          <button className="folder-picker-close" onClick=${onCancel}>×</button>
        </div>
        <div className="file-link-picker-body">
          <input
            ref=${inputRef}
            className="text-search-input"
            type="text"
            placeholder="Filter org files…"
            value=${filter}
            onInput=${(e) => setFilter(e.target.value)}
            onKeyDown=${onKeyDown}
          />
          <div className="file-link-list" ref=${listRef}>
            ${filtered.map((f, i) => html`
              <div key=${f.name}
                   className=${"file-link-item" + (i === highlighted ? " highlighted" : "")}
                   onClick=${() => select(f.name)}
                   onMouseEnter=${() => setHighlighted(i)}>
                <span className="file-link-filename">${f.name.replace(/\.org$/, "")}</span>
                <span className="file-link-ext">.org</span>
              </div>
            `)}
            ${showCreate ? html`
              <div className="file-link-item file-link-create-item highlighted"
                   onClick=${doCreate}>
                <span className="file-link-create-icon">＋</span>
                <span className="file-link-create-label">Create</span>
                <span className="file-link-filename"> ${newFileTitle}</span>
                <span className="file-link-ext">.org</span>
              </div>
            ` : filtered.length === 0 ? html`
              <div className="file-link-empty">No files match "${filter}"</div>
            ` : null}
          </div>
          <div className="file-link-hint">↑↓ to navigate · Enter to select · Esc to dismiss</div>
        </div>
      </div>
    </div>
  `;
}

// Full-text search modal — input + syntax hint; submitting kicks off the
// search and shows results in the main panel.
function TextSearchDialog({ onSearch, onCancel }) {
  const [query, setQuery] = useState("");
  const [includeMarkdown, setIncludeMarkdown] = useState(() => {
    try { return localStorage.getItem("epicorg.searchIncludeMarkdown") === "1"; } catch { return false; }
  });
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const toggleIncludeMarkdown = () => {
    setIncludeMarkdown((prev) => {
      const next = !prev;
      try { localStorage.setItem("epicorg.searchIncludeMarkdown", next ? "1" : "0"); } catch {}
      return next;
    });
  };

  const submit = () => {
    const q = query.trim();
    if (q) onSearch(q, includeMarkdown);
  };

  return html`
    <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="text-search-dialog">
        <div className="text-search-header">
          <span className="text-search-title">Search All Files</span>
          <button className="folder-picker-close" onClick=${onCancel}>×</button>
        </div>
        <div className="text-search-body">
          <div className="text-search-input-row">
            <input
              ref=${inputRef}
              className="text-search-input"
              type="text"
              placeholder="Enter search terms…"
              value=${query}
              onInput=${(e) => setQuery(e.target.value)}
              onKeyDown=${(e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") onCancel();
              }}
            />
            <button className="text-search-go" onClick=${submit} disabled=${!query.trim()}>
              Search
            </button>
          </div>
          <label className="text-search-md-toggle">
            <input type="checkbox" checked=${includeMarkdown} onChange=${toggleIncludeMarkdown} />
            Include Markdown (.md) files
          </label>
          <div className="text-search-hint">
            <p>Searches headlines and notes in all org files in the home folder.</p>
            <p>
              <strong>word word</strong> — all words must appear (AND)<br/>
              <strong>"exact phrase"</strong> — match phrase as written<br/>
              <strong>word "some phrase" word</strong> — mix freely
            </p>
            <p>Case-insensitive. Results show the matching node and a context snippet.</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// WorkspaceModal — lets the user configure which folders are included or
// excluded from the workspace (file listing and search).
function WorkspaceModal({ workspaceConfig, homeDir, onSave, onCancel }) {
  const [localCfg, setLocalCfg] = useState(() => {
    if (workspaceConfig && workspaceConfig.paths && workspaceConfig.paths.length > 0) {
      return { paths: workspaceConfig.paths.map((p) => ({ ...p })) };
    }
    return { paths: [{ path: homeDir || "/", included: true }] };
  });
  const [browsePath, setBrowsePath] = useState(homeDir || "/");
  const [dirs, setDirs] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchDirs = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get("/api/browse?path=" + encodeURIComponent(path));
      setBrowsePath(data.path);
      setDirs(data.dirs || []);
      setParent(data.parent || null);
    } catch (e) {
      setError("Cannot read directory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDirs(homeDir || "/"); }, []);

  const addPath = (path, included) => {
    setLocalCfg((prev) => ({
      paths: [...prev.paths.filter((p) => p.path !== path), { path, included }],
    }));
  };

  const removePath = (path) => {
    setLocalCfg((prev) => ({ paths: prev.paths.filter((p) => p.path !== path) }));
  };

  const getPathStatus = (path) => {
    const found = localCfg.paths.find((p) => p.path === path);
    return found ? (found.included ? "included" : "excluded") : null;
  };

  const includedPaths = localCfg.paths.filter((p) => p.included);
  const excludedPaths = localCfg.paths.filter((p) => !p.included);

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(localCfg); } finally { setSaving(false); }
  };

  return html`
    <div className="folder-picker-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="workspace-modal">
        <div className="text-search-header">
          <span className="text-search-title">Workspace Paths</span>
          <button className="folder-picker-close" onClick=${onCancel}>×</button>
        </div>
        <div className="ws-body">
          <div className="ws-panel ws-left">
            <div className="ws-panel-title">Browse Filesystem</div>
            <div className="folder-picker-path">
              ${parent !== null && html`
                <button className="folder-picker-up" onClick=${() => fetchDirs(parent)}>↑ Up</button>
              `}
              <span className="folder-picker-path-text" title=${browsePath}>${browsePath}</span>
            </div>
            <div className="ws-tree">
              ${loading && html`<div className="folder-picker-loading">Loading…</div>`}
              ${error && html`<div className="folder-picker-error">${error}</div>`}
              ${!loading && !error && dirs.length === 0 && html`
                <div className="folder-picker-empty">No subdirectories</div>
              `}
              ${!loading && dirs.map((d) => {
                const fullPath = browsePath.replace(/\/$/, "") + "/" + d;
                const status = getPathStatus(fullPath);
                return html`
                  <div key=${d} className="ws-tree-item">
                    <span className="folder-picker-dir-icon"
                          onClick=${() => fetchDirs(fullPath)}>📁</span>
                    <span className="ws-tree-name"
                          onClick=${() => fetchDirs(fullPath)}>${d}</span>
                    <div className="ws-tree-actions">
                      <button className=${"ws-btn" + (status === "included" ? " ws-btn-active-inc" : "")}
                              title="Add as included root"
                              onClick=${() => addPath(fullPath, true)}>+</button>
                      <button className=${"ws-btn" + (status === "excluded" ? " ws-btn-active-exc" : "")}
                              title="Exclude from workspace"
                              onClick=${() => addPath(fullPath, false)}>−</button>
                    </div>
                  </div>
                `;
              })}
            </div>
            <div className="ws-add-root">
              <button className="ws-add-root-btn" onClick=${() => addPath(browsePath, true)}>
                + Add as root: <span className="ws-add-root-path">${browsePath}</span>
              </button>
            </div>
          </div>
          <div className="ws-panel ws-right">
            <div className="ws-summary">
              <div className="ws-section-label">Included roots</div>
              ${includedPaths.length === 0
                ? html`<div className="ws-empty-hint">No included paths — add at least one root.</div>`
                : includedPaths.map((p) => html`
                    <div key=${p.path} className="ws-path-item ws-included">
                      <span className="ws-path-name" title=${p.path}>${p.path}</span>
                      <button className="ws-path-remove" onClick=${() => removePath(p.path)}
                              title="Remove">×</button>
                    </div>
                  `)
              }
              <div className="ws-section-label ws-section-label-2">Excluded paths</div>
              ${excludedPaths.length === 0
                ? html`<div className="ws-empty-hint">No excluded paths.</div>`
                : excludedPaths.map((p) => html`
                    <div key=${p.path} className="ws-path-item ws-excluded">
                      <span className="ws-path-name" title=${p.path}>${p.path}</span>
                      <button className="ws-path-remove" onClick=${() => removePath(p.path)}
                              title="Remove">×</button>
                    </div>
                  `)
              }
            </div>
          </div>
        </div>
        <div className="ws-footer">
          <button className="folder-picker-cancel" onClick=${onCancel}>Cancel</button>
          <button className="folder-picker-select" onClick=${handleSave} disabled=${saving}>
            ${saving ? "Saving…" : "Save Workspace"}
          </button>
        </div>
      </div>
    </div>
  `;
}

// Folder picker modal — allows the user to navigate the filesystem and
// select a directory as the new home folder.
// OrgFilePicker — browses the filesystem and lets the user select or create a .org file.
function OrgFilePicker({ initialPath, onSelect, onCancel }) {
  const [browsePath, setBrowsePath] = useState(initialPath || "/");
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("TagList.org");
  const newNameRef = useRef(null);

  const fetchEntries = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    setCreating(false);
    try {
      const data = await api.get("/api/browse?ext=.org&path=" + encodeURIComponent(path));
      setBrowsePath(data.path);
      setDirs(data.dirs || []);
      setFiles(data.files || []);
      setParent(data.parent || null);
    } catch (e) {
      setError("Cannot read directory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEntries(initialPath || "/"); }, []);

  useEffect(() => {
    if (creating && newNameRef.current) {
      newNameRef.current.focus();
      newNameRef.current.select();
    }
  }, [creating]);

  const confirmCreate = useCallback(() => {
    let name = newName.trim();
    if (!name) return;
    if (!name.endsWith(".org")) name += ".org";
    onSelect(browsePath + "/" + name);
  }, [newName, browsePath, onSelect]);

  return html`
    <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="folder-picker-dialog">
        <div className="folder-picker-header">
          <span className="folder-picker-title">Select Tag List File</span>
          <button className="folder-picker-close" onClick=${onCancel}>×</button>
        </div>
        <div className="folder-picker-path">
          ${parent !== null && html`
            <button className="folder-picker-up" onClick=${() => fetchEntries(parent)}>↑ Up</button>
          `}
          <span className="folder-picker-path-text" title=${browsePath}>${browsePath}</span>
        </div>
        <div className="folder-picker-list">
          ${loading && html`<div className="folder-picker-loading">Loading…</div>`}
          ${error && html`<div className="folder-picker-error">${error}</div>`}
          ${!loading && !error && dirs.length === 0 && files.length === 0 && html`
            <div className="folder-picker-empty">No subdirectories or .org files here</div>
          `}
          ${!loading && dirs.map((d) => html`
            <div key=${"d:" + d} className="folder-picker-dir" onDoubleClick=${() => fetchEntries(browsePath + "/" + d)}>
              <span className="folder-picker-dir-icon">📁</span>
              <span className="folder-picker-dir-name" onClick=${() => fetchEntries(browsePath + "/" + d)}>${d}</span>
            </div>
          `)}
          ${!loading && files.map((f) => html`
            <div key=${"f:" + f} className="folder-picker-dir file-picker-file" onClick=${() => onSelect(browsePath + "/" + f)}>
              <span className="folder-picker-dir-icon">📄</span>
              <span className="folder-picker-dir-name">${f}</span>
            </div>
          `)}
        </div>
        ${creating && html`
          <div className="org-file-picker-create">
            <input
              ref=${newNameRef}
              className="org-file-picker-create-input"
              type="text"
              value=${newName}
              onInput=${(e) => setNewName(e.target.value)}
              onKeyDown=${(e) => {
                if (e.key === "Enter") { e.preventDefault(); confirmCreate(); }
                if (e.key === "Escape") { e.preventDefault(); setCreating(false); }
              }}
              placeholder="TagList.org"
            />
            <button className="folder-picker-select" onClick=${confirmCreate}
                    disabled=${!newName.trim()}>Create</button>
            <button className="folder-picker-cancel" onClick=${() => setCreating(false)}>Cancel</button>
          </div>
        `}
        <div className="folder-picker-footer">
          ${!creating && html`
            <button className="folder-picker-cancel" onClick=${() => setCreating(true)}>+ New Tag List</button>
          `}
          <button className="folder-picker-cancel" onClick=${onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function FolderPicker({ initialPath, onSelect, onCancel }) {
  const [browsePath, setBrowsePath] = useState(initialPath || "/");
  const [dirs, setDirs] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchDirs = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get("/api/browse?path=" + encodeURIComponent(path));
      setBrowsePath(data.path);
      setDirs(data.dirs || []);
      setParent(data.parent || null);
    } catch (e) {
      setError("Cannot read directory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDirs(initialPath || "/"); }, []);

  return html`
    <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="folder-picker-dialog">
        <div className="folder-picker-header">
          <span className="folder-picker-title">Select Home Folder</span>
          <button className="folder-picker-close" onClick=${onCancel}>×</button>
        </div>
        <div className="folder-picker-path">
          ${parent !== null && html`
            <button className="folder-picker-up" onClick=${() => fetchDirs(parent)}>↑ Up</button>
          `}
          <span className="folder-picker-path-text" title=${browsePath}>${browsePath}</span>
        </div>
        <div className="folder-picker-list">
          ${loading && html`<div className="folder-picker-loading">Loading…</div>`}
          ${error && html`<div className="folder-picker-error">${error}</div>`}
          ${!loading && !error && dirs.length === 0 && html`
            <div className="folder-picker-empty">No subdirectories</div>
          `}
          ${!loading && dirs.map((d) => html`
            <div key=${d} className="folder-picker-dir" onDoubleClick=${() => fetchDirs(browsePath + "/" + d)}>
              <span className="folder-picker-dir-icon">📁</span>
              <span className="folder-picker-dir-name" onClick=${() => fetchDirs(browsePath + "/" + d)}>${d}</span>
            </div>
          `)}
        </div>
        <div className="folder-picker-footer">
          <button className="folder-picker-cancel" onClick=${onCancel}>Cancel</button>
          <button className="folder-picker-select" onClick=${() => onSelect(browsePath)}>
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  `;
}

function LeftPanelLauncher({ sidebarVisible, onToggleSidebar, bookmarkPanelVisible, onToggleBookmarkPanel, textMode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const anyActive = sidebarVisible || (bookmarkPanelVisible && !textMode);
  return html`
    <div className="panel-launcher" ref=${ref}>
      <button className=${"panel-toggle-btn" + (anyActive ? " active" : "")}
              onClick=${() => setOpen((o) => !o)}
              title="Left panels"><${IconSidebar} /></button>
      ${open && html`
        <div className="panel-launcher-popup">
          <button className=${"panel-toggle-btn" + (sidebarVisible ? " active" : "")}
                  onClick=${onToggleSidebar}
                  title="File / Favorites / Recent"><${IconDoc} /></button>
          <button className=${"panel-toggle-btn" + (bookmarkPanelVisible && !textMode ? " active" : "")}
                  onClick=${onToggleBookmarkPanel} disabled=${textMode}
                  title=${textMode ? "Not available in reveal codes mode" : "Bookmark panel"}><${IconBookmark} /></button>
        </div>
      `}
    </div>
  `;
}

function RightPanelLauncher({ tagPanelVisible, onToggleTagPanel, detailVisible, onToggleDetails, textMode, selectedTags }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const anyActive = detailVisible || (tagPanelVisible && !textMode);
  return html`
    <div className="panel-launcher panel-launcher-right" ref=${ref}>
      <button className=${"panel-toggle-btn" + (anyActive ? " active" : "")}
              onClick=${() => setOpen((o) => !o)}
              title="Right panels"><${IconDetails} /></button>
      ${open && html`
        <div className="panel-launcher-popup">
          <button className=${"panel-toggle-btn" + (detailVisible ? " active" : "")}
                  onClick=${onToggleDetails}
                  title="Details pane"><${IconDetails} /></button>
          <button className=${"panel-toggle-btn" + (tagPanelVisible && !textMode ? " active" : "") + (selectedTags.length > 0 ? " has-filter" : "")}
                  onClick=${onToggleTagPanel} disabled=${textMode}
                  title=${textMode ? "Not available in reveal codes mode" : "Tag panel"}>
            <${IconTag} />
            ${selectedTags.length > 0 && html`<span className="tag-filter-count">${selectedTags.length}</span>`}
          </button>
        </div>
      `}
    </div>
  `;
}

// --- Toolbar Customizer popup ---

function ToolbarCustomizer({ toolbarConfig, onUpdate, onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return html`
    <div className="shortcut-editor-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tc-panel">
        <div className="shortcut-editor-hdr">
          <span className="shortcut-editor-title">Customize Toolbar</span>
          <button className="shortcut-editor-close" onClick=${onClose}>×</button>
        </div>
        <div className="tc-body">
          <p className="shortcut-editor-hint">Toggle which button groups appear in the top toolbar. Items marked "outline only" are always hidden in other views.</p>
          ${TOOLBAR_ITEMS.map((item) => html`
            <div className="tc-row" key=${item.id}>
              <div className="tc-row-text">
                <span className="tc-row-label">${item.label}</span>
                <span className="tc-row-desc">${item.desc}</span>
              </div>
              <button className=${"tc-toggle" + (toolbarConfig[item.id] ? " on" : "")}
                      onClick=${() => onUpdate(item.id, !toolbarConfig[item.id])}
                      aria-label=${toolbarConfig[item.id] ? "Hide " + item.label : "Show " + item.label}>
                <span className="tc-toggle-knob"></span>
              </button>
            </div>
          `)}
        </div>
      </div>
    </div>
  `;
}

// --- Shortcut Panel (reusable inline body) ---

function ShortcutPanel({ shortcutVer, onUpdate, onReset, onResetAll }) {
  const [recordingId, setRecordingId] = useState(null);

  useEffect(() => {
    if (!recordingId) return;
    const capture = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecordingId(null); return; }
      const combo = keyEventToCombo(e);
      if (combo) { onUpdate(recordingId, combo); setRecordingId(null); }
    };
    document.addEventListener("keydown", capture, true);
    return () => document.removeEventListener("keydown", capture, true);
  }, [recordingId, onUpdate]);

  const cats = [...new Set(SHORTCUT_DEFS.map((d) => d.cat))];

  return html`
    <div>
      <div className="shortcut-editor-hint">
        Click a binding to rebind it — press any key combo, Escape to cancel.
      </div>
      <button className="shortcut-reset-all-btn" onClick=${onResetAll}>Reset All to Defaults</button>
      ${cats.map((cat) => html`
        <div key=${cat} className="shortcut-cat-group">
          <div className="shortcut-cat-label">${cat === "Reference" ? "Reference (fixed)" : cat}</div>
          ${SHORTCUT_DEFS.filter((d) => d.cat === cat).map((d) => {
            const isRecording = recordingId === d.id;
            const custom = shortcutOverrides[d.id];
            const combo = custom || d.def;
            return html`
              <div key=${d.id} className=${"shortcut-row" + (d.fixed ? " shortcut-row-fixed" : "")}>
                <span className="shortcut-label">${d.label}</span>
                <button className=${"shortcut-combo-btn" + (isRecording ? " recording" : "") + (custom ? " custom" : "")}
                        disabled=${!!d.fixed}
                        onClick=${!d.fixed ? () => setRecordingId(d.id) : undefined}>
                  ${isRecording ? "Press keys…" : displayCombo(combo)}
                </button>
                ${!d.fixed && custom && !isRecording && html`
                  <button className="shortcut-row-reset" title=${"Reset to " + displayCombo(d.def)}
                          onClick=${() => onReset(d.id)}>↺</button>
                `}
                ${(!d.fixed && !custom) && html`<span className="shortcut-row-reset"></span>`}
              </div>
            `;
          })}
        </div>
      `)}
    </div>
  `;
}

// --- Shortcut Editor popup ---

function ShortcutEditor({ shortcutVer, onUpdate, onReset, onResetAll, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return html`
    <div className="shortcut-editor-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shortcut-editor">
        <div className="shortcut-editor-hdr">
          <span className="shortcut-editor-title">Keyboard Shortcuts</span>
          <button className="shortcut-editor-close" onClick=${onClose}>×</button>
        </div>
        <div className="shortcut-editor-body">
          <${ShortcutPanel} shortcutVer=${shortcutVer} onUpdate=${onUpdate} onReset=${onReset} onResetAll=${onResetAll} />
        </div>
      </div>
    </div>
  `;
}

function LevelFormatChip({ depth, levelFormats, onSetLevelFormat, textMode }) {
  const fmt = levelFormats ? levelFormats[depth] : null;
  const icon = fmt === "numbers" ? "1." : fmt === "letters" ? "a." : fmt === "upper" ? "A." : fmt === "bullets" ? "•" : "×";
  const next = !fmt ? "bullets" : fmt === "bullets" ? "numbers" : fmt === "numbers" ? "upper" : fmt === "upper" ? "letters" : null;
  return html`
    <button className=${"hfmt-chip hfmt-level-chip" + (fmt ? " override" : "")}
            title=${"Level " + (depth + 1) + ": " + (fmt || "global")}
            disabled=${textMode}
            onClick=${() => onSetLevelFormat(depth, next)}>
      L${depth + 1}${icon}
    </button>`;
}

function LevelFontChip({ depth, levelFonts, onSetLevelFont, textMode }) {
  const font = levelFonts ? levelFonts[depth] : null;
  const isCustom = font && font.startsWith("custom:");
  const selectVal = isCustom ? "custom" : (font || "");
  return html`
    <div className="stg-level-item">
      <span className="stg-level-label">L${depth + 1}</span>
      <select className=${"stg-level-select" + (font ? " override" : "")}
              value=${selectVal}
              disabled=${textMode}
              onChange=${(e) => {
                const v = e.target.value;
                if (v === "custom") onSetLevelFont(depth, "custom:");
                else onSetLevelFont(depth, v || null);
              }}>
        <option value="">Global</option>
        ${FONT_GROUPS.map(g => html`
          <optgroup key=${g.group} label=${g.group}>
            ${g.fonts.map(f => html`
              <option key=${f.id} value=${f.id}>${f.label}</option>
            `)}
          </optgroup>
        `)}
        <option value="custom">Custom…</option>
      </select>
      ${isCustom && html`
        <input type="text" className="stg-custom-font-input"
               style=${{ width: "100px", marginTop: "2px" }}
               placeholder="Font name"
               value=${font.slice(7)}
               onChange=${(e) => onSetLevelFont(depth, "custom:" + e.target.value)} />
      `}
    </div>
  `;
}

function LevelColorChip({ depth, levelColors, onSetLevelColor, textMode }) {
  const color = levelColors ? levelColors[depth] : null;
  const nextColor = () => {
    if (!color) return COLOR_PALETTE[0];
    const idx = COLOR_PALETTE.indexOf(color);
    return idx >= 0 && idx < COLOR_PALETTE.length - 1 ? COLOR_PALETTE[idx + 1] : null;
  };
  return html`
    <button className=${"hfmt-chip hfmt-level-chip hfmt-color-chip" + (color ? " override" : "")}
            style=${{ background: color || undefined, color: color ? "#fff" : undefined, borderColor: color || undefined }}
            title=${"Level " + (depth + 1) + " color: " + (color || "global")}
            disabled=${textMode}
            onClick=${() => onSetLevelColor(depth, nextColor())}>
      ${color ? "" : html`<span>L${depth + 1}×</span>`}
      ${color ? html`<span>L${depth + 1}</span>` : ""}
    </button>`;
}

// ─── Settings Modal sub-components ───────────────────────────────────────────
function StgRow({ label, desc, children }) {
  return html`
    <div className="stg-row">
      <div className="stg-row-label">
        <span className="stg-label">${label}</span>
        ${desc && html`<span className="stg-desc">${desc}</span>`}
      </div>
      <div className="stg-row-ctrl">${children}</div>
    </div>
  `;
}

function FontSelect({ value, onChange, disabled }) {
  const isCustom = value && value.startsWith("custom:");
  const selectVal = isCustom ? "custom" : (value || "inter");
  return html`
    <div className="stg-font-wrap">
      <select className="stg-select"
              value=${selectVal}
              disabled=${disabled}
              onChange=${(e) => {
                const v = e.target.value;
                if (v === "custom") onChange("custom:");
                else onChange(v === "inter" ? null : v);
              }}>
        ${FONT_GROUPS.map(g => html`
          <optgroup key=${g.group} label=${g.group}>
            ${g.fonts.map(f => html`
              <option key=${f.id} value=${f.id}>${f.label}</option>
            `)}
          </optgroup>
        `)}
        <option value="custom">Custom…</option>
      </select>
      ${isCustom && html`
        <input type="text" className="stg-custom-font-input"
               placeholder="Font name"
               value=${value.slice(7)}
               onChange=${(e) => onChange("custom:" + e.target.value)} />
      `}
    </div>
  `;
}

function ColorPickerRow({ color, onChange, disabled }) {
  return html`
    <div className="stg-color-row">
      <button className=${"stg-color-swatch stg-color-none" + (!color ? " active" : "")}
              title="No color"
              disabled=${disabled}
              onClick=${() => onChange(null)}>×</button>
      ${COLOR_PALETTE.map(c => html`
        <button key=${c} className=${"stg-color-swatch" + (color === c ? " active" : "")}
                style=${{ background: c }}
                title=${c}
                disabled=${disabled}
                onClick=${() => onChange(c)} />
      `)}
      <input type="text" className="stg-hex-input"
             placeholder="#hex"
             disabled=${disabled}
             value=${color && !COLOR_PALETTE.includes(color) ? color : ""}
             onBlur=${(e) => { const v = e.target.value.trim(); if (/^#[0-9a-fA-F]{3,6}$/.test(v)) onChange(v); else if (!v) onChange(null); }}
             onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} />
    </div>
  `;
}

function SettingsModal({
  onClose,
  initialSection,
  syncStatus,
  theme, onToggleTheme,
  topBarColor, onSetTopBarColor,
  outlineFormat, onSetOutlineFormat, levelFormats, onSetLevelFormat,
  globalFont, onSetGlobalFont, levelFonts, onSetLevelFont,
  globalColor, onSetGlobalColor, levelColors, onSetLevelColor,
  verticalLines, onToggleVerticalLines,
  readingWidth, onToggleReadingWidth,
  showTagChips, onToggleShowTagChips, tagsOnRight, onToggleTagsOnRight,
  homeDir, onChangeHomeDir,
  homeFile, onSetHomeFile, currentFile,
  journalDir, onChangeJournalDir, onClearJournalDir,
  statusBarVisible, onToggleStatusBar,
  headerCollapsed, onToggleHeaderCollapsed,
  titleFormatMode, onToggleTitleFormat,
  notesVisible, onToggleNotesVisible,
  dateStampFmt, onSetDateStampFmt,
  tagListFile, onChangeTagListFile, onClearTagListFile,
  bookmarkListFile, onChangeBookmarkListFile, onClearBookmarkListFile,
  backupMaxVersions, onChangeBackupMaxVersions,
  shortcutVer, onUpdateShortcut, onResetShortcut, onResetAllShortcuts,
  toolbarConfig, onUpdateToolbarConfig,
  view, onSetView,
  textMode, onSetViewMode,
  isHoisted, canToggleHoist, onToggleHoist,
  onFoldToLevel,
  onExportToOrg, onExportToHtml, onExportToMarkdown, onImportFromMarkdown,
  tagPanelVisible, onToggleTagPanel,
  bookmarkPanelVisible, onToggleBookmarkPanel,
  workspaceConfig, onConfigureWorkspace,
  savedWorkspaceProfiles, onSaveCurrentAsWorkspaceProfile, onDeleteWorkspaceProfile, onSwitchWorkspaceProfile,
}) {
  const [section, setSection] = useState(initialSection || "view");
  const colorInputRef = useRef(null);
  const isCustomTopBarColor = topBarColor && topBarColor.startsWith("#");
  const [newWorkspaceProfileName, setNewWorkspaceProfileName] = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const STG_SECTIONS = [
    { id: "view",       label: "View" },
    { id: "appearance", label: "Appearance" },
    { id: "editor",     label: "Editor" },
    { id: "workspace",  label: "Workspace" },
    { id: "backups",    label: "Versioning/Backups" },
    { id: "keyboard",   label: "Keyboard" },
    { id: "about",      label: "About" },
  ];

  const renderSection = () => {
    if (section === "view") return html`
      <div className="stg-section">
        <p className="stg-section-title">Main View</p>
        <${StgRow} label="Top bar" desc="Uncheck to collapse it to a small corner tab — click the tab to bring it back">
          <input type="checkbox" checked=${!headerCollapsed} onChange=${onToggleHeaderCollapsed} />
        </${StgRow}>
        <${StgRow} label="Status bar" desc="Shows the current file and workspace path at the bottom of the window">
          <input type="checkbox" checked=${statusBarVisible} onChange=${onToggleStatusBar} />
        </${StgRow}>
        <${StgRow} label="View mode">
          <div className="stg-segmented">
            ${[
              { id: "outline", label: "Outline" },
              { id: "agenda",  label: "Agenda" },
              { id: "todo",    label: "TODO" },
              { id: "journal", label: "Journal" },
            ].map(({ id, label }) => html`
              <button key=${id}
                      className=${"stg-segmented-btn" + (view === id ? " active" : "")}
                      onClick=${() => { onSetView(id); onClose(); }}>
                ${label}
              </button>
            `)}
          </div>
        </${StgRow}>
        <${StgRow} label="Tag panel visible">
          <input type="checkbox" checked=${tagPanelVisible} onChange=${onToggleTagPanel} />
        </${StgRow}>
        <${StgRow} label="Bookmark panel visible">
          <input type="checkbox" checked=${bookmarkPanelVisible} onChange=${onToggleBookmarkPanel} />
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Title Display</p>
        <${StgRow} label="Render format" desc="How heading text is rendered">
          <div className="stg-segmented">
            <button className=${"stg-segmented-btn" + (!titleFormatMode && !textMode ? " active" : "")}
                    onClick=${() => onSetViewMode("plain")}>Plain</button>
            <button className=${"stg-segmented-btn" + (titleFormatMode && !textMode ? " active" : "")}
                    onClick=${() => onSetViewMode("formatted")}>Formatted</button>
            <button className=${"stg-segmented-btn" + (textMode ? " active" : "")}
                    onClick=${() => onSetViewMode("reveal")}>Reveal Codes</button>
          </div>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Outline Options</p>
        <${StgRow} label="Show body text and images" desc="Display body text and images beneath each heading">
          <input type="checkbox" checked=${notesVisible} onChange=${onToggleNotesVisible}
                 disabled=${textMode || view !== "outline"} />
        </${StgRow}>
        <${StgRow} label="Hoist" desc="Isolate the focused item, hiding everything else">
          <input type="checkbox" checked=${isHoisted} onChange=${onToggleHoist}
                 disabled=${!canToggleHoist || textMode || view !== "outline"} />
        </${StgRow}>
        <${StgRow} label="Fold to level" desc="Collapse outline to this depth">
          <div className="stg-segmented">
            ${FOLD_LEVELS.map((lvl) => html`
              <button key=${lvl}
                      className="stg-segmented-btn"
                      disabled=${textMode || view !== "outline"}
                      onClick=${() => { onFoldToLevel(lvl); onClose(); }}>
                ${lvl}
              </button>
            `)}
            <button className="stg-segmented-btn"
                    disabled=${textMode || view !== "outline"}
                    onClick=${() => { onFoldToLevel(9); onClose(); }}
                    title="Expand all levels">
              ∞
            </button>
          </div>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Toolbar Buttons</p>
        <p className="stg-desc" style=${{ marginBottom: "8px", fontSize: "12px", color: "var(--text-dim)" }}>
          Choose which button groups appear in the top toolbar.
        </p>
        ${TOOLBAR_ITEMS.map((item) => html`
          <${StgRow} key=${item.id} label=${item.label} desc=${item.desc}>
            <input type="checkbox"
                   checked=${toolbarConfig[item.id]}
                   onChange=${() => onUpdateToolbarConfig(item.id, !toolbarConfig[item.id])} />
          </${StgRow}>
        `)}
      </div>
    `;
    if (section === "appearance") return html`
      <div className="stg-section">
        <p className="stg-section-title">Theme</p>
        <${StgRow} label="Color theme">
          <div className="stg-segmented">
            <button className=${"stg-segmented-btn" + (theme === "dark" ? " active" : "")}
                    onClick=${() => theme !== "dark" && onToggleTheme()}>Dark</button>
            <button className=${"stg-segmented-btn" + (theme === "light" ? " active" : "")}
                    onClick=${() => theme !== "light" && onToggleTheme()}>Light</button>
          </div>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Top Bar</p>
        <${StgRow} label="Top bar color">
          <div className="topbar-color-chips">
            <button className=${"topbar-chip topbar-chip-none" + (!topBarColor ? " active" : "")}
                    onClick=${() => onSetTopBarColor(null)}>None</button>
            ${["green", "blue", "red"].map((c) => html`
              <button key=${c}
                      className=${"topbar-chip" + (topBarColor === c ? " active" : "")}
                      style=${{ background: TOPBAR_COLORS[c] }}
                      onClick=${() => onSetTopBarColor(c)}
                      title=${c.charAt(0).toUpperCase() + c.slice(1)}></button>
            `)}
            <div className="topbar-chip-custom-wrap">
              <button className=${"topbar-chip topbar-chip-custom" + (isCustomTopBarColor ? " active" : "")}
                      style=${isCustomTopBarColor ? { background: topBarColor } : {}}
                      onClick=${() => colorInputRef.current?.click()}
                      title=${isCustomTopBarColor ? "Custom: " + topBarColor : "Custom color…"}></button>
              <input ref=${colorInputRef} type="color" className="topbar-color-input-hidden"
                     value=${isCustomTopBarColor ? topBarColor : "#225167"}
                     onInput=${(e) => onSetTopBarColor(e.target.value)} />
            </div>
          </div>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Bullet Style</p>
        <${StgRow} label="Global" desc="Default bullet style for all levels">
          <div className="hamburger-format-chips">
            ${["bullets", "numbers", "letters", "upper"].map((fmt) => html`
              <button key=${fmt}
                      className=${"hfmt-chip" + (outlineFormat === fmt ? " active" : "")}
                      onClick=${() => onSetOutlineFormat(fmt)}>
                ${fmt === "bullets" ? "• Bullets" : fmt === "numbers" ? "1. Numbers" : fmt === "letters" ? "a. Letters" : "A. Letters"}
              </button>
            `)}
          </div>
        </${StgRow}>
        <${StgRow} label="Per level" desc="Override per level (× = use global)">
          <div className="hamburger-format-chips">
            ${[0, 1, 2, 3, 4, 5].map((d) => html`
              <${LevelFormatChip} key=${d} depth=${d} levelFormats=${levelFormats} onSetLevelFormat=${onSetLevelFormat} textMode=${false} />
            `)}
          </div>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Fonts</p>
        <${StgRow} label="Global font" desc="Default heading font">
          <${FontSelect} value=${globalFont} onChange=${onSetGlobalFont} />
        </${StgRow}>
        <div className="stg-row stg-row-full">
          <div className="stg-row-label">
            <span className="stg-label">Per-level font</span>
            <span className="stg-desc">Override heading font per level</span>
          </div>
          <div className="stg-row-ctrl stg-level-grid">
            ${[0, 1, 2, 3, 4, 5].map((d) => html`
              <${LevelFontChip} key=${d} depth=${d} levelFonts=${levelFonts} onSetLevelFont=${onSetLevelFont} textMode=${false} />
            `)}
          </div>
        </div>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Colors</p>
        <${StgRow} label="Global heading color">
          <${ColorPickerRow} color=${globalColor} onChange=${onSetGlobalColor} />
        </${StgRow}>
        <div className="stg-row stg-row-full">
          <div className="stg-row-label">
            <span className="stg-label">Per-level color</span>
            <span className="stg-desc">Override heading color per level</span>
          </div>
          <div className="stg-row-ctrl">
            <div className="hamburger-format-chips">
              ${[0, 1, 2, 3, 4, 5].map((d) => html`
                <${LevelColorChip} key=${d} depth=${d} levelColors=${levelColors} onSetLevelColor=${onSetLevelColor} textMode=${false} />
              `)}
            </div>
          </div>
        </div>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Layout</p>
        <${StgRow} label="Vertical indent lines">
          <input type="checkbox" checked=${verticalLines} onChange=${onToggleVerticalLines} />
        </${StgRow}>
        <${StgRow} label="Reading width" desc="Limit line length for comfortable reading">
          <input type="checkbox" checked=${readingWidth} onChange=${onToggleReadingWidth} />
        </${StgRow}>
        <${StgRow} label="Show tags and status in outline">
          <input type="checkbox" checked=${showTagChips} onChange=${onToggleShowTagChips} />
        </${StgRow}>
        ${showTagChips && html`
          <${StgRow} label="Show on right">
            <input type="checkbox" checked=${tagsOnRight} onChange=${onToggleTagsOnRight} />
          </${StgRow}>
        `}
      </div>
    `;
    if (section === "workspace") return html`
      <div className="stg-section">
        <p className="stg-section-title">Saved Workspaces</p>
        <p className="stg-desc" style=${{ marginBottom: "10px" }}>
          Switch between entirely separate working folders — each remembers its own
          home folder, tag list, bookmark list, journal folder, and home file.
        </p>
        ${savedWorkspaceProfiles.length === 0 && html`
          <p className="stg-desc" style=${{ fontStyle: "italic", marginBottom: "10px" }}>No saved workspaces yet.</p>
        `}
        ${savedWorkspaceProfiles.map((p) => html`
          <div key=${p.name} className="stg-row">
            <div className="stg-row-label">
              <span className="stg-label">${p.name}</span>
              <span className="stg-desc">${p.homeDir}</span>
            </div>
            <div className="stg-row-ctrl">
              <button className="stg-btn" disabled=${p.homeDir === homeDir}
                      onClick=${() => onSwitchWorkspaceProfile(p)}>
                ${p.homeDir === homeDir ? "Current" : "Switch"}
              </button>
              <button className="stg-btn stg-btn-clear" title="Delete"
                      onClick=${() => onDeleteWorkspaceProfile(p.name)}>×</button>
            </div>
          </div>
        `)}
        <${StgRow} label="Save current as…" desc="Remembers the settings below under this name">
          <input type="text" className="stg-text-input" placeholder="Workspace name"
                 value=${newWorkspaceProfileName}
                 onChange=${(e) => setNewWorkspaceProfileName(e.target.value)}
                 onKeyDown=${(e) => {
                   if (e.key === "Enter" && newWorkspaceProfileName.trim()) {
                     onSaveCurrentAsWorkspaceProfile(newWorkspaceProfileName.trim());
                     setNewWorkspaceProfileName("");
                   }
                 }} />
          <button className="stg-btn" disabled=${!newWorkspaceProfileName.trim()}
                  onClick=${() => { onSaveCurrentAsWorkspaceProfile(newWorkspaceProfileName.trim()); setNewWorkspaceProfileName(""); }}>
            Save
          </button>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Workspace</p>
        <${StgRow} label="Home Folder" desc="Root directory for org files">
          <span className="stg-path">${homeDir || "—"}</span>
          <button className="stg-btn" onClick=${onChangeHomeDir}>Change…</button>
        </${StgRow}>
        <${StgRow} label="Home File" desc="File opened at startup">
          <span className="stg-path">${homeFile || html`<em style=${{ color: "var(--text-dim)" }}>not set</em>`}</span>
          <button className="stg-btn" disabled=${!currentFile}
                  onClick=${() => onSetHomeFile(currentFile)}
                  title=${currentFile ? "Set \"" + currentFile + "\" as home file" : "Open a file first"}>
            Set Current
          </button>
          ${homeFile && html`<button className="stg-btn stg-btn-clear" onClick=${() => onSetHomeFile(null)} title="Clear">×</button>`}
        </${StgRow}>
        <${StgRow} label="Journal Folder" desc="Folder for daily journal files">
          <span className="stg-path">${journalDir || "(same as home folder)"}</span>
          <button className="stg-btn" onClick=${onChangeJournalDir}>Change…</button>
          ${journalDir && html`<button className="stg-btn stg-btn-clear" onClick=${onClearJournalDir} title="Reset to default">×</button>`}
        </${StgRow}>
        <${StgRow} label="Search Paths" desc="Folders included in file listing and search">
          ${(() => {
            if (!workspaceConfig) return html`<span className="stg-path">—</span>`;
            const inc = (workspaceConfig.paths || []).filter(p => p.included);
            const exc = (workspaceConfig.paths || []).filter(p => !p.included);
            const summary = (inc.length === 1 && exc.length === 0)
              ? "1 folder (home folder only)"
              : inc.length + " folder" + (inc.length === 1 ? "" : "s") + (exc.length ? " · " + exc.length + " excluded" : "");
            return html`<span className="stg-path">${summary}</span>`;
          })()}
          <button className="stg-btn" onClick=${onConfigureWorkspace}>Configure…</button>
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Tag and Bookmark Lists</p>
        <${StgRow} label="Tag List File" desc="Org file containing the tag list">
          <span className="stg-path">${tagListFile || "(default: TagList.org)"}</span>
          <button className="stg-btn" onClick=${onChangeTagListFile}>Change…</button>
          ${tagListFile && html`<button className="stg-btn stg-btn-clear" onClick=${onClearTagListFile} title="Reset to default">×</button>`}
        </${StgRow}>
        <${StgRow} label="Bookmark List File" desc="Org file containing the bookmark list">
          <span className="stg-path">${bookmarkListFile || "(default: Bookmarks.org)"}</span>
          <button className="stg-btn" onClick=${onChangeBookmarkListFile}>Change…</button>
          ${bookmarkListFile && html`<button className="stg-btn stg-btn-clear" onClick=${onClearBookmarkListFile} title="Reset to default">×</button>`}
        </${StgRow}>
      </div>
      <div className="stg-section">
        <p className="stg-section-title">Export</p>
        <${StgRow} label="Export to HTML" desc="Save a standalone HTML file of this document">
          <button className="stg-btn" disabled=${!currentFile}
                  onClick=${() => { onExportToHtml?.(); onClose(); }}
                  title=${!currentFile ? "Open a file first" : "Export current file to HTML"}>
            Export…
          </button>
        </${StgRow}>
        <${StgRow} label="Export to Org" desc="Save a local copy of the org file for backup">
          <button className="stg-btn" disabled=${!currentFile}
                  onClick=${() => { onExportToOrg?.(); onClose(); }}
                  title=${!currentFile ? "Open a file first" : "Download org file"}>
            Export…
          </button>
        </${StgRow}>
        <${StgRow} label="Export to Markdown" desc="Save as a GitHub-flavoured Markdown (.md) file">
          <button className="stg-btn" disabled=${!currentFile}
                  onClick=${() => { onExportToMarkdown?.(); onClose(); }}
                  title=${!currentFile ? "Open a file first" : "Download Markdown file"}>
            Export…
          </button>
        </${StgRow}>
        <${StgRow} label="Import from Markdown" desc="Replace the current document with a .md file">
          <label className="stg-btn stg-file-label" title=${!currentFile ? "Open a file first" : "Import a Markdown file into this document"} style=${currentFile ? {} : { opacity: 0.45, pointerEvents: "none" }}>
            Import…
            <input type="file" accept=".md,text/markdown" style=${{ display: "none" }}
                   onChange=${(e) => { const f = e.target.files?.[0]; if (f) { onImportFromMarkdown?.(f); onClose(); } e.target.value = ""; }} />
          </label>
        </${StgRow}>
      </div>
    `;
    if (section === "backups") return html`
      <div className="stg-section">
        <p className="stg-section-title">Versioning / Backups</p>
        <p className="stg-desc" style=${{ marginBottom: "10px" }}>
          Independent of the git history epicorg keeps automatically, this saves
          numbered copies of each file right alongside it — Emacs-style
          (e.g. "Welcome.org.~3~") — as a simple fallback you can browse without
          using git. New backups are made when opening a file, after 20 minutes
          idle, and on shutdown; backup files never show up in the file list or
          search.
        </p>
        <${StgRow} label="Keep backups" desc="Saves numbered copies (name.~N~) next to each file">
          <input type="checkbox" checked=${(backupMaxVersions ?? 0) > 0}
                 onChange=${(e) => onChangeBackupMaxVersions(e.target.checked ? ((backupMaxVersions ?? 0) > 0 ? backupMaxVersions : 5) : 0)} />
        </${StgRow}>
        <${StgRow} label="Versions to keep" desc="Oldest backups beyond this count are deleted automatically">
          <input type="number" className="stg-number-input" min="1" max="50"
                 disabled=${(backupMaxVersions ?? 0) <= 0}
                 value=${(backupMaxVersions ?? 0) > 0 ? backupMaxVersions : 5}
                 onChange=${(e) => {
                   const n = parseInt(e.target.value, 10);
                   if (n > 0) onChangeBackupMaxVersions(n);
                 }} />
        </${StgRow}>
      </div>
    `;
    if (section === "editor") return html`
      <div className="stg-section">
        <p className="stg-section-title">Date Stamp</p>
        <${StgRow} label="Date format">
          <div className="stg-segmented">
            ${DATE_FMT_OPTIONS.map((opt) => html`
              <button key=${opt.key}
                      className=${"stg-segmented-btn" + (dateStampFmt?.date === opt.key ? " active" : "")}
                      onClick=${() => onSetDateStampFmt({ ...dateStampFmt, date: opt.key })}>
                ${opt.label}
              </button>
            `)}
          </div>
        </${StgRow}>
        <${StgRow} label="Time format">
          <div className="stg-segmented">
            ${TIME_FMT_OPTIONS.map((opt) => html`
              <button key=${opt.key}
                      className=${"stg-segmented-btn" + (dateStampFmt?.time === opt.key ? " active" : "")}
                      onClick=${() => onSetDateStampFmt({ ...dateStampFmt, time: opt.key })}>
                ${opt.label}
              </button>
            `)}
          </div>
        </${StgRow}>
      </div>
    `;
    if (section === "keyboard") return html`
      <div className="stg-section">
        <p className="stg-section-title">Keyboard Shortcuts</p>
        <${ShortcutPanel}
          shortcutVer=${shortcutVer}
          onUpdate=${onUpdateShortcut}
          onReset=${onResetShortcut}
          onResetAll=${onResetAllShortcuts} />
      </div>
    `;
    if (section === "about") return html`
      <div className="stg-section">
        <p className="stg-section-title">About Epicorg</p>
        <p style=${{ fontSize: "13px", color: "var(--text)", lineHeight: "1.6", marginBottom: "10px" }}>
          Epicorg was originally prepared by Cassius Amicus in 2026 for his personal use in working with an outline of Epicurean philosophy.
        </p>
        <p style=${{ fontSize: "13px", color: "var(--text)", lineHeight: "1.6", marginBottom: "6px" }}>
          As Epicurus wrote in his letter to Herodotus:
        </p>
        <blockquote className="about-quote" style=${{ margin: "0 0 12px 0" }}>
          <p style=${{ fontSize: "13px", lineHeight: "1.6", marginBottom: "8px" }}>For those who are unable, Herodotus, to work in detail through all that I have written about nature, or to peruse the larger books which I have composed, I have already prepared at sufficient length an epitome of the whole system, that they may keep adequately in mind at least the most general principles in each department, in order that as occasion arises they may be able to assist themselves on the most important points, in so far as they undertake the study of nature. But those also who have made considerable progress in the survey of the main principles ought to bear in mind the scheme of the whole system set forth in its essentials. For we have frequent need of the general view, but not so often of the detailed exposition.</p>
          <p style=${{ fontSize: "13px", lineHeight: "1.6" }}>Indeed it is necessary to go back on the main principles, and constantly to fix in one's memory enough to give one the most essential comprehension of the truth. And in fact the accurate knowledge of details will be fully discovered, if the general principles in the various departments are thoroughly grasped and borne in mind; for even in the case of one fully initiated the most essential feature in all accurate knowledge is the capacity to make a rapid use of observation and mental apprehension, and this can be done if everything is summed up in elementary principles and formulae. For it is not possible for anyone to abbreviate the complete course through the whole system, if he cannot embrace in his own mind by means of short formulae all that might be set out with accuracy in detail.</p>
        </blockquote>
        <p style=${{ fontSize: "13px", color: "var(--text)", lineHeight: "1.6", marginBottom: "6px" }}>
          The significance of Epicurus was best expressed by Lucretius in his poem <em>On The Nature of Things</em>:
        </p>
        <blockquote className="about-quote" style=${{ margin: "0 0 12px 0" }}>
          <p style=${{ fontSize: "13px", lineHeight: "1.6" }}>When human life lay foully grovelling upon the earth, crushed down by the weight of religion, which showed her face from the realms of heaven, glaring down dreadfully upon men, it was Epicurus who dared first to raise his mortal eyes to stand up against her. Neither the fables of the gods, nor thunderbolts, nor the threatening sky held him back, but instead spurred on his eager desire to be the first to burst through the close-set bolts upon the doors of Nature. And so it was that the living force of his mind won its way, and he passed on, far beyond the fiery walls of the world, and in mind and spirit traversed the boundless whole. From there in victory he returned, bringing us tidings of what can come to be and what cannot, and in what way each thing has its power limited as if by a deep-set boundary stone. And so false religion in revenge is cast beneath men's feet and trampled, and his victory raises us to the skies.</p>
        </blockquote>
        <p style=${{ fontSize: "13px", color: "var(--text)", lineHeight: "1.6", marginBottom: "10px" }}>
          For more information about Epicurean philosophy please visit${" "}
          <a href="https://www.epicurustoday.com" target="_blank" rel="noopener noreferrer"
             style=${{ color: "var(--accent)" }}>EpicurusToday.com</a>${" "}
          and${" "}
          <a href="https://www.epicureanfriends.com" target="_blank" rel="noopener noreferrer"
             style=${{ color: "var(--accent)" }}>EpicureanFriends.com</a>.
        </p>
        <p style=${{ fontSize: "12px", color: "var(--text-dim)", marginBottom: "4px" }}>
          <a href="https://github.com/cassiusamicus/epicorg" target="_blank" rel="noopener noreferrer"
             style=${{ color: "var(--accent)" }}>github.com/cassiusamicus/epicorg</a>
          ${" — "}License: GPL-3.0
        </p>
      </div>
    `;
    return null;
  };

  return html`
    <div className="stg-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="stg-modal">
        <div className="stg-header">
          <span className="stg-title">Settings</span>
          <div className="stg-header-right">
            <${SyncIndicator} status=${syncStatus} />
            <span className=${"stg-sync-label sync-" + syncStatus}>${SYNC_SHORT_LABELS[syncStatus] || ""}</span>
            <button className="stg-close" onClick=${onClose}>×</button>
          </div>
        </div>
        <div className="stg-body">
          <nav className="stg-nav">
            ${STG_SECTIONS.map(s => html`
              <button key=${s.id}
                      className=${"stg-nav-item" + (section === s.id ? " active" : "")}
                      onClick=${() => setSection(s.id)}>
                ${s.label}
              </button>
            `)}
          </nav>
          <div className="stg-content">
            ${renderSection()}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─── Hamburger menu ───────────────────────────────────────────────────────────
function HamburgerMenu({ onOpenSettings }) {
  return html`
    <div className="hamburger-menu">
      <button className="panel-toggle-btn" onClick=${() => onOpenSettings?.()} title="Settings">
        <${IconHamburger} />
      </button>
    </div>
  `;
}

function AboutModal({ onClose }) {
  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return html`
    <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="about-dialog">
        <div className="about-header">
          <h2>About Epicorg</h2>
          <button className="folder-picker-close" onClick=${onClose}>×</button>
        </div>
        <div className="about-body">
          <p>Epicorg was originally prepared by Cassius Amicus in 2026 for his personal use in working with an outline of Epicurean philosophy.</p>
          <p>As Epicurus wrote in his letter to Herodotus:</p>
          <blockquote className="about-quote">
            <p>For those who are unable, Herodotus, to work in detail through all that I have written about nature, or to peruse the larger books which I have composed, I have already prepared at sufficient length an epitome of the whole system, that they may keep adequately in mind at least the most general principles in each department, in order that as occasion arises they may be able to assist themselves on the most important points, in so far as they undertake the study of nature. But those also who have made considerable progress in the survey of the main principles ought to bear in mind the scheme of the whole system set forth in its essentials. For we have frequent need of the general view, but not so often of the detailed exposition.</p>
            <p>Indeed it is necessary to go back on the main principles, and constantly to fix in one's memory enough to give one the most essential comprehension of the truth. And in fact the accurate knowledge of details will be fully discovered, if the general principles in the various departments are thoroughly grasped and borne in mind; for even in the case of one fully initiated the most essential feature in all accurate knowledge is the capacity to make a rapid use of observation and mental apprehension, and this can be done if everything is summed up in elementary principles and formulae. For it is not possible for anyone to abbreviate the complete course through the whole system, if he cannot embrace in his own mind by means of short formulae all that might be set out with accuracy in detail.</p>
          </blockquote>
          <p>The significance of Epicurus was best expressed by Lucretius in his poem <em>On The Nature of Things</em>:</p>
          <blockquote className="about-quote">
            <p>When human life lay foully grovelling upon the earth, crushed down by the weight of religion, which showed her face from the realms of heaven, glaring down dreadfully upon men, it was Epicurus who dared first to raise his mortal eyes to stand up against her. Neither the fables of the gods, nor thunderbolts, nor the threatening sky held him back, but instead spurred on his eager desire to be the first to burst through the close-set bolts upon the doors of Nature. And so it was that the living force of his mind won its way, and he passed on, far beyond the fiery walls of the world, and in mind and spirit traversed the boundless whole. From there in victory he returned, bringing us tidings of what can come to be and what cannot, and in what way each thing has its power limited as if by a deep-set boundary stone. And so false religion in revenge is cast beneath men's feet and trampled, and his victory raises us to the skies.</p>
          </blockquote>
          <p>For more information about Epicurean philosophy please visit <a href="https://www.epicurustoday.com" target="_blank" rel="noopener noreferrer">EpicurusToday.com</a> and <a href="https://www.epicureanfriends.com" target="_blank" rel="noopener noreferrer">EpicureanFriends.com</a>.</p>
        </div>
      </div>
    </div>
  `;
}

function TagFilterButton({ allTags, selectedTags, onToggleTag, onClearTags }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (allTags.length === 0) return null;

  return html`
    <div className="tag-filter" ref=${containerRef}>
      <button className=${"view-tab tag-filter-btn" + (selectedTags.length > 0 ? " active" : "")}
              onClick=${() => setOpen((o) => !o)}
              title=${selectedTags.length > 0
                ? `Filtering by ${selectedTags.length} tag${selectedTags.length > 1 ? "s" : ""} — click to change`
                : "Filter by tag"}>
        <${IconTag} />
        ${selectedTags.length > 0 && html`<span className="tag-filter-count">${selectedTags.length}</span>`}
      </button>
      ${open && html`
        <div className="tag-filter-popup">
          ${selectedTags.length > 0 && html`
            <button className="tag-filter-clear" onClick=${onClearTags}>Clear tag filters</button>
          `}
          ${allTags.map((tag) => html`
            <label className="tag-filter-option" key=${tag}>
              <input type="checkbox" checked=${selectedTags.includes(tag)} onChange=${() => onToggleTag(tag)} />
              <span>${tag}</span>
            </label>
          `)}
        </div>
      `}
    </div>
  `;
}

function OutlineActionsPanel({ onAction, focusedId, onClose }) {
  const canAct = focusedId && focusedId !== "preamble";

  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem("epicorg.oap.pinned") === "1"; } catch { return false; }
  });
  const togglePin = () => setPinned((p) => {
    const next = !p;
    try { localStorage.setItem("epicorg.oap.pinned", next ? "1" : "0"); } catch {}
    return next;
  });

  const act = (action) => {
    if (!canAct) return;
    onAction(action);
    if (!pinned) onClose();
  };

  // Drag state: null = centered via CSS, {left, top} = user has moved it
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);

  const onHeaderMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = panelRef.current.getBoundingClientRect();
    dragState.current = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    const onMove = (me) => {
      const { startX, startY, origLeft, origTop } = dragState.current;
      setPos({ left: origLeft + me.clientX - startX, top: origTop + me.clientY - startY });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const GROUPS = [
    {
      label: "Move Subtree",
      sub: "Node moves with all its children",
      items: [
        { dir: "↑", name: "Move Up",            shortcutId: "moveUp",     action: "move-up" },
        { dir: "↓", name: "Move Down",           shortcutId: "moveDown",   action: "move-down" },
        { dir: "→", name: "Demote / Indent",     shortcutId: "indent",     action: "indent" },
        { dir: "←", name: "Promote / Outdent",   shortcutId: "outdent",    action: "outdent" },
      ],
    },
    {
      label: "Move Heading Only",
      sub: "Children are left in place as siblings",
      items: [
        { dir: "↑", name: "Move Heading Up",     shortcutId: "moveUpOnly",   action: "move-up-only" },
        { dir: "↓", name: "Move Heading Down",   shortcutId: "moveDownOnly", action: "move-down-only" },
        { dir: "→", name: "Demote Heading",      shortcutId: "indentOnly",   action: "indent-only" },
        { dir: "←", name: "Promote Heading",     shortcutId: "outdentOnly",  action: "outdent-only" },
      ],
    },
  ];

  const panelStyle = pos
    ? { left: pos.left + "px", top: pos.top + "px", transform: "none" }
    : {};

  return html`
    <div className="oap-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref=${panelRef} className="oap-panel" style=${panelStyle}>
        <div className="oap-header" onMouseDown=${onHeaderMouseDown}>
          <span className="oap-title">Outline Move</span>
          <button className=${"pin-btn" + (pinned ? " pinned" : "")}
                  onClick=${togglePin}
                  onMouseDown=${(e) => e.stopPropagation()}
                  title=${pinned ? "Pinned — panel stays open after action (click to unpin)" : "Pin — keep panel open after action"}>
            <${IconPin} />
          </button>
          <button className="oap-close" onClick=${onClose} onMouseDown=${(e) => e.stopPropagation()} title="Close">×</button>
        </div>
        ${!canAct && html`<div className="oap-no-focus">Select a node first</div>`}
        ${GROUPS.map((g) => html`
          <div className="oap-group" key=${g.label}>
            <div className="oap-group-label">${g.label}</div>
            <div className="oap-group-sub">${g.sub}</div>
            ${g.items.map((item) => {
              const combo = getShortcutCombo(item.shortcutId);
              const keys = combo ? displayCombo(combo) : "—";
              return html`
                <button key=${item.action}
                        className=${"oap-item" + (!canAct ? " oap-item-disabled" : "")}
                        onClick=${() => act(item.action)}
                        disabled=${!canAct}>
                  <span className="oap-item-dir">${item.dir}</span>
                  <span className="oap-item-name">${item.name}</span>
                  <span className="oap-item-keys">${keys}</span>
                </button>
              `;
            })}
          </div>
        `)}
      </div>
    </div>
  `;
}

function Header({ onHelp, syncStatus, view, setView, currentFile, onBack, searchQuery, setSearchQuery, searchInputRef, filterExpanded, setFilterExpanded, allTags, selectedTags, onToggleTag, onClearTags, detailVisible, onToggleDetails, tagPanelVisible, onToggleTagPanel, bookmarkPanelVisible, onToggleBookmarkPanel, titleFormatMode, onToggleTitleFormat, textMode, onToggleTextMode, onCycleViewMode, onSetViewMode, textModeError, notesVisible, onToggleNotesVisible, outlineFormat, onSetOutlineFormat, levelFormats, onSetLevelFormat, globalFont, onSetGlobalFont, levelFonts, onSetLevelFont, globalColor, onSetGlobalColor, levelColors, onSetLevelColor, verticalLines, onToggleVerticalLines, showTagChips, onToggleShowTagChips, tagsOnRight, onToggleTagsOnRight, isHoisted, canToggleHoist, onToggleHoist, readingWidth, onToggleReadingWidth, sidebarVisible, onToggleSidebar, onFoldToLevel, theme, onToggleTheme, topBarColor, onSetTopBarColor, canUndo, canRedo, onUndo, onRedo, homeDir, onPickHomeDir, journalDir, onPickJournalDir, onClearJournalDir, tagListFile, onPickTagListFile, onClearTagListFile, bookmarkListFile, onPickBookmarkListFile, onClearBookmarkListFile, onOpenTextSearch, onOpenSearchPanel, searchPanelOpen, canGoBack, canGoForward, onGoBack, onGoForward, homeFile, onGoHome, onSetHomeFile, toolbarConfig, statusBarVisible, onToggleStatusBar, dateStampFmt, onSetDateStampFmt, onShowShortcutEditor, onShowOutlineActions, onShowToolbarCustomizer, onExportToOrg, onExportToHtml, onOpenSettings }) {
  // Whether the toolbar/search/etc. actually fit is measured, not
  // guessed from viewport width — a long filename or a pile of tags
  // eats into the same space a phone-width media query would assume is
  // free. `probeRef` is a never-shown, never-constrained clone of the
  // fully-expanded header; comparing its natural width against the real
  // header's available width tells us whether to collapse, and a
  // ResizeObserver re-checks both whenever either one's size changes
  // (window resize, filename edited, tag added, etc.) — no fixed
  // breakpoint anywhere.
  const [collapsed, setCollapsed] = useState(false);
  const [openHamburgerSection, setOpenHamburgerSection] = useState(null);
  const headerRef = useRef(null);
  const probeRef = useRef(null);
  const headerRightRef = useRef(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const probe = probeRef.current;
    if (!header || !probe || typeof ResizeObserver === "undefined") return;
    // header.clientWidth is inflated by 64px from the tinted-header bleed
    // margins, so compare probe width against the parent's (true) content width.
    // Small buffer pre-emptively collapses just before the toolbar would
    // actually overflow, without giving up the extra ~1300px+ of screen
    // width a 100px buffer used to sacrifice.
    const check = () => {
      const parentW = header.parentElement.clientWidth;
      setCollapsed(probe.scrollWidth + 24 > parentW);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(header);
    ro.observe(probe);
    // Also watch header-right: its button count changes when a file is opened,
    // altering available space without a probe width change.
    if (headerRightRef.current) ro.observe(headerRightRef.current);
    return () => ro.disconnect();
  }, []);

  function renderInner(expanded) {
    const showFull = expanded || !collapsed;
    return html`
      ${currentFile && html`
        <div className="header-left-icons">
          <button className=${"panel-toggle-btn" + (sidebarVisible ? " active" : "")}
                  onClick=${onToggleSidebar}
                  title="Toggle sidebar"><${IconSidebar} /></button>
        </div>
      `}
      <div className="header-left">
        <h1>Epicorg</h1>
        ${currentFile && html`
          <button className="file-back-btn" onClick=${onBack} title=${currentFile}>
            ${pathBasename(currentFile)}
          </button>
        `}
      </div>
      ${currentFile && !showFull && html`
        <div className="header-collapsed-nav">
          ${canGoBack && html`
            <button className="view-tab" onClick=${onGoBack} title="Go back (Alt+←)"><${IconNavBack} /></button>
          `}
        </div>
      `}
      ${currentFile && showFull && html`
        <div className="toolbar-and-search">
        <div className="toolbar">
          ${toolbarConfig.home && html`
            <div className="view-toggle">
              <button className=${"view-tab" + (homeFile && currentFile === homeFile ? " active" : "") + (!homeFile ? " toolbar-home-unset" : "")}
                      onClick=${() => homeFile ? onGoHome() : onOpenSettings?.("workspace")}
                      title=${homeFile ? "Go home: " + homeFile : "No home file set — click to configure"}><${IconHome} /></button>
            </div>
          `}
          ${toolbarConfig.navArrows && html`
            <div className="view-toggle">
              <button className="view-tab" onClick=${onGoBack} disabled=${!canGoBack}
                      title="Go back (Alt+←)"><${IconNavBack} /></button>
              <button className="view-tab" onClick=${onGoForward} disabled=${!canGoForward}
                      title="Go forward (Alt+→)"><${IconNavForward} /></button>
            </div>
          `}
          ${view === "outline" && toolbarConfig.foldLevels && html`
            <div className="view-toggle">
              ${FOLD_LEVELS.map((lvl) => html`
                <button key=${lvl} className="view-tab"
                        disabled=${textMode}
                        onClick=${() => onFoldToLevel(lvl)}
                        title=${textMode ? "Not available in reveal codes mode" : "Fold to level " + lvl + " (Alt+" + lvl + ")"}>${lvl}</button>
              `)}
              <button className="view-tab"
                      disabled=${textMode}
                      onClick=${() => onFoldToLevel(9)}
                      title=${textMode ? "Not available in reveal codes mode" : "Expand all levels (Alt+9)"}>∞</button>
            </div>
          `}
          ${view === "outline" && toolbarConfig.moveGroup && html`
            <div className="view-toggle">
              <button className="view-tab"
                      onClick=${onShowOutlineActions}
                      disabled=${textMode}
                      title=${textMode ? "Not available in reveal codes mode" : "Outline move — indent, promote, move up/down"}>
                <${IconMoveNode} />
              </button>
              <button className=${"view-tab" + (notesVisible && !textMode ? " active" : "")}
                      disabled=${textMode}
                      onClick=${onToggleNotesVisible}
                      title=${textMode ? "Not available in reveal codes mode" : notesVisible ? "Hide body text and images" : "Show body text and images under each heading"}><${IconNotes} /></button>
              <button className=${"view-tab" + (isHoisted ? " active" : "")}
                      onClick=${onToggleHoist} disabled=${!canToggleHoist || textMode}
                      title=${textMode ? "Not available in reveal codes mode" : isHoisted ? "Show full outline again" : "Hoist — isolate the focused item and its children"}>
                ${isHoisted ? html`<${IconHoistOn} />` : html`<${IconHoistOff} />`}
              </button>
            </div>
          `}
          ${toolbarConfig.undoRedo && html`
            <div className="view-toggle">
              <button className="view-tab" onClick=${onUndo} disabled=${!canUndo || textMode}
                      title=${textMode ? "Not available in text mode" : "Undo (Ctrl+Z)"}><${IconUndo} /></button>
              <button className="view-tab" onClick=${onRedo} disabled=${!canRedo || textMode}
                      title=${textMode ? "Not available in text mode" : "Redo (Ctrl+Shift+Z)"}><${IconRedo} /></button>
            </div>
          `}
          ${toolbarConfig.viewTabs && html`
            <div className="view-toggle">
              <button className=${"view-tab" + (view === "outline" ? " active" : "")}
                      onClick=${() => setView("outline")} title="Outline view"><${IconOutline} /></button>
              <button className=${"view-tab" + (view === "agenda" ? " active" : "")}
                      onClick=${() => setView("agenda")} title="Agenda view"><${IconAgenda} /></button>
              <button className=${"view-tab" + (view === "todo" ? " active" : "")}
                      onClick=${() => setView("todo")} title="TODO list"><${IconTodo} /></button>
              <button className=${"view-tab" + (view === "journal" ? " active" : "")}
                      onClick=${() => setView("journal")} title="Daily journal"><${IconJournal} /></button>
            </div>
          `}
          ${view === "outline" && toolbarConfig.modeToggle && html`
            <div className="view-toggle">
              <button className=${"view-tab" + (titleFormatMode || textMode ? " active" : "")}
                      onClick=${onCycleViewMode}
                      title=${textMode
                        ? "Reveal codes — click to return to plain mode"
                        : titleFormatMode
                          ? "Formatted titles — click for reveal codes"
                          : "Plain mode — click for formatted titles"}>
                <${IconModeReveal} />
              </button>
            </div>
            ${textModeError && html`<span className="text-mode-error" title="Couldn't switch modes — see console">Error</span>`}
          `}
        </div>
        <div className="view-toggle" style=${{ opacity: textMode ? 0.4 : 1, pointerEvents: textMode ? "none" : "auto" }}>
          <button className=${"view-tab" + (searchPanelOpen ? " active" : "")}
                  title=${searchPanelOpen ? "Close search panel" : "Search panel — filter, find, search all files"}
                  onClick=${onOpenSearchPanel}>
            <${IconSearchPanel} />
          </button>
        </div>
        <div className=${"search-box" + ((filterExpanded || searchQuery) ? " search-box-expanded" : "")} style=${{ opacity: textMode ? 0.4 : 1, pointerEvents: textMode ? "none" : "auto" }}>
          ${(filterExpanded || searchQuery) ? html`
            <input
              ref=${expanded ? null : searchInputRef}
              type="text"
              className="search-input"
              placeholder="Filter… (Ctrl+K)"
              autoFocus=${!expanded}
              value=${searchQuery || ""}
              onChange=${(e) => setSearchQuery(e.target.value)}
              onBlur=${() => { if (!searchQuery) setFilterExpanded(false); }}
              onKeyDown=${(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSearchQuery("");
                  setFilterExpanded(false);
                  e.target.blur();
                }
              }}
            />
            ${searchQuery && html`
              <button className="search-clear"
                      onClick=${() => { setSearchQuery(""); setFilterExpanded(false); }}
                      title="Clear (Esc)">×</button>
            `}
          ` : html`
            <div className="view-toggle">
              <button className="view-tab" title="Filter this note (Ctrl+K)"
                      onClick=${() => setFilterExpanded(true)}>
                <${IconFilter} />
              </button>
            </div>
          `}
        </div>
        </div>
      `}
      <div className="header-right" ref=${headerRightRef}>
        ${currentFile && html`
          <div className="header-sync-status">
            <${SyncIndicator} status=${syncStatus}
              filePath=${currentFile.startsWith("/") ? currentFile : (homeDir ? homeDir + "/" + currentFile : currentFile)} />
          </div>
        `}
        <${HamburgerMenu} onOpenSettings=${onOpenSettings} />
        <button className="panel-toggle-btn" onClick=${onHelp} title="Command palette — search and run any command (Ctrl+H)"><${IconCommandPalette} /></button>
        ${currentFile && html`
          <button className=${"panel-toggle-btn" + (tagPanelVisible && !textMode ? " active" : "") + (selectedTags.length > 0 ? " has-filter" : "")}
                  onClick=${onToggleTagPanel} disabled=${textMode}
                  title="Toggle tag panel">
            <${IconTag} />
            ${selectedTags.length > 0 && html`<span className="tag-filter-count">${selectedTags.length}</span>`}
          </button>
          <button className=${"panel-toggle-btn" + (detailVisible ? " active" : "")}
                  onClick=${onToggleDetails}
                  title="Toggle details pane"><${IconDetails} /></button>
        `}
      </div>
    `;
  }

  const headerBg = resolveTopBarColor(topBarColor);
  return html`
    <header ref=${headerRef}
            className=${topBarColor ? "header-tinted" : ""}
            style=${headerBg ? { background: headerBg } : {}}>
      ${renderInner(false)}
    </header>
    <div className="header-probe" ref=${probeRef} aria-hidden="true">
      ${renderInner(true)}
    </div>
  `;
}

function buildCommands(ctx) {
  const {
    undo, redo, canUndo, canRedo,
    goBack, goForward, canGoBack, canGoForward,
    toggleTheme, toggleTitleFormatMode, toggleTextMode, cycleViewMode,
    titleFormatMode, textMode,
    toggleNotesVisible, notesVisible,
    outlineFormat, setOutlineFormat, levelFormats, setLevelFormat, focusedDepth,
    toggleVerticalLines, verticalLines,
    toggleReadingWidth, readingWidth,
    toggleSidebar, sidebarVisible,
    toggleNavPanel, toggleHeaderCollapsed,
    toggleHoist, isHoisted,
    toggleTagPanel, tagPanelVisible,
    toggleBookmarkPanel, bookmarkPanelVisible,
    foldToLevel, expandAllWithNotes,
    setView, view,
    setShowPicker, setShowTextSearch, setShowFolderPicker, setShowHelp,
    insertFootnote, insertDateStamp,
    joinFocusedWithNext,
    exportToHtml, exportToOrg, exportToMarkdown, currentFile,
    copyAsFormatted, copyAsPlain,
    clearRecentFiles,
    setFindOpen, findInputRef,
    cleanUpSelectedText, splitAtCursorLocation,
  } = ctx;

  return [
    // Navigation
    { category: "Navigation", label: "Go Back",            desc: "Navigate to previous location",  keys: "Alt+←",         action: goBack,                     disabled: !canGoBack },
    { category: "Navigation", label: "Go Forward",         desc: "Navigate to next location",      keys: "Alt+→",         action: goForward,                  disabled: !canGoForward },
    { category: "Navigation", label: "Open File…",         desc: "Switch to a different file",     keys: "",              action: () => setShowPicker(true) },
    // View
    { category: "View", label: "Outline View",             desc: "Show the outline",               keys: "",              action: () => setView("outline") },
    { category: "View", label: "Agenda View",              desc: "Show scheduled items",           keys: "",              action: () => setView("agenda") },
    { category: "View", label: "TODO View",                desc: "Show all TODO items",            keys: "",              action: () => setView("todo") },
    { category: "View", label: "Toggle Sidebar",           desc: "Show/hide the file sidebar",     keys: "",              action: toggleSidebar },
    { category: "View", label: "Toggle Navigation Panel",  desc: "Show/hide the heading-only navigation panel", keys: "", action: toggleNavPanel },
    { category: "View", label: "Collapse Top Bar",         desc: "Shrink the top bar down to a small corner tab (click the tab to restore it)", keys: "", action: toggleHeaderCollapsed },
    { category: "View", label: "Toggle Tag Panel",         desc: "Show/hide the tag panel",        keys: "",              action: toggleTagPanel },
    { category: "View", label: "Toggle Bookmark Panel",    desc: "Show/hide bookmarks",            keys: "",              action: toggleBookmarkPanel },
    { category: "View", label: "Toggle Detail Panel",      desc: "Show/hide the detail pane",      keys: "",              action: () => {} }, // wired below
    { category: "View", label: "Toggle Notes",             desc: notesVisible ? "Hide inline notes" : "Show inline notes", keys: "", action: toggleNotesVisible },
    { category: "View", label: "Toggle Reading Width",     desc: readingWidth ? "Full width" : "Comfortable reading width", keys: "", action: toggleReadingWidth },
    { category: "View", label: "Toggle Vertical Lines",    desc: verticalLines ? "Hide indent guides" : "Show indent guides", keys: "", action: toggleVerticalLines },
    { category: "View", label: "Global: Bullets",           desc: "Set all outline levels to bullet style (globally)",          keys: "", action: () => setOutlineFormat("bullets") },
    { category: "View", label: "Global: Numbers",           desc: "Set all outline levels to numbered style (globally)",         keys: "", action: () => setOutlineFormat("numbers") },
    { category: "View", label: "Global: Letters (a b c…)", desc: "Set all outline levels to lowercase letters (globally)",      keys: "", action: () => setOutlineFormat("letters") },
    { category: "View", label: "Global: Letters (A B C…)", desc: "Set all outline levels to uppercase letters (globally)",      keys: "", action: () => setOutlineFormat("upper") },
    { category: "View", label: `Level ${focusedDepth + 1}: Set to Bullets`,          desc: "Set all headings at this depth to bullet style (overrides global)",           keys: "", action: () => setLevelFormat(focusedDepth, "bullets"),  disabled: focusedDepth < 0 },
    { category: "View", label: `Level ${focusedDepth + 1}: Set to Numbers`,          desc: "Set all headings at this depth to numbered style (overrides global)",          keys: "", action: () => setLevelFormat(focusedDepth, "numbers"),  disabled: focusedDepth < 0 },
    { category: "View", label: `Level ${focusedDepth + 1}: Set to Letters (a b c…)`, desc: "Set all headings at this depth to lowercase letters (overrides global)",      keys: "", action: () => setLevelFormat(focusedDepth, "letters"),  disabled: focusedDepth < 0 },
    { category: "View", label: `Level ${focusedDepth + 1}: Set to Letters (A B C…)`, desc: "Set all headings at this depth to uppercase letters (overrides global)",      keys: "", action: () => setLevelFormat(focusedDepth, "upper"),    disabled: focusedDepth < 0 },
    { category: "View", label: `Level ${focusedDepth + 1}: Reset to global`,         desc: "Remove per-level override; this depth falls back to global style",            keys: "", action: () => setLevelFormat(focusedDepth, null),       disabled: focusedDepth < 0 || !levelFormats?.[focusedDepth] },
    // Fold
    { category: "Folding", label: "Fold to Level 1",      desc: "Collapse all but top level",     keys: "Alt+1",         action: () => foldToLevel(1) },
    { category: "Folding", label: "Fold to Level 2",      desc: "Expand to level 2",              keys: "Alt+2",         action: () => foldToLevel(2) },
    { category: "Folding", label: "Fold to Level 3",      desc: "Expand to level 3",              keys: "Alt+3",         action: () => foldToLevel(3) },
    { category: "Folding", label: "Fold to Level 4",      desc: "Expand to level 4",              keys: "Alt+4",         action: () => foldToLevel(4) },
    { category: "Folding", label: "Fold to Level 5",      desc: "Expand to level 5",              keys: "Alt+5",         action: () => foldToLevel(5) },
    { category: "Folding", label: "Fold to Level 6",      desc: "Expand to level 6",              keys: "Alt+6",         action: () => foldToLevel(6) },
    { category: "Folding", label: "Fold to Level 7",      desc: "Expand to level 7",              keys: "Alt+7",         action: () => foldToLevel(7) },
    { category: "Folding", label: "Fold to Level 8",      desc: "Expand to level 8",              keys: "Alt+8",         action: () => foldToLevel(8) },
    { category: "Folding", label: "Expand All",           desc: "Unfold everything",              keys: "Alt+9",         action: () => foldToLevel(9) },
    { category: "Folding", label: "Expand All + Notes",   desc: "Unfold every heading and show all inline notes", keys: "", action: expandAllWithNotes },
    // Edit
    { category: "Edit", label: "Undo",                    desc: "Undo last change",               keys: displayCombo(getShortcutCombo("undo")),            action: undo,      disabled: !canUndo },
    { category: "Edit", label: "Redo",                    desc: "Redo last undone change",        keys: displayCombo(getShortcutCombo("redo")),            action: redo,      disabled: !canRedo },
    { category: "Edit", label: "Bold selection",          desc: "Wrap selection in *bold*",       keys: displayCombo(getShortcutCombo("bold")),            action: () => applyMarkerToFocused("*") },
    { category: "Edit", label: "Italic selection",        desc: "Wrap selection in /italic/",     keys: displayCombo(getShortcutCombo("italic")),          action: () => applyMarkerToFocused("/") },
    { category: "Edit", label: "Underline selection",     desc: "Wrap selection in _underline_",  keys: displayCombo(getShortcutCombo("underline")),       action: () => applyMarkerToFocused("_") },
    { category: "Edit", label: "Strikethrough selection", desc: "Wrap selection in +strike+",     keys: displayCombo(getShortcutCombo("strikethrough")),   action: () => applyMarkerToFocused("+") },
    { category: "Edit", label: "Clean Up Pasted Text",    desc: "Remove extra spaces, leading indentation, and hard line breaks from the selected text (keeps paragraph breaks)", keys: "", action: cleanUpSelectedText },
    { category: "Edit", label: "Insert Footnote",         desc: "Add [fn:N] at cursor in notes",  keys: displayCombo(getShortcutCombo("insertFootnote")),  action: insertFootnote },
    { category: "Edit", label: "Insert Date Stamp",       desc: "Insert formatted date/time at cursor", keys: displayCombo(getShortcutCombo("insertDateStamp")), action: insertDateStamp },
    { category: "Edit", label: "Split At Cursor Location", desc: "Split the focused title into two sibling nodes, or the focused note into a new node's note directly after", keys: displayCombo(getShortcutCombo("splitNode")), action: splitAtCursorLocation },
    { category: "Edit", label: "Join with Next Node",     desc: "Merge this node with the next sibling",        keys: displayCombo(getShortcutCombo("joinNode")),   action: joinFocusedWithNext },
    { category: "Edit", label: "Hoist / Unhoist",         desc: isHoisted ? "Unhoist — show full tree" : "Hoist focused item", keys: displayCombo(getShortcutCombo("hoist")), action: toggleHoist },
    // Search
    { category: "Search", label: "Full-text Search…",    desc: "Search across all org files",    keys: displayCombo(getShortcutCombo("textSearch")),      action: () => setShowTextSearch(true) },
    { category: "Search", label: "Find and Replace…",    desc: "Find and replace text across the whole file", keys: "Ctrl+F", action: () => { setFindOpen(true); requestAnimationFrame(() => findInputRef.current?.focus()); } },
    // Settings
    { category: "Settings", label: "Toggle Dark/Light Theme", desc: "Switch colour theme",       keys: "",              action: toggleTheme },
    { category: "Settings", label: "Cycle View Mode",       desc: textMode ? "Reveal codes → Plain" : titleFormatMode ? "Formatted → Reveal codes" : "Plain → Formatted titles", keys: "", action: cycleViewMode },
    { category: "Settings", label: "Change Home Folder…",    desc: "Pick a new home org folder",  keys: "", action: () => setShowFolderPicker(true) },
    { category: "Settings", label: "Clear Recent File List", desc: "Remove all entries from the recent files list in the sidebar", keys: "", action: clearRecentFiles },
    // Export / Copy
    { category: "Export", label: "Export to Local Org File", desc: "Use this option to save a local copy of the current org file for backup or other use.", keys: "", action: exportToOrg,        disabled: !currentFile },
    { category: "Export", label: "Export to HTML",           desc: "Save standalone HTML file of this document",                                           keys: "", action: exportToHtml,       disabled: !currentFile },
    { category: "Export", label: "Export to Markdown",       desc: "Save as GitHub-flavoured Markdown (.md) file",                                         keys: "", action: exportToMarkdown,   disabled: !currentFile },
    { category: "Export", label: "Copy as Formatted Text",   desc: "Copy visible outline to clipboard with bold/italic/links preserved (paste into Word, email, etc.)", keys: displayCombo(getShortcutCombo("copyFormatted")), action: copyAsFormatted, disabled: !currentFile },
    { category: "Export", label: "Copy as Plain Text",       desc: "Copy visible outline to clipboard as clean text — no *markup* characters",                        keys: displayCombo(getShortcutCombo("copyPlain")),     action: copyAsPlain,      disabled: !currentFile },
    // Help
    { category: "Help", label: "Keyboard Shortcuts",      desc: "Show this command palette",      keys: displayCombo(getShortcutCombo("commandPalette")), action: () => setShowHelp(true) },
  ].filter((c) => !c.disabled);
}

const CP_RECENT_KEY = "epicorg.cp.recent";
const CP_RECENT_MAX = 5;

function cpLoadRecent() {
  try { return JSON.parse(localStorage.getItem(CP_RECENT_KEY)) || []; } catch { return []; }
}
function cpSaveRecent(labels) {
  try { localStorage.setItem(CP_RECENT_KEY, JSON.stringify(labels)); } catch {}
}

const CP_POS_KEY    = "epicorg.cp.pos";
const CP_SIZE_KEY   = "epicorg.cp.size";
const CP_PINNED_KEY = "epicorg.cp.pinned";

function CommandPalette({ commands, onClose }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [recentLabels, setRecentLabels] = useState(cpLoadRecent);
  const inputRef = useRef(null);
  const listRef  = useRef(null);
  const dialogRef = useRef(null);
  const dragState = useRef(null);

  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem(CP_PINNED_KEY) === "1"; } catch { return false; }
  });
  const togglePin = () => setPinned((p) => {
    const next = !p;
    try { localStorage.setItem(CP_PINNED_KEY, next ? "1" : "0"); } catch {}
    return next;
  });

  // Drag position \u2014 null = use CSS default (centered)
  const [pos, setPos] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CP_POS_KEY)) || null; } catch { return null; }
  });

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Drag-by-header
  const onHeaderMouseDown = (e) => {
    if (e.target.closest("input, button")) return;
    e.preventDefault();
    const dlg = dialogRef.current;
    if (!dlg) return;
    const rect = dlg.getBoundingClientRect();
    dragState.current = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    const onMove = (ev) => {
      const { startX, startY, origLeft, origTop } = dragState.current;
      const left = origLeft + ev.clientX - startX;
      const top  = origTop  + ev.clientY - startY;
      setPos({ left, top });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (dragState.current) {
        const dlg = dialogRef.current;
        if (dlg) {
          const r = dlg.getBoundingClientRect();
          const p = { left: r.left, top: r.top };
          try { localStorage.setItem(CP_POS_KEY, JSON.stringify(p)); } catch {}
        }
      }
      dragState.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const dialogStyle = pos
    ? { left: pos.left + "px", top: pos.top + "px", transform: "none" }
    : {};

  const isSearching = query.trim() !== "";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      c.desc.toLowerCase().includes(q) ||
      (c.category || "").toLowerCase().includes(q) ||
      (c.keys || "").toLowerCase().includes(q)
    );
  }, [query, commands]);

  const recentCmds = useMemo(() => {
    if (isSearching) return [];
    return recentLabels
      .map((label) => commands.find((c) => c.label === label))
      .filter(Boolean)
      .slice(0, CP_RECENT_MAX);
  }, [recentLabels, commands, isSearching]);

  const grouped = useMemo(() => {
    if (isSearching) return null;
    const recentSet = new Set(recentCmds.map((c) => c.label));
    const map = {};
    for (const c of commands) {
      if (recentSet.has(c.label)) continue;
      const cat = c.category || "Other";
      if (!map[cat]) map[cat] = [];
      map[cat].push(c);
    }
    for (const cat of Object.keys(map)) map[cat].sort((a, b) => a.label.localeCompare(b.label));
    return map;
  }, [commands, recentCmds, isSearching]);

  const flatList = useMemo(() => {
    if (isSearching) return filtered;
    const rest = grouped ? Object.values(grouped).flat() : [];
    return [...recentCmds, ...rest];
  }, [isSearching, filtered, recentCmds, grouped]);

  useEffect(() => { setHighlighted(0); }, [query]);

  useEffect(() => {
    const items = listRef.current?.querySelectorAll(".cp-item");
    items?.[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const run = (cmd) => {
    const next = [cmd.label, ...recentLabels.filter((l) => l !== cmd.label)].slice(0, CP_RECENT_MAX);
    setRecentLabels(next);
    cpSaveRecent(next);
    cmd.action();
    if (pinned) {
      // Stay open; refocus search for the next command
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      onClose();
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, flatList.length - 1)); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter")     { e.preventDefault(); if (flatList[highlighted]) run(flatList[highlighted]); }
  };

  const renderItem = (cmd, idx) => html`
    <div key=${cmd.label}
         className=${"cp-item" + (idx === highlighted ? " highlighted" : "")}
         onMouseEnter=${() => setHighlighted(idx)}
         onMouseDown=${(e) => { e.preventDefault(); run(cmd); }}>
      <div className="cp-item-left">
        <span className="cp-item-label">${cmd.label}</span>
        ${!isSearching
          ? html`<span className="cp-item-desc">${cmd.desc}</span>`
          : html`<span className="cp-item-desc">${cmd.category} \u00B7 ${cmd.desc}</span>`}
      </div>
      ${cmd.keys && html`<span className="cp-item-keys">${cmd.keys}</span>`}
    </div>
  `;

  return html`
    <div className="cp-dialog ${pos ? "dragging" : ""}"
         ref=${dialogRef}
         style=${dialogStyle}>
      <div className="cp-input-row" onMouseDown=${onHeaderMouseDown}>
        <svg className="cp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input ref=${inputRef} className="cp-input" type="text"
               placeholder="Search commands\u2026"
               value=${query} onInput=${(e) => setQuery(e.target.value)}
               onKeyDown=${onKeyDown} />
        <button className=${"pin-btn" + (pinned ? " pinned" : "")}
                onClick=${togglePin}
                title=${pinned ? "Pinned \u2014 stays open after running a command (click to unpin)" : "Pin \u2014 keep open after running a command"}>
          <${IconPin} />
        </button>
        <button className="cp-close" onClick=${onClose}>\u00D7</button>
      </div>
      <div ref=${listRef} className="cp-list">
        ${flatList.length === 0 && html`
          <div className="cp-empty">No commands match "${query}"</div>
        `}
        ${isSearching
          ? filtered.map((cmd, idx) => renderItem(cmd, idx))
          : html`
              ${recentCmds.length > 0 && html`
                <div className="cp-group">
                  <div className="cp-group-label">Recent</div>
                  ${recentCmds.map((cmd) => renderItem(cmd, flatList.indexOf(cmd)))}
                </div>
              `}
              ${Object.entries(grouped).map(([cat, cmds]) => html`
                <div key=${cat} className="cp-group">
                  <div className="cp-group-label">${cat}</div>
                  ${cmds.map((cmd) => renderItem(cmd, flatList.indexOf(cmd)))}
                </div>
              `)}
            `
        }
      </div>
      <div className="cp-footer">
        <span>\u2191\u2193 navigate</span><span>\u21B5 run</span><span>Esc close</span>
      </div>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
