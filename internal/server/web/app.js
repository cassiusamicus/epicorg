import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useReducer, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import * as tree from "./tree.js";
import { generateExportHtml } from "./export.js";

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

// Fire a custom event so the App can show the file-link picker without
// prop-drilling a callback through the entire OutlineNode tree.
function triggerLinkPicker(textarea, e) {
  // Don't trigger while deleting — only on insertion.
  const inputType = e?.nativeEvent?.inputType ?? "";
  if (inputType.startsWith("delete")) return;
  const pos = textarea.selectionStart;
  if (!textarea.value.substring(0, pos).endsWith("[[")) return;
  document.body.dispatchEvent(new CustomEvent("epicLinkTrigger", {
    detail: { textarea, cursorPos: pos },
  }));
}

// Notes/body text under a bullet — shown only when non-empty or actively
// being edited, so empty items don't clutter the outline. Mirrors the
// title's formatted-preview/edit-textarea split, governed by the same
// titleFormatMode toggle.
function NodeBody({ node, dispatch, isEditing, isPreview, titleFormatMode, notesVisible, depth, bodyRefs }) {
  const localRef = useRef(null);

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
               onClick=${() => dispatch(node.id, "edit-body")}
               dangerouslySetInnerHTML=${{ __html: tree.renderOrgInline(node.body) }} />
        `
        : html`
          <textarea
            rows=${1}
            ref=${(el) => {
              localRef.current = el;
              if (el) { bodyRefs.current[node.id] = el; adjustTextareaHeight(el); }
            }}
            className="node-body-textarea"
            value=${node.body || ""}
            placeholder="Add notes..."
            onChange=${(e) => { dispatch(node.id, "change-body", tree.orgifyPaths(e.target.value)); triggerLinkPicker(e.target, e); }}
            onBlur=${() => {
              dispatch(node.id, "stop-edit-body");
              // If the blur was caused by tab-switching (not clicking elsewhere in
              // the page), keep the note visible in preview mode so it survives the
              // round-trip and the user can resume editing when they return.
              if (!document.hasFocus()) dispatch(node.id, "preview-body");
            }}
            onKeyDown=${(e) => {
              const marker = formatMarkerForKey(e);
              if (marker) { e.preventDefault(); wrapSelectionWithMarker(e, marker, (v) => dispatch(node.id, "change-body", v)); return; }
              if (e.key === "Escape") { e.preventDefault(); dispatch(node.id, "focus-outline"); }
            }}
          />
          <button className="body-fn-btn" title="Insert footnote reference [fn:N]"
                  onMouseDown=${(e) => { e.preventDefault(); localRef.current?.focus(); triggerInsertFootnote(); }}>fn</button>
        `}
    </div>
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

function OutlineNode({ node, focusedId, dispatch, inputRefs, depth, titleFormatMode, notesVisible, outlineFormat, levelFormats, siblingIndex, verticalLines, showTagChips, tagsOnRight, onSearchTag, bodyEditingId, bodyPreviewId, bodyRefs }) {
  const isFocused = focusedId === node.id;
  const hasChildren = node.children?.length > 0;
  const bulletFmt = (levelFormats && levelFormats[depth]) || outlineFormat || "bullets";
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
        <span className=${"bullet" + (hasChildren ? (node.collapsed ? " has-children collapsed" : " has-children expanded") : "") + (isIndexed ? " numbered" : "")}
              onMouseDown=${(e) => {
                e.preventDefault();
                if (hasChildren) dispatch(node.id, "toggle");
                else { pendingEditRef.current = true; dispatch(node.id, "edit-title"); }
              }}>
          ${isIndexed && html`<span className="bullet-caret">${hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : ""}</span>`}
          ${isIndexed && html`<span className="bullet-number">${bulletLabel}</span>`}
          ${!isIndexed && (hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : html`<span className="bullet-dot" />`)}
        </span>
        ${showFormatted
          ? html`
            <div className=${"node-title node-title-preview" + (node.status === "DONE" || node.status === "CANCELLED" ? " done" : "")}
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
              style=${showOverlay ? {position:"absolute",left:"-9999px",opacity:0,pointerEvents:"none",width:"1px",height:"1px",padding:0,border:0,overflow:"hidden",margin:0} : {}}
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

function TodoView({ nodes, onSelect, searchQuery, selectedTags }) {
  const [sortBy, setSortBy] = useState("priority");
  const [statusFilter, setStatusFilter] = useState(new Set());
  const [priorityFilter, setPriorityFilter] = useState(new Set());

  const toggleStatus = (s) => setStatusFilter((prev) => {
    const next = new Set(prev); next.has(s) ? next.delete(s) : next.add(s); return next;
  });
  const togglePriority = (p) => setPriorityFilter((prev) => {
    const next = new Set(prev); next.has(p) ? next.delete(p) : next.add(p); return next;
  });
  const clearAll = () => { setStatusFilter(new Set()); setPriorityFilter(new Set()); };

  const isFiltering = !!searchQuery || (selectedTags && selectedTags.length > 0) || statusFilter.size > 0 || priorityFilter.size > 0;
  let items = collectTodoItems(nodes);
  if (searchQuery) items = items.filter((item) => tree.matchesQuery(searchQuery, item.title));
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

  return html`
    <div className="agenda-view todo-view">
      <div className="todo-sort-bar">
        <span className="todo-sort-label">Sort:</span>
        ${TODO_SORT_OPTIONS.map((opt) => html`
          <button key=${opt.key}
                  className=${"todo-sort-btn" + (sortBy === opt.key ? " active" : "")}
                  onClick=${() => setSortBy(opt.key)}>${opt.label}</button>
        `)}
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
        <div className="agenda-empty">${isFiltering ? "No matches" : "No TODO items in this file"}</div>
      ` : items.map((item) => html`
        <div className="todo-item" key=${item.id} onClick=${() => onSelect(item.id)}>
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
          ${item.ancestors.length > 0 && html`
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
    ` : filtered.map((r, i) => html`
      <div key=${i}
           className=${"tag-search-result" + (r.inSubdir ? " tag-search-result-subdir" : "")}
           onClick=${r.inSubdir ? undefined : () => onNavigate(r)}>
        <div className="tag-search-result-file">
          ${r.file}
          ${r.inSubdir && html`<span className="tag-search-result-subdir-badge" title="In subdirectory — open manually">subfolder</span>`}
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
    `)}
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

  if (searchQuery) items = items.filter((item) =>
    tree.matchesQuery(searchQuery, item.title) ||
    (item.ancestors || []).some((a) => tree.matchesQuery(searchQuery, a))
  );
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

  const agendaDatePickerRef = useRef(null);
  const openAgendaDatePicker = useCallback(() => {
    const el = agendaDatePickerRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.click(); }
  }, []);

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
  const dateMatches = !searchQuery || tree.matchesQuery(searchQuery, dateStr) || tree.matchesQuery(searchQuery, dateDisplay);
  const allNodes = content && content.nodes ? content.nodes : [];
  const matchingNodes = searchQuery
    ? allNodes.filter((n) => tree.matchesQuery(searchQuery, n.title))
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

function AppointmentDialog({ defaultDate, onConfirm, onCancel }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate || todayDateStr());
  const [time, setTime] = useState("09:00");
  const titleRef = useRef(null);
  const dateInputRef = useRef(null);
  const timeInputRef = useRef(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const submit = useCallback(() => {
    if (!title.trim()) return;
    onConfirm({ title: title.trim(), date, time });
  }, [title, date, time, onConfirm]);

  const openDatePicker = useCallback(() => {
    const el = dateInputRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.click(); }
  }, []);

  const openTimePicker = useCallback(() => {
    const el = timeInputRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.click(); }
  }, []);

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
          <div className="appt-input-row">
            <input ref=${dateInputRef} type="date" className="appt-input appt-datetime"
                   value=${date} onChange=${(e) => setDate(e.target.value)} />
            <button className="appt-picker-btn" onClick=${openDatePicker} title="Open calendar">
              <${IconAgenda} />
            </button>
          </div>
        </div>
        <div className="appt-field">
          <label className="appt-label">Time</label>
          <div className="appt-input-row">
            <input ref=${timeInputRef} type="time" className="appt-input appt-datetime" step="900"
                   value=${time} onChange=${(e) => setTime(e.target.value)} />
            <button className="appt-picker-btn" onClick=${openTimePicker} title="Open time picker">
              <${IconClock} />
            </button>
          </div>
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
  { id: "splitNode",       cat: "Outline",    label: "Split Node at Cursor",  def: "Ctrl+Shift+S" },
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
let _lastOutlineTextarea = null;
export function _setLastOutlineTextarea(el) { _lastOutlineTextarea = el; }

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
  if (key === "Enter")     { e.preventDefault(); dispatch(id, "new-sibling"); return; }
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
  [SYNC_SAVED]:    "Saved \u2014 gray dot: up to date",
  [SYNC_DIRTY]:    "Unsaved changes \u2014 yellow hollow dot: pending save",
  [SYNC_SAVING]:   "Saving\u2026 \u2014 gray dot: save in progress",
  [SYNC_ERROR]:    "Save failed \u2014 red dot: network or server error",
  [SYNC_CONFLICT]: "Merge conflict \u2014 red dot: resolve conflict markers in file",
  [SYNC_MERGED]:   "Merged external edits \u2014 blue dot: external edit was merged in",
  [SYNC_RELOADED]: "Reloaded \u2014 blue dot: file changed on disk and was reloaded",
  [SYNC_COPIED]:   "Copied to clipboard",
};

function Toast({ message }) {
  if (!message) return null;
  return html`<div className="toast">${message}</div>`;
}

function SyncIndicator({ status }) {
  const label = SYNC_LABELS[status] || "";
  // A fixed-size dot instead of text, so the header doesn't shift width as
  // the status changes. Unsaved is the one truly "pending" state, so it's
  // hollow; every settled state (including errors) is filled.
  const filled = status !== SYNC_DIRTY;
  return html`
    <span className=${"sync-indicator sync-" + status} title=${label} aria-label=${label}>
      <span className=${"sync-dot" + (filled ? " sync-dot-filled" : "")} />
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

  const sorted = [...files].sort((a, b) => {
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
        <h2>${atWorkspace ? "Choose a file" : html`<span className="fp-nav-path-title" title=${navPath}>${navPath}</span>`}</h2>
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

function Sidebar({ favorites, recentFiles, currentFile, onSelect, onToggleFavorite, bookmarks, onNavigateToBookmark, onDeleteBookmark, onReorderBookmarks, bookmarkPanelVisible, onToggleBookmarkPanel, textMode, onToggleSidebar, onOpenTodayJournal, onOpenJournalList, onRenameFile, onClearRecentFiles }) {
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
  "set-status", "set-priority", "cycle-status", "new-sibling", "delete", "indent", "outdent", "move-up", "move-down",
  "indent-only", "outdent-only", "move-up-only", "move-down-only",
  "split-at-cursor", "join-with-next",
]);
// Of those, typing actions get debounced into one undo step per "burst"
// rather than one per keystroke.
const COALESCE_UNDO_ACTIONS = new Set(["change", "change-body", "change-preamble"]);
const UNDO_COALESCE_MS = 800;

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
    try { return localStorage.getItem("epicorg.sidebarVisible") !== "0"; } catch { return true; }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarVisible((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.sidebarVisible", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [currentFile, setCurrentFile] = useState(null);
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
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showJournalFolderPicker, setShowJournalFolderPicker] = useState(false);
  const [showTagListFilePicker, setShowTagListFilePicker] = useState(false);
  const [showBookmarkListFilePicker, setShowBookmarkListFilePicker] = useState(false);
  const [showTextSearch, setShowTextSearch] = useState(false);
  // Unified search results: { type: "tag"|"text", query, results } | null
  const [searchResults, setSearchResults] = useState(null);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const linkPickerTargetRef = useRef(null); // { textarea, cursorPos }
  const [navState, navDispatch] = useReducer(navReducer, { history: [], index: -1 });
  const histNavRef = useRef(false); // true while back/forward is in progress (suppresses push)
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const [selectedTags, setSelectedTags] = useState([]);
  const toggleTag = useCallback((tag) => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  }, []);
  const clearTags = useCallback(() => setSelectedTags([]), []);
  const [titleFormatMode, setTitleFormatMode] = useState(() => {
    try { return localStorage.getItem("epicorg.titleFormatMode") === "1"; } catch { return false; }
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
    try { return localStorage.getItem("epicorg.readingWidth") === "1"; } catch { return false; }
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

    // Paste a bare file path or URL → auto-wrap as an org link.
    // Only fires when the active element is a textarea (node title or body).
    const onPaste = (e) => {
      const ta = document.activeElement;
      if (!ta || ta.tagName !== "TEXTAREA") return;
      const text = (e.clipboardData || window.clipboardData).getData("text/plain").trim();
      let link;
      if (/^\/[^\s]+$/.test(text)) {
        // Absolute file path → [[file:path][filename]]
        const name = text.split("/").filter(Boolean).pop() || text;
        link = `[[file:${text}][${name}]]`;
      } else if (/^https?:\/\/\S+$/.test(text)) {
        // HTTP/HTTPS URL → [[url][hostname]]
        let name = text;
        try { name = new URL(text).hostname.replace(/^www\./, ""); } catch {}
        link = `[[${text}][${name}]]`;
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
    try { return localStorage.getItem("epicorg.topBarColor") || null; } catch { return null; }
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
    try { return localStorage.getItem("epicorg.tagPanelVisible") === "1"; } catch { return false; }
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
        const el = searchInputRef.current;
        if (el) { el.focus(); el.select(); }
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

  const runTextSearch = useCallback(async (query) => {
    setShowTextSearch(false);
    setSearchResults({ type: "text", query, results: null });
    setView("search");
    try {
      const data = await api.get("/api/search/text?q=" + encodeURIComponent(query));
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
      if (lastFile && (lastFile.startsWith("/") || f.some((file) => file.name === lastFile))) loadFile(lastFile);
      else if (data.default && f.some((file) => file.name === data.default)) loadFile(data.default);
      else if (f.length === 1) loadFile(f[0].name);
    });
  }, []);

  // Fetch and track home directory.
  useEffect(() => {
    api.get("/api/homedir").then((d) => setHomeDir(d.dir)).catch(() => {});
    api.get("/api/journaldir").then((d) => setJournalDir(d.dir)).catch(() => {});
    api.get("/api/taglistfile").then((d) => setTagListFile(d.file)).catch(() => {});
    api.get("/api/bookmarklistfile").then((d) => setBookmarkListFile(d.file)).catch(() => {});
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

  const confirmAddAppointment = useCallback(async ({ title, date, time }) => {
    setApptDialog(null);
    try {
      const d = await api.post("/api/journal", { date });
      await loadFile(d.filename);
      setView("outline");
      const nn = tree.newNode(title);
      nn.status = "TODO";
      const dayAbbr = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
      nn.body = `SCHEDULED: <${date} ${dayAbbr}${time ? " " + time : ""}>`;
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
  useEffect(() => {
    const onFocusIn = (e) => {
      if (e.target.tagName === "TEXTAREA" && e.target.closest(".node-row, .preamble-row")) {
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

    if (action === "delete") {
      const prevId = idx > 1 ? flat[idx - 1].id : (flat.length > 2 ? flat[2]?.id : null);
      setNodes((p) => tree.removeNode(p, nodeId));
      if (prevId && prevId !== "preamble") focusNode(prevId);
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
  }, [focusNode, markDirty, maybeSnapshotForUndo]);

  const splitFocusedNode = useCallback(() => {
    const id = focusedIdRef.current;
    if (!id || id === "preamble") return;
    const el = inputRefs.current[id];
    const pos = el ? el.selectionStart : 0;
    dispatch(id, "split-at-cursor", pos);
  }, [dispatch]);

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

  // Multi-node delete: drag-select across rows and press Delete/Backspace.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const rows = [...document.querySelectorAll(".node-row[data-node-id]")];
      const selected = rows.filter((r) => range.intersectsNode(r));
      if (selected.length < 2) return;
      e.preventDefault();
      sel.removeAllRanges();
      [...selected].reverse().forEach((r) => { if (r.dataset.nodeId) dispatch(r.dataset.nodeId, "delete"); });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const focusedDepth = useMemo(() => {
    if (!focusedId || focusedId === "preamble" || !nodes) return -1;
    const search = (arr, id, d) => { for (const n of (arr || [])) { if (n.id === id) return d; const r = search(n.children, id, d + 1); if (r >= 0) return r; } return -1; };
    return search(nodes, focusedId, 0);
  }, [focusedId, nodes]);

  // Loading state
  if (files === null) return html`<div className="empty">Loading...</div>`;

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
      <${Header} onHelp=${() => setShowHelp(true)} syncStatus=${syncStatus}
                  view=${view} setView=${setView} currentFile=${currentFile}
                  searchQuery=${searchQuery} setSearchQuery=${setSearchQuery}
                  searchInputRef=${searchInputRef}
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
                  onExportToOrg=${exportToOrg}
                  onExportToHtml=${exportToHtml} />
      ${showOutlineActions && html`
        <${OutlineActionsPanel}
          focusedId=${focusedId}
          onAction=${outlineAction}
          onClose=${() => setShowOutlineActions(false)} />`}
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
          toggleHoist, isHoisted,
          toggleTagPanel, tagPanelVisible,
          toggleBookmarkPanel, bookmarkPanelVisible,
          foldToLevel,
          setView, view,
          setShowPicker, setShowTextSearch, setShowFolderPicker,
          setShowHelp, insertFootnote, insertDateStamp,
          splitFocusedNode, joinFocusedWithNext,
                exportToHtml, exportToOrg, currentFile,
          copyAsFormatted, copyAsPlain,
          clearRecentFiles,
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
      ${showLinkPicker && html`
        <${FileLinkPicker}
          files=${files}
          onSelect=${insertFileLink}
          onCreate=${createFileForLink}
          onCancel=${() => setShowLinkPicker(false)} />
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
            onClearRecentFiles=${clearRecentFiles} />
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
                  bodyEditingId=${bodyEditingId} bodyPreviewId=${bodyPreviewId} bodyRefs=${bodyRefs} />
              `)}
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
              <${TodoView} nodes=${nodes} onSelect=${handleAgendaSelect} searchQuery=${searchQuery} selectedTags=${selectedTags} />
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
          onOpenSettings=${() => setShowWorkspaceSettings(true)} />
      `}
      ${showWorkspaceSettings && html`
        <${WorkspaceSettingsPanel}
          homeDir=${homeDir} homeFile=${homeFile} journalDir=${journalDir}
          tagListFile=${tagListFile} bookmarkListFile=${bookmarkListFile} currentFile=${currentFile}
          statusBarVisible=${statusBarVisible} onToggleStatusBar=${toggleStatusBarVisible}
          onChangeHomeDir=${() => { setShowWorkspaceSettings(false); setShowFolderPicker(true); }}
          onChangeJournalDir=${() => { setShowWorkspaceSettings(false); setShowJournalFolderPicker(true); }}
          onClearJournalDir=${() => { setShowWorkspaceSettings(false); clearJournalDir(); }}
          onChangeTagListFile=${() => { setShowWorkspaceSettings(false); setShowTagListFilePicker(true); }}
          onClearTagListFile=${() => { setShowWorkspaceSettings(false); clearTagListFile(); }}
          onChangeBookmarkListFile=${() => { setShowWorkspaceSettings(false); setShowBookmarkListFilePicker(true); }}
          onClearBookmarkListFile=${() => { setShowWorkspaceSettings(false); clearBookmarkListFile(); }}
          onSetHomeFile=${setHomeFilePersisted}
          onClose=${() => setShowWorkspaceSettings(false)} />
      `}
    </div>
    ${fnPopup && html`<${FootnotePopup} popup=${fnPopup} onClose=${() => setFnPopup(null)} onSave=${saveFootnoteDef} />`}
    ${fnInsertPopup && html`<${FootnoteInsertPopup} popup=${fnInsertPopup} onInsert=${confirmInsertFootnote} onClose=${() => setFnInsertPopup(null)} />`}
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

function IconClock() {
  return html`
    <svg ...${ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14.5" />
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
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    const q = query.trim();
    if (q) onSearch(q);
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

// --- Shortcut Editor popup ---

function ShortcutEditor({ shortcutVer, onUpdate, onReset, onResetAll, onClose }) {
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

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !recordingId) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [recordingId, onClose]);

  const cats = [...new Set(SHORTCUT_DEFS.map((d) => d.cat))];

  return html`
    <div className="shortcut-editor-overlay"
         onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shortcut-editor">
        <div className="shortcut-editor-hdr">
          <span className="shortcut-editor-title">Keyboard Shortcuts</span>
          <button className="shortcut-editor-close" onClick=${onClose}>×</button>
        </div>
        <div className="shortcut-editor-body">
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
                    <button
                      className=${"shortcut-combo-btn" + (isRecording ? " recording" : "") + (custom ? " custom" : "")}
                      disabled=${!!d.fixed}
                      onClick=${!d.fixed ? () => setRecordingId(d.id) : undefined}
                    >
                      ${isRecording ? "Press keys…" : displayCombo(combo)}
                    </button>
                    ${!d.fixed && custom && !isRecording && html`
                      <button className="shortcut-row-reset" title="Reset to ${displayCombo(d.def)}"
                              onClick=${() => onReset(d.id)}>↺</button>
                    `}
                    ${(!d.fixed && !custom) && html`<span className="shortcut-row-reset"></span>`}
                  </div>
                `;
              })}
            </div>
          `)}
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

function HamburgerMenu({
  outlineFormat, onSetOutlineFormat, levelFormats, onSetLevelFormat,
  verticalLines, onToggleVerticalLines, showTagChips, onToggleShowTagChips, tagsOnRight, onToggleTagsOnRight,
  // Everything below is only rendered when `collapsed` — Header measured
  // that the toolbar/search/etc. don't fit and rendered them away, so
  // their controls are reachable from here instead. On an uncollapsed
  // header those are already toolbar buttons, so this stays unused there.
  collapsed,
  view, setView, titleFormatMode, onToggleTitleFormat, textMode, onToggleTextMode, onCycleViewMode,
  notesVisible, onToggleNotesVisible, isHoisted, canToggleHoist, onToggleHoist,
  readingWidth, onToggleReadingWidth, onFoldToLevel,
  searchQuery, setSearchQuery, allTags, selectedTags, onToggleTag,
  theme, onToggleTheme, onHelp, syncStatus,
  topBarColor, onSetTopBarColor,
  homeDir, onPickHomeDir,
  journalDir, onPickJournalDir, onClearJournalDir,
  tagListFile, onPickTagListFile, onClearTagListFile,
  bookmarkListFile, onPickBookmarkListFile, onClearBookmarkListFile,
  onSetViewMode,
  tagPanelVisible, onToggleTagPanel,
  bookmarkPanelVisible, onToggleBookmarkPanel,
  homeFile, currentFile, onSetHomeFile,
  openToSection, onSectionOpened,
  statusBarVisible, onToggleStatusBar,
  dateStampFmt, onSetDateStampFmt,
  onShowShortcutEditor,
  onShowToolbarCustomizer,
  onExportToOrg,
  onExportToHtml,
}) {
  const [open, setOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [highlightSection, setHighlightSection] = useState(null);
  const containerRef = useRef(null);
  const homeFileRowRef = useRef(null);
  const colorInputRef = useRef(null);
  const isCustomColor = topBarColor && topBarColor.startsWith("#");

  useEffect(() => {
    if (!openToSection) return;
    setOpen(true);
    setHighlightSection(openToSection);
    onSectionOpened?.();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        homeFileRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    const t = setTimeout(() => setHighlightSection(null), 2000);
    return () => clearTimeout(t);
  }, [openToSection]);

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

  return html`
    <div className=${"hamburger-menu" + (collapsed ? " collapsed" : "")} ref=${containerRef}>
      <button className=${"panel-toggle-btn" + (open ? " active" : "")} onClick=${() => setOpen((o) => !o)} title="More options">
        <${IconHamburger} />
      </button>
      ${open && html`
        <div className="folder-picker-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
        <div className="hamburger-menu-popup">

          <!-- ── Status / theme ── -->
          <div className="hamburger-status-row">
            <div className="hamburger-status-left">
              <${SyncIndicator} status=${syncStatus} />
              <span className="hamburger-sync-label">${SYNC_LABELS[syncStatus] || ""}</span>
            </div>
            <button className="hamburger-theme-btn" onClick=${onToggleTheme}
                    title=${theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
              ${theme === "dark" ? html`<${IconSun}/>` : html`<${IconMoon}/>`}
            </button>
          </div>

          <!-- ── Outline ── -->
          ${view === "outline" && html`
            <div className="hamburger-viewmode-row">
              <span className="hamburger-viewmode-label">View mode</span>
              <div className="hamburger-segmented">
                <button className=${"hamburger-segmented-btn" + (!titleFormatMode && !textMode ? " active" : "")}
                        onClick=${() => onSetViewMode("plain")}>Plain</button>
                <button className=${"hamburger-segmented-btn" + (titleFormatMode && !textMode ? " active" : "")}
                        onClick=${() => onSetViewMode("formatted")}>Formatted</button>
                <button className=${"hamburger-segmented-btn" + (textMode ? " active" : "")}
                        onClick=${() => onSetViewMode("reveal")}>Reveal Codes</button>
              </div>
            </div>
          `}
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${notesVisible} onChange=${onToggleNotesVisible} disabled=${textMode || view !== "outline"} />
            <span>Show notes inline</span>
          </label>
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${isHoisted} onChange=${onToggleHoist} disabled=${!canToggleHoist || textMode || view !== "outline"} />
            <span>Hoist (isolate focused item)</span>
          </label>
          <div className="hamburger-outline-format">
            <span className="hamburger-format-label">Globally: bullet style</span>
            <div className="hamburger-format-chips">
              ${["bullets", "numbers", "letters", "upper"].map((fmt) => html`
                <button key=${fmt}
                        className=${"hfmt-chip" + (outlineFormat === fmt ? " active" : "")}
                        onClick=${() => onSetOutlineFormat(fmt)}
                        disabled=${textMode}>
                  ${fmt === "bullets" ? "• Bullets" : fmt === "numbers" ? "1. Numbers" : fmt === "letters" ? "a. Letters" : "A. Letters"}
                </button>
              `)}
            </div>
          </div>
          <div className="hamburger-outline-format">
            <span className="hamburger-format-label">Per level (click to cycle; × = use global)</span>
            <div className="hamburger-format-chips">
              ${[0, 1, 2, 3, 4, 5].map((d) => html`
                <${LevelFormatChip} key=${d} depth=${d} levelFormats=${levelFormats} onSetLevelFormat=${onSetLevelFormat} textMode=${textMode} />
              `)}
            </div>
          </div>
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${verticalLines} onChange=${onToggleVerticalLines} disabled=${textMode} />
            <span>Vertical lines</span>
          </label>
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${showTagChips} onChange=${onToggleShowTagChips} disabled=${textMode} />
            <span>Show tags and todo status in outline</span>
          </label>
          ${showTagChips && html`
            <label className="hamburger-menu-option hamburger-menu-option-indented">
              <input type="checkbox" checked=${tagsOnRight} onChange=${onToggleTagsOnRight} disabled=${textMode} />
              <span>Show on right</span>
            </label>
          `}
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${statusBarVisible} onChange=${onToggleStatusBar} />
            <span>Show status bar</span>
          </label>
          ${view === "outline" && html`
            <div className="hamburger-fold-row">
              <span>Fold to level</span>
              <span>
                ${FOLD_LEVELS.map((lvl) => html`
                  <button key=${lvl} className="hamburger-fold-btn" disabled=${textMode}
                          onClick=${() => { onFoldToLevel(lvl); setOpen(false); }}>${lvl}</button>
                `)}
              </span>
            </div>
          `}

          <!-- ── Workspace ── -->
          <div className="hamburger-section">
            <div className="hamburger-menu-option hamburger-homefolder-row">
              <span>Home Folder</span>
              <button className="homefolder-path-btn" title="Click to change home folder" onClick=${onPickHomeDir}>
                ${homeDir || "…"}
              </button>
            </div>
            <div className=${"hamburger-menu-option hamburger-homefile-row" + (highlightSection === "homeFile" ? " hamburger-section-highlight" : "")}
                 ref=${homeFileRowRef}>
              <span>Home File</span>
              <div className="homefile-controls">
                <span className=${"homefile-name" + (homeFile ? "" : " homefile-name-empty")}>
                  ${homeFile || "not set"}
                </span>
                <button className="homefile-set-btn"
                        disabled=${!currentFile}
                        onClick=${() => onSetHomeFile(currentFile)}
                        title=${currentFile ? "Set \"" + currentFile + "\" as home file" : "Open a file first"}>
                  Set current
                </button>
                ${homeFile && html`
                  <button className="homefile-clear-btn" onClick=${() => onSetHomeFile(null)} title="Clear home file">×</button>
                `}
              </div>
            </div>
            <div className="hamburger-menu-option hamburger-homefolder-row">
              <span>Journal Folder</span>
              <div className="homefile-controls">
                <button className="homefolder-path-btn" title="Click to set a custom journal folder" onClick=${onPickJournalDir}>
                  ${journalDir || "(same as Home Folder)"}
                </button>
                ${journalDir && html`
                  <button className="homefile-clear-btn" onClick=${onClearJournalDir} title="Reset to default (journal/ inside Home Folder)">×</button>
                `}
              </div>
            </div>
            <div className="hamburger-menu-option hamburger-homefolder-row">
              <span>Tag List</span>
              <div className="homefile-controls">
                <button className="homefolder-path-btn" title="Click to choose a tag list .org file" onClick=${onPickTagListFile}>
                  ${tagListFile ? pathBasename(tagListFile) : "TagList.org (default)"}
                </button>
                ${tagListFile && html`
                  <button className="homefile-clear-btn" onClick=${onClearTagListFile} title="Reset to default (TagList.org in Home Folder)">×</button>
                `}
              </div>
            </div>
            <div className="hamburger-menu-option hamburger-homefolder-row">
              <span>Bookmark List</span>
              <div className="homefile-controls">
                <button className="homefolder-path-btn" title="Click to choose a bookmark list .org file" onClick=${onPickBookmarkListFile}>
                  ${bookmarkListFile ? pathBasename(bookmarkListFile) : "Bookmarks.org (default)"}
                </button>
                ${bookmarkListFile && html`
                  <button className="homefile-clear-btn" onClick=${onClearBookmarkListFile} title="Reset to default (Bookmarks.org in Home Folder)">×</button>
                `}
              </div>
            </div>
          </div>

          <!-- ── Appearance (infrequent) ── -->
          <div className="hamburger-section">
            <div className="hamburger-menu-option hamburger-topbar-row">
              <span>Top Bar Color</span>
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
                  <button className=${"topbar-chip topbar-chip-custom" + (isCustomColor ? " active" : "")}
                          style=${isCustomColor ? { background: topBarColor } : {}}
                          onClick=${() => colorInputRef.current?.click()}
                          title=${isCustomColor ? "Custom: " + topBarColor : "Custom color…"}></button>
                  <input ref=${colorInputRef} type="color" className="topbar-color-input-hidden"
                         value=${isCustomColor ? topBarColor : "#225167"}
                         onInput=${(e) => onSetTopBarColor(e.target.value)} />
                </div>
              </div>
            </div>
            <label className="hamburger-menu-option">
              <input type="checkbox" checked=${readingWidth} onChange=${onToggleReadingWidth} />
              <span>Reading width</span>
            </label>
            <button className="hamburger-about-btn" onClick=${() => { setOpen(false); onShowToolbarCustomizer?.(); }}>
              Customize Toolbar…
            </button>
            <div className="hamburger-viewmode-row">
              <span className="hamburger-viewmode-label">Stamp date</span>
              <div className="hamburger-segmented">
                ${DATE_FMT_OPTIONS.map((opt) => html`
                  <button key=${opt.key}
                          className=${"hamburger-segmented-btn" + (dateStampFmt?.date === opt.key ? " active" : "")}
                          onClick=${() => onSetDateStampFmt({ ...dateStampFmt, date: opt.key })}>
                    ${opt.label}
                  </button>
                `)}
              </div>
            </div>
            <div className="hamburger-viewmode-row">
              <span className="hamburger-viewmode-label">Stamp time</span>
              <div className="hamburger-segmented">
                ${TIME_FMT_OPTIONS.map((opt) => html`
                  <button key=${opt.key}
                          className=${"hamburger-segmented-btn" + (dateStampFmt?.time === opt.key ? " active" : "")}
                          onClick=${() => onSetDateStampFmt({ ...dateStampFmt, time: opt.key })}>
                    ${opt.label}
                  </button>
                `)}
              </div>
            </div>
          </div>

          <!-- ── Mobile-only: view switcher + panels + status ── -->
          ${collapsed && html`
            <div className="hamburger-section hamburger-mobile-only">
              <div className="hamburger-segmented">
                <button className=${"hamburger-segmented-btn" + (view === "outline" ? " active" : "")}
                        onClick=${() => { setView("outline"); setOpen(false); }}><${IconOutline} /> Outline</button>
                <button className=${"hamburger-segmented-btn" + (view === "agenda" ? " active" : "")}
                        onClick=${() => { setView("agenda"); setOpen(false); }}><${IconAgenda} /> Agenda</button>
                <button className=${"hamburger-segmented-btn" + (view === "todo" ? " active" : "")}
                        onClick=${() => { setView("todo"); setOpen(false); }}><${IconTodo} /> TODO</button>
                <button className=${"hamburger-segmented-btn" + (view === "journal" ? " active" : "")}
                        onClick=${() => { setView("journal"); setOpen(false); }}><${IconJournal} /> Journal</button>
              </div>
              <div className="hamburger-mobile-panels">
                <button className=${"hamburger-panel-btn" + (tagPanelVisible ? " active" : "")}
                        onClick=${() => { onToggleTagPanel(); setOpen(false); }}
                        disabled=${textMode}><${IconTag} /> Tag Panel</button>
                <button className=${"hamburger-panel-btn" + (bookmarkPanelVisible ? " active" : "")}
                        onClick=${() => { onToggleBookmarkPanel(); setOpen(false); }}
                        disabled=${textMode}><${IconBookmark} /> Bookmark Panel</button>
              </div>
              <div className="hamburger-mobile-row">
                <span>${SYNC_LABELS[syncStatus] || syncStatus}</span>
                <button onClick=${() => { onHelp(); setOpen(false); }}>Commands</button>
              </div>
            </div>
          `}

          <!-- ── About / Tools ── -->
          <div className="hamburger-section">
            <button className="hamburger-about-btn"
                    title="Use this option to save a local copy of the current org file for backup or other use."
                    disabled=${!currentFile}
                    onClick=${() => { setOpen(false); onExportToOrg?.(); }}>
              Export to Local Org File
            </button>
            <button className="hamburger-about-btn"
                    title="Save a standalone HTML file of this document"
                    disabled=${!currentFile}
                    onClick=${() => { setOpen(false); onExportToHtml?.(); }}>
              Export to HTML
            </button>
            <button className="hamburger-about-btn" onClick=${() => { setOpen(false); onShowShortcutEditor?.(); }}>
              Keyboard Shortcuts…
            </button>
            <button className="hamburger-about-btn" onClick=${() => { setOpen(false); setShowAbout(true); }}>
              About Epicorg…
            </button>
          </div>
        </div>
        </div>
      `}

      ${showAbout && html`<${AboutModal} onClose=${() => setShowAbout(false)} />`}
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

function Header({ onHelp, syncStatus, view, setView, currentFile, onBack, searchQuery, setSearchQuery, searchInputRef, allTags, selectedTags, onToggleTag, onClearTags, detailVisible, onToggleDetails, tagPanelVisible, onToggleTagPanel, bookmarkPanelVisible, onToggleBookmarkPanel, titleFormatMode, onToggleTitleFormat, textMode, onToggleTextMode, onCycleViewMode, onSetViewMode, textModeError, notesVisible, onToggleNotesVisible, outlineFormat, onSetOutlineFormat, levelFormats, onSetLevelFormat, verticalLines, onToggleVerticalLines, showTagChips, onToggleShowTagChips, tagsOnRight, onToggleTagsOnRight, isHoisted, canToggleHoist, onToggleHoist, readingWidth, onToggleReadingWidth, sidebarVisible, onToggleSidebar, onFoldToLevel, theme, onToggleTheme, topBarColor, onSetTopBarColor, canUndo, canRedo, onUndo, onRedo, homeDir, onPickHomeDir, journalDir, onPickJournalDir, onClearJournalDir, tagListFile, onPickTagListFile, onClearTagListFile, bookmarkListFile, onPickBookmarkListFile, onClearBookmarkListFile, onOpenTextSearch, canGoBack, canGoForward, onGoBack, onGoForward, homeFile, onGoHome, onSetHomeFile, toolbarConfig, statusBarVisible, onToggleStatusBar, dateStampFmt, onSetDateStampFmt, onShowShortcutEditor, onShowOutlineActions, onShowToolbarCustomizer, onExportToOrg, onExportToHtml }) {
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
    // Buffer of 100px pre-emptively collapses before the toolbar can overflow.
    const check = () => {
      const parentW = header.parentElement.clientWidth;
      setCollapsed(probe.scrollWidth + 100 > parentW);
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
                      onClick=${() => homeFile ? onGoHome() : setOpenHamburgerSection("homeFile")}
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
                      title=${textMode ? "Not available in reveal codes mode" : notesVisible ? "Hide notes" : "Show notes inline"}><${IconNotes} /></button>
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
          <button className="view-tab" title="Search all files (Ctrl+Shift+F)" onClick=${onOpenTextSearch}>
            <${IconSearch} />
          </button>
        </div>
        <div className="search-box" style=${{ opacity: textMode ? 0.4 : 1, pointerEvents: textMode ? "none" : "auto" }}>
          <input
            ref=${expanded ? null : searchInputRef}
            type="text"
            className="search-input"
            placeholder="Filter… (Ctrl+K)"
            value=${searchQuery || ""}
            onChange=${(e) => setSearchQuery(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchQuery("");
                e.target.blur();
              }
            }}
          />
          ${searchQuery && html`
            <button className="search-clear" onClick=${() => setSearchQuery("")} title="Clear (Esc)">×</button>
          `}
        </div>
        </div>
      `}
      <div className="header-right" ref=${headerRightRef}>
        <${HamburgerMenu} outlineFormat=${outlineFormat} onSetOutlineFormat=${onSetOutlineFormat} levelFormats=${levelFormats} onSetLevelFormat=${onSetLevelFormat}
          verticalLines=${verticalLines} onToggleVerticalLines=${onToggleVerticalLines}
          showTagChips=${showTagChips} onToggleShowTagChips=${onToggleShowTagChips}
          tagsOnRight=${tagsOnRight} onToggleTagsOnRight=${onToggleTagsOnRight}
          collapsed=${collapsed}
          view=${view} setView=${setView}
          titleFormatMode=${titleFormatMode} onToggleTitleFormat=${onToggleTitleFormat}
          textMode=${textMode} onToggleTextMode=${onToggleTextMode} onCycleViewMode=${onCycleViewMode} onSetViewMode=${onSetViewMode}
          notesVisible=${notesVisible} onToggleNotesVisible=${onToggleNotesVisible}
          isHoisted=${isHoisted} canToggleHoist=${canToggleHoist} onToggleHoist=${onToggleHoist}
          readingWidth=${readingWidth} onToggleReadingWidth=${onToggleReadingWidth}
          onFoldToLevel=${onFoldToLevel}
          searchQuery=${searchQuery} setSearchQuery=${setSearchQuery}
          allTags=${allTags} selectedTags=${selectedTags} onToggleTag=${onToggleTag}
          theme=${theme} onToggleTheme=${onToggleTheme} onHelp=${onHelp} syncStatus=${syncStatus}
          topBarColor=${topBarColor} onSetTopBarColor=${onSetTopBarColor}
          homeDir=${homeDir} onPickHomeDir=${onPickHomeDir}
          journalDir=${journalDir} onPickJournalDir=${onPickJournalDir} onClearJournalDir=${onClearJournalDir}
          tagListFile=${tagListFile} onPickTagListFile=${onPickTagListFile} onClearTagListFile=${onClearTagListFile}
          bookmarkListFile=${bookmarkListFile} onPickBookmarkListFile=${onPickBookmarkListFile} onClearBookmarkListFile=${onClearBookmarkListFile}
          tagPanelVisible=${tagPanelVisible} onToggleTagPanel=${onToggleTagPanel}
          bookmarkPanelVisible=${bookmarkPanelVisible} onToggleBookmarkPanel=${onToggleBookmarkPanel}
          homeFile=${homeFile} currentFile=${currentFile} onSetHomeFile=${onSetHomeFile}
          openToSection=${openHamburgerSection} onSectionOpened=${() => setOpenHamburgerSection(null)}
          statusBarVisible=${statusBarVisible} onToggleStatusBar=${onToggleStatusBar}
          dateStampFmt=${dateStampFmt} onSetDateStampFmt=${onSetDateStampFmt}
          onShowShortcutEditor=${onShowShortcutEditor}
          onShowToolbarCustomizer=${onShowToolbarCustomizer}
          onExportToOrg=${onExportToOrg}
          onExportToHtml=${onExportToHtml} />
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
    toggleHoist, isHoisted,
    toggleTagPanel, tagPanelVisible,
    toggleBookmarkPanel, bookmarkPanelVisible,
    foldToLevel,
    setView, view,
    setShowPicker, setShowTextSearch, setShowFolderPicker, setShowHelp,
    insertFootnote, insertDateStamp,
    splitFocusedNode, joinFocusedWithNext,
    exportToHtml, exportToOrg, currentFile,
    copyAsFormatted, copyAsPlain,
    clearRecentFiles,
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
    { category: "Folding", label: "Expand All",           desc: "Unfold everything",              keys: "Alt+9",         action: () => foldToLevel(9) },
    // Edit
    { category: "Edit", label: "Undo",                    desc: "Undo last change",               keys: displayCombo(getShortcutCombo("undo")),            action: undo,      disabled: !canUndo },
    { category: "Edit", label: "Redo",                    desc: "Redo last undone change",        keys: displayCombo(getShortcutCombo("redo")),            action: redo,      disabled: !canRedo },
    { category: "Edit", label: "Bold selection",          desc: "Wrap selection in *bold*",       keys: displayCombo(getShortcutCombo("bold")),            action: () => applyMarkerToFocused("*") },
    { category: "Edit", label: "Italic selection",        desc: "Wrap selection in /italic/",     keys: displayCombo(getShortcutCombo("italic")),          action: () => applyMarkerToFocused("/") },
    { category: "Edit", label: "Underline selection",     desc: "Wrap selection in _underline_",  keys: displayCombo(getShortcutCombo("underline")),       action: () => applyMarkerToFocused("_") },
    { category: "Edit", label: "Strikethrough selection", desc: "Wrap selection in +strike+",     keys: displayCombo(getShortcutCombo("strikethrough")),   action: () => applyMarkerToFocused("+") },
    { category: "Edit", label: "Insert Footnote",         desc: "Add [fn:N] at cursor in notes",  keys: displayCombo(getShortcutCombo("insertFootnote")),  action: insertFootnote },
    { category: "Edit", label: "Insert Date Stamp",       desc: "Insert formatted date/time at cursor", keys: displayCombo(getShortcutCombo("insertDateStamp")), action: insertDateStamp },
    { category: "Edit", label: "Split Node at Cursor",    desc: "Split title at cursor into two sibling nodes", keys: displayCombo(getShortcutCombo("splitNode")), action: splitFocusedNode },
    { category: "Edit", label: "Join with Next Node",     desc: "Merge this node with the next sibling",        keys: displayCombo(getShortcutCombo("joinNode")),   action: joinFocusedWithNext },
    { category: "Edit", label: "Hoist / Unhoist",         desc: isHoisted ? "Unhoist — show full tree" : "Hoist focused item", keys: displayCombo(getShortcutCombo("hoist")), action: toggleHoist },
    // Search
    { category: "Search", label: "Full-text Search…",    desc: "Search across all org files",    keys: displayCombo(getShortcutCombo("textSearch")),      action: () => setShowTextSearch(true) },
    // Settings
    { category: "Settings", label: "Toggle Dark/Light Theme", desc: "Switch colour theme",       keys: "",              action: toggleTheme },
    { category: "Settings", label: "Cycle View Mode",       desc: textMode ? "Reveal codes → Plain" : titleFormatMode ? "Formatted → Reveal codes" : "Plain → Formatted titles", keys: "", action: cycleViewMode },
    { category: "Settings", label: "Change Home Folder…",    desc: "Pick a new home org folder",  keys: "", action: () => setShowFolderPicker(true) },
    { category: "Settings", label: "Clear Recent File List", desc: "Remove all entries from the recent files list in the sidebar", keys: "", action: clearRecentFiles },
    // Export / Copy
    { category: "Export", label: "Export to Local Org File", desc: "Use this option to save a local copy of the current org file for backup or other use.", keys: "", action: exportToOrg, disabled: !currentFile },
    { category: "Export", label: "Export to HTML",           desc: "Save standalone HTML file of this document",    keys: "", action: exportToHtml,     disabled: !currentFile },
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
