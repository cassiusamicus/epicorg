import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useReducer, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import * as tree from "./tree.js";

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
    const deadlineDate = tree.parseOrgDate(n.properties?.DEADLINE);
    if (deadlineDate) {
      items.push({ id: n.id, title: n.title, date: deadlineDate, time: "", kind: "deadline", status: n.status, tags: n.tags, ancestors });
    }
    const scheduledRaw = n.properties?.SCHEDULED;
    const scheduledDate = tree.parseOrgDate(scheduledRaw);
    if (scheduledDate) {
      const time = tree.parseOrgScheduledTime(scheduledRaw);
      items.push({ id: n.id, title: n.title, date: scheduledDate, time, kind: "scheduled", status: n.status, tags: n.tags, ancestors });
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
  return dateStr === new Date().toISOString().slice(0, 10);
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

// Fire a custom event so the App can show the file-link picker without
// prop-drilling a callback through the entire OutlineNode tree.
function triggerLinkPicker(textarea) {
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
function NodeBody({ node, dispatch, isEditing, titleFormatMode, notesVisible, depth, bodyRefs }) {
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
  if (!isEditing && (!notesVisible || !node.body)) return null;

  const showFormatted = titleFormatMode && !isEditing;

  return html`
    <div className="node-body-row">
      <span style=${{ width: depth * 24 + 40, flexShrink: 0 }} />
      ${showFormatted
        ? html`
          <div className="node-body-preview"
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
            onChange=${(e) => { dispatch(node.id, "change-body", e.target.value); triggerLinkPicker(e.target); }}
            onBlur=${() => dispatch(node.id, "stop-edit-body")}
            onKeyDown=${(e) => {
              const marker = formatMarkerForKey(e);
              if (marker) { e.preventDefault(); wrapSelectionWithMarker(e, marker, (v) => dispatch(node.id, "change-body", v)); return; }
              if (e.key === "Escape") { e.preventDefault(); dispatch(node.id, "focus-outline"); }
            }}
          />
        `}
    </div>
  `;
}

function OutlineNode({ node, focusedId, dispatch, inputRefs, depth, titleFormatMode, notesVisible, numberedBullets, siblingIndex, verticalLines, bodyEditingId, bodyRefs }) {
  const isFocused = focusedId === node.id;
  const hasChildren = node.children?.length > 0;
  const titleRef = useRef(null);
  const [isEditing, setIsEditing] = useState(false);
  const showFormatted = titleFormatMode && !isFocused;
  // When focused but not yet editing: overlay rendered view over a hidden (keyboard-capturing) textarea.
  const showOverlay = titleFormatMode && isFocused && !isEditing;
  const bodyEditing = bodyEditingId === node.id;
  const hasHiddenNote = !notesVisible && !!node.body && !bodyEditing;

  // Reset to view mode whenever this node loses focus.
  useEffect(() => { if (!isFocused) setIsEditing(false); }, [isFocused]);

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
        <span className=${"bullet" + (hasChildren ? (node.collapsed ? " has-children collapsed" : " has-children expanded") : "") + (numberedBullets ? " numbered" : "")}
              onMouseDown=${(e) => {
                e.preventDefault();
                if (hasChildren) dispatch(node.id, "toggle");
              }}>
          ${numberedBullets && html`<span className="bullet-caret">${hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : ""}</span>`}
          ${numberedBullets && html`<span className="bullet-number">${siblingIndex}.</span>`}
          ${!numberedBullets && (hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : html`<span className="bullet-dot" />`)}
        </span>
        ${node.status ? html`
          <span className=${"status-badge status-" + node.status.toLowerCase()}
                onClick=${(e) => { e.stopPropagation(); dispatch(node.id, "cycle-status"); }}
                title="Click to change status">${node.status}</span>
        ` : html`
          <span className="status-badge status-none"
                onClick=${(e) => { e.stopPropagation(); dispatch(node.id, "cycle-status"); }}
                title="Click to set status"></span>
        `}
        ${node.priority && html`
          <span className=${"priority-badge priority-" + node.priority}
                onClick=${(e) => { e.stopPropagation(); dispatch(node.id, "set-priority", node.priority === "A" ? "B" : node.priority === "B" ? "C" : "A"); }}
                title="Click to cycle priority">[#${node.priority}]</span>
        `}
        ${showFormatted
          ? html`
            <div className=${"node-title node-title-preview" + (node.status === "DONE" || node.status === "CANCELLED" ? " done" : "")}
                 onClick=${(e) => {
                   if (e.target.closest(".node-has-notes-indicator")) { dispatch(node.id, "edit-body"); return; }
                   dispatch(node.id, "edit-title");
                 }}
                 dangerouslySetInnerHTML=${{
                   __html: tree.renderOrgInline(node.title) +
                     (hasHiddenNote ? ' <span class="node-has-notes-indicator" title="This item has a hidden note — click to view it">…</span>' : ""),
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
                if (showOverlay && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) setIsEditing(true);
                handleKey(e, node.id, dispatch);
              }}
              onChange=${(e) => { setIsEditing(true); dispatch(node.id, "change", e.target.value); triggerLinkPicker(e.target); }}
            />
          `}
        ${showOverlay && html`
          <div className=${"node-title node-title-preview" + (node.status === "DONE" || node.status === "CANCELLED" ? " done" : "")}
               onClick=${(e) => {
                 if (e.target.closest(".node-has-notes-indicator")) { dispatch(node.id, "edit-body"); return; }
                 setIsEditing(true);
                 setTimeout(() => titleRef.current?.focus(), 0);
               }}
               dangerouslySetInnerHTML=${{
                 __html: tree.renderOrgInline(node.title) +
                   (hasHiddenNote ? ' <span class="node-has-notes-indicator" title="This item has a hidden note — click to view it">…</span>' : ""),
               }} />
        `}
        ${!showFormatted && !showOverlay && hasHiddenNote && html`
          <span className="node-has-notes-indicator"
                onClick=${() => dispatch(node.id, "edit-body")}
                title="This item has a hidden note — click to view it">…</span>
        `}
      </div>
      <${NodeBody}
        node=${node}
        dispatch=${dispatch}
        isEditing=${bodyEditing}
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
            numberedBullets=${numberedBullets}
            siblingIndex=${i + 1}
            verticalLines=${verticalLines}
            bodyEditingId=${bodyEditingId}
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
function TagList({ tags, onUpdate, depth, selectedTags, onToggleTag, onAddTagToItem, onNestTag, onSearch }) {
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dropLineIdx, setDropLineIdx] = useState(null);  // line shown between items
  const [nestOverIdx, setNestOverIdx] = useState(null);  // box shown on nest target
  const [addingChildFor, setAddingChildFor] = useState(null);
  const [newChildName, setNewChildName] = useState("");

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
            <button className="tag-search-btn" title=${"Search all files for :" + tag.name + ":"}
                    onClick=${(e) => { e.stopPropagation(); onSearch(tag.name); }}><${IconSearch} /></button>
            <span className="tag-panel-drag-icon">⠿</span>
            <span className="tag-panel-name" onClick=${() => onToggleTag(tag.name)}>${tag.name}</span>
            <button className="tag-add-to-item-btn" title="Add this tag to the focused item"
                    onClick=${(e) => { e.stopPropagation(); onAddTagToItem(tag.name); }}>+</button>
            <button className="tag-add-child-btn" title="Add sub-tag"
                    onClick=${(e) => { e.stopPropagation(); setAddingChildFor(i); setNewChildName(""); }}>↳</button>
            <button className="tag-panel-remove" title="Remove from list"
                    onClick=${(e) => { e.stopPropagation(); onUpdate(tags.filter((_, j) => j !== i)); }}>×</button>
          </div>
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
              onSearch=${onSearch} />
          `}
        </div>
      `;
    })}
    ${dropLineIdx === n && html`<div className="tag-drop-line" style=${{marginLeft: (4 + depth * 14) + "px"}}></div>`}
  `;
}

function TagPanel({ globalTags, onUpdateTags, onNestTag, onAddTagToItem, selectedTags, onToggleTag, onClearTags, onEditTagFile, width, onWidthChange, onSearch }) {
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
            onSearch=${onSearch} />
          ${globalTags.length === 0 && html`
            <div className="tag-panel-empty">No tags yet.<br/>Open org files with tags to populate this list.</div>
          `}
        </div>
        <button className="tag-edit-file-btn" onClick=${onEditTagFile}>Edit TagList.org</button>
      </div>
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

function BookmarkPanel({ globalBMs, onUpdateBMs, onNestBM, onAddBMToItem, onEditBookmarkFile, width, onWidthChange }) {
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
        <button className="tag-edit-file-btn" onClick=${onEditBookmarkFile}>Edit Bookmarks.org</button>
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

const DetailPane = forwardRef(function DetailPane({ node, isPreamble, dispatch, inputRefs, width, visible, onWidthChange, onOpen, titleFormatMode, globalTags }, ref) {
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
          ${["A","B","C",""].map((p) => html`
            <button key=${p || "none"}
                    className=${"detail-priority-btn priority-" + (p || "none") + (node?.priority === p ? " active" : "")}
                    disabled=${!node}
                    onClick=${() => dispatch(node.id, "set-priority", p)}>
              ${p ? html`[#${p}]` : "NONE"}
            </button>
          `)}
        </div>
      </div>
      <div className="detail-section">
        <label className="detail-label">Due date</label>
        <input type="date" className="detail-date"
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
      </div>
      <div className="detail-section">
        <label className="detail-label">Scheduled</label>
        <div className="detail-scheduled-row">
          <input type="date" className="detail-date detail-scheduled-date"
            value=${node ? tree.parseOrgDate(node.properties?.SCHEDULED) : ""}
            disabled=${!node}
            onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
            onChange=${(e) => {
              if (!node) return;
              const updated = { ...(node.properties || {}) };
              const time = tree.parseOrgScheduledTime(node.properties?.SCHEDULED || "");
              if (e.target.value) updated.SCHEDULED = tree.formatOrgScheduled(e.target.value, time);
              else delete updated.SCHEDULED;
              dispatch(node.id, "update-properties", updated);
            }} />
          <input type="time" className="detail-date detail-scheduled-time"
            value=${node ? tree.parseOrgScheduledTime(node.properties?.SCHEDULED || "") : ""}
            disabled=${!node || !tree.parseOrgDate(node.properties?.SCHEDULED)}
            onClick=${(e) => { try { e.target.showPicker(); } catch {} }}
            onChange=${(e) => {
              if (!node) return;
              const date = tree.parseOrgDate(node.properties?.SCHEDULED || "");
              if (!date) return;
              const updated = { ...(node.properties || {}) };
              updated.SCHEDULED = tree.formatOrgScheduled(date, e.target.value);
              dispatch(node.id, "update-properties", updated);
            }} />
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
      <div className="detail-content">${inner}</div>
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

  const toggleStatus = (s) => setStatusFilter((prev) => {
    const next = new Set(prev);
    next.has(s) ? next.delete(s) : next.add(s);
    return next;
  });

  const isFiltering = !!searchQuery || (selectedTags && selectedTags.length > 0) || statusFilter.size > 0;
  let items = collectTodoItems(nodes);
  if (searchQuery) items = items.filter((item) => tree.matchesQuery(searchQuery, item.title));
  if (selectedTags && selectedTags.length > 0) {
    items = items.filter((item) => item.tags.some((t) => selectedTags.includes(t)));
  }
  if (statusFilter.size > 0) {
    items = items.filter((item) => statusFilter.has(item.status));
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
        ${statusFilter.size > 0 && html`
          <button className="todo-filter-clear" onClick=${() => setStatusFilter(new Set())}>✕ clear</button>
        `}
      </div>
      ${items.length === 0 ? html`
        <div className="agenda-empty">${isFiltering ? "No matches" : "No TODO items in this file"}</div>
      ` : items.map((item) => html`
        <div className="todo-item" key=${item.id} onClick=${() => onSelect(item.id)}>
          <span className=${"todo-item-priority priority-chip" + (item.priority ? " has-priority priority-" + item.priority : "")}>
            ${item.priority ? html`[#${item.priority}]` : "–"}
          </span>
          <span className=${"todo-item-status status-badge status-" + item.status.toLowerCase()}>
            ${item.status}
          </span>
          <span className="todo-item-title">${item.title || "Untitled"}</span>
          ${item.tags.length > 0 && html`
            <span className="agenda-item-tags">
              ${item.tags.map((t) => html`<span key=${t} className="agenda-item-tag">:${t}:</span>`)}
            </span>
          `}
          ${item.ancestors.length > 0 && html`
            <span className="todo-item-path">${item.ancestors.join(" › ")}</span>
          `}
        </div>
      `)}
    </div>
  `;
}

function AgendaView({ nodes, onSelect, searchQuery, selectedTags }) {
  const isFiltering = !!searchQuery || (selectedTags && selectedTags.length > 0);
  let items = collectDatedItems(nodes);
  if (searchQuery) items = items.filter((item) => tree.matchesQuery(searchQuery, item.title));
  if (selectedTags && selectedTags.length > 0) {
    items = items.filter((item) => (item.tags || []).some((t) => selectedTags.includes(t)));
  }
  items.sort((a, b) => {
    const dc = a.date.localeCompare(b.date);
    if (dc !== 0) return dc;
    if (a.time && !b.time) return -1;
    if (!a.time && b.time) return 1;
    return (a.time || "").localeCompare(b.time || "");
  });

  if (items.length === 0) {
    return html`<div className="agenda-empty">${isFiltering ? "No matches" : "No items scheduled or with due dates"}</div>`;
  }

  const groups = [];
  let cur = null;
  for (const item of items) {
    if (!cur || cur.date !== item.date) { cur = { date: item.date, items: [] }; groups.push(cur); }
    cur.items.push(item);
  }

  return html`
    <div className="agenda-view">
      ${groups.map((g) => html`
        <div className="agenda-group" key=${g.date}>
          <div className=${"agenda-date" + (isOverdue(g.date) ? " overdue" : "") + (isToday(g.date) ? " today" : "")}>
            ${formatDateDisplay(g.date)}
            ${isToday(g.date) && html`<span className="agenda-badge">today</span>`}
            ${isOverdue(g.date) && html`<span className="agenda-badge overdue">overdue</span>`}
          </div>
          ${g.items.map((item) => html`
            <div className="agenda-item" key=${item.id + "-" + item.kind} onClick=${() => onSelect(item.id)}>
              <div className="agenda-item-top">
                ${item.time && html`<span className="agenda-item-time">${item.time}</span>`}
                <span className="agenda-item-title">${item.title || "Untitled"}</span>
                <span className=${"agenda-item-kind " + item.kind}>${item.kind === "scheduled" ? "sched" : "due"}</span>
              </div>
              ${item.ancestors.length > 0 && html`
                <span className="agenda-item-path">${item.ancestors.join(" \u203A ")}</span>
              `}
            </div>
          `)}
        </div>
      `)}
    </div>
  `;
}

// Ctrl+B/I/U wrap the selection in org-mode's inline markup characters.
// Org has no native underline marker — "_underline_" is the closest
// convention (rendered as underline by tree.renderOrgInline elsewhere).
const FORMAT_MARKERS = { b: "*", i: "/", u: "_" };

function formatMarkerForKey(e) {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  return FORMAT_MARKERS[e.key.toLowerCase()] || null;
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
  const alt = e.altKey, shift = e.shiftKey, key = e.key;
  if (alt && key === "ArrowUp")    { e.preventDefault(); dispatch(id, "move-up"); return; }
  if (alt && key === "ArrowDown")  { e.preventDefault(); dispatch(id, "move-down"); return; }
  if (alt && key === "ArrowRight") { e.preventDefault(); dispatch(id, "indent"); return; }
  if (alt && key === "ArrowLeft")  { e.preventDefault(); dispatch(id, "outdent"); return; }
  if (key === "Tab") { e.preventDefault(); dispatch(id, "toggle"); return; }
  if (key === "ArrowUp")   { e.preventDefault(); dispatch(id, "nav-up"); return; }
  if (key === "ArrowDown") { e.preventDefault(); dispatch(id, "nav-down"); return; }
  if (key === "Enter" && shift) { e.preventDefault(); dispatch(id, "focus-body"); return; }
  if (key === "Enter") { e.preventDefault(); dispatch(id, "new-sibling"); return; }
  if (key === "Backspace" && e.target.value === "") { e.preventDefault(); dispatch(id, "delete"); return; }
}

// --- Sync status ---
const SYNC_SAVED = "saved";
const SYNC_DIRTY = "unsaved";
const SYNC_SAVING = "saving";
const SYNC_ERROR = "error";
const SYNC_CONFLICT = "conflict";
const SYNC_MERGED = "merged";
const SYNC_RELOADED = "reloaded";

const SYNC_LABELS = {
  [SYNC_SAVED]:    "Saved \u2014 gray dot: up to date",
  [SYNC_DIRTY]:    "Unsaved changes \u2014 yellow hollow dot: pending save",
  [SYNC_SAVING]:   "Saving\u2026 \u2014 gray dot: save in progress",
  [SYNC_ERROR]:    "Save failed \u2014 red dot: network or server error",
  [SYNC_CONFLICT]: "Merge conflict \u2014 red dot: resolve conflict markers in file",
  [SYNC_MERGED]:   "Merged external edits \u2014 blue dot: external edit was merged in",
  [SYNC_RELOADED]: "Reloaded \u2014 blue dot: file changed on disk and was reloaded",
};

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

function FilePicker({ files, onSelect, onCreate, onClose, onRename, onDelete }) {
  const [newName, setNewName] = useState("");
  const [sort, setSort] = useState({ column: "name", dir: "asc" });
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
        <h2>Choose a file</h2>
        ${onClose && html`
          <button className="file-picker-close" onClick=${onClose} title="Cancel" aria-label="Close">×</button>
        `}
      </div>
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

function SidebarFileRow({ name, active, isFavorite, onSelect, onToggleFavorite }) {
  return html`
    <div className=${"sidebar-item" + (active ? " active" : "")}>
      <span className="sidebar-item-main" onClick=${() => onSelect(name)} title=${name}>
        <span className="sidebar-item-icon"><${IconDoc}/></span>
        <span className="sidebar-item-name">${name}</span>
      </span>
      <button className=${"sidebar-star" + (isFavorite ? " sidebar-star-active" : "")}
              onClick=${(e) => { e.stopPropagation(); onToggleFavorite(name); }}
              title=${isFavorite ? "Remove from favorites" : "Add to favorites"}>
        ${isFavorite ? "★" : "☆"}
      </button>
    </div>
  `;
}

function Sidebar({ favorites, recentFiles, currentFile, onSelect, onToggleFavorite, bookmarks, onNavigateToBookmark, onDeleteBookmark, onReorderBookmarks }) {
  const dragIndexRef = useRef(null);

  return html`
    <div className="sidebar">
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
                isFavorite=${true} onSelect=${onSelect} onToggleFavorite=${onToggleFavorite} />
            `)}
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-icon">↺</span>
          <span>Recent</span>
        </div>
        ${recentFiles.length === 0
          ? html`<div className="sidebar-empty">No recent files</div>`
          : recentFiles.map((name) => html`
              <${SidebarFileRow} key=${"recent-" + name} name=${name} active=${name === currentFile}
                isFavorite=${favorites.includes(name)} onSelect=${onSelect} onToggleFavorite=${onToggleFavorite} />
            `)}
      </div>
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
]);
// Of those, typing actions get debounced into one undo step per "burst"
// rather than one per keystroke.
const COALESCE_UNDO_ACTIONS = new Set(["change", "change-body", "change-preamble"]);
const UNDO_COALESCE_MS = 800;

function App() {
  const [files, setFiles] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [recentFiles, setRecentFiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem("epicorg.recentFiles") || "[]"); } catch { return []; }
  });
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
  const [preamble, setPreamble] = useState("");
  const [hash, setHash] = useState("");
  const [focusedId, setFocusedId] = useState(null);
  // Hoist ("zoom in"): isolates the outline to one node + its descendants.
  // Transient, per-file — not persisted, reset on every file load/switch.
  const [hoistedId, setHoistedId] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [syncStatus, setSyncStatus] = useState(SYNC_SAVED);
  const [view, setView] = useState("outline");
  const [tagSearch, setTagSearch] = useState(null); // { tag, results } | null
  const pendingTagNavRef = useRef(null); // { file, title } to navigate to after load
  const [homeDir, setHomeDir] = useState(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
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
  const [numberedBullets, setNumberedBullets] = useState(() => {
    try { return localStorage.getItem("epicorg.numberedBullets") === "1"; } catch { return false; }
  });
  const toggleNumberedBullets = useCallback(() => {
    setNumberedBullets((p) => {
      const next = !p;
      try { localStorage.setItem("epicorg.numberedBullets", next ? "1" : "0"); } catch {}
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
  const inputRefs = useRef({});
  const bodyRefs = useRef({});
  // Which node's inline body/notes textarea is currently open for editing —
  // body text now lives under each bullet rather than in the detail pane.
  const [bodyEditingId, setBodyEditingId] = useState(null);
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

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "h") {
        e.preventDefault(); setShowHelp((v) => !v); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "/")) {
        e.preventDefault();
        const el = searchInputRef.current;
        if (el) { el.focus(); el.select(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setShowTextSearch(true);
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBackRef.current?.(); return; }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goForwardRef.current?.(); return; }
      if (e.altKey && e.key >= "1" && e.key <= "9" && !textModeRef.current) {
        e.preventDefault();
        foldToLevel(parseInt(e.key));
      }
      // Unified document-level undo/redo, taking over from the browser's
      // native per-field undo so the whole document has one consistent
      // history regardless of which textarea (if any) has focus. Disabled
      // in text mode, where the plain textarea's own native undo applies.
      if ((e.ctrlKey || e.metaKey) && !textModeRef.current) {
        const key = e.key.toLowerCase();
        if (key === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }
        if (key === "z") { e.preventDefault(); undo(); return; }
        if (key === "y") { e.preventDefault(); redo(); return; }
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
          if (el.setSelectionRange) el.selectionStart = el.selectionEnd = el.value?.length || 0;
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
      if (lastFile && f.some((file) => file.name === lastFile)) loadFile(lastFile);
      else if (data.default && f.some((file) => file.name === data.default)) loadFile(data.default);
      else if (f.length === 1) loadFile(f[0].name);
    });
  }, []);

  // Fetch and track home directory.
  useEffect(() => {
    api.get("/api/homedir").then((d) => setHomeDir(d.dir)).catch(() => {});
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
    const data = await api.get("/api/doc/" + encodeURIComponent(name));
    setShowPicker(false);
    setTextMode(false);
    setHoistedId(null);
    setCurrentFile(name);
    setNodes(data.nodes || []);
    setPreamble(data.preamble || "");
    setHash(data.hash || "");
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

  const canGoBack = navState.index > 0;
  const canGoForward = navState.index < navState.history.length - 1;

  const goBackRef = useRef(null);
  const goForwardRef = useRef(null);

  const goBack = useCallback(async () => {
    if (navState.index <= 0) return;
    const entry = navState.history[navState.index - 1];
    histNavRef.current = true;
    navDispatch({ type: "back" });
    if (entry.file !== currentFileRef.current) {
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
    if (entry.file !== currentFileRef.current) {
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
      // Renaming the open file doesn't change its content, so just relabel
      // it in place rather than reloading.
      setCurrentFile(finalName);
      try { localStorage.setItem("epicorg.lastFile", finalName); } catch {}
    }
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
          const probe = await api.get("/api/hash/" + encodeURIComponent(file));
          if (probe.hash && probe.hash !== hashRef.current) {
            const data = await api.get("/api/doc/" + encodeURIComponent(file));
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
        const result = await api.put("/api/doc/" + encodeURIComponent(file), {
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
        "/api/doc/" + encodeURIComponent(currentFileRef.current),
        new Blob([body], { type: "application/json" })
      );
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
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
      const link = e.target.closest("[data-file-path]");
      if (!link) return;
      e.preventDefault();
      const path = link.getAttribute("data-file-path");
      if (!path) return;
      if (path.endsWith(".org") && !path.includes("/") && !path.includes("\\")) {
        loadFileRef.current?.(path);
      } else {
        api.post("/api/open", { path }).catch(() => {});
      }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);

  const handleAgendaSelect = useCallback((itemId) => {
    setView("outline");
    setNodes((prev) => tree.uncollapseToNode(prev, itemId));
    requestAnimationFrame(() => focusNode(itemId));
  }, [focusNode]);

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

    if (action === "edit-title") { focusNode(nodeId); return; }

    if (action === "edit-body") {
      setBodyEditingId(nodeId);
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
  }, [focusNode, markDirty, maybeSnapshotForUndo]);

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

  const openBookmarkFile = useCallback(() => { setCurrentFile("Bookmarks.org"); }, []);

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
    if (prevFileRef.current === "TagList.org" && currentFile !== "TagList.org") {
      api.get("/api/global-tags").then((d) => {
        const tags = d.tags || [];
        setGlobalTags(tags);
        globalTagsRef.current = tags;
      }).catch(() => {});
    }
    if (prevFileRef.current === "Bookmarks.org" && currentFile !== "Bookmarks.org") {
      api.get("/api/bookmarks").then((d) => {
        const bms = d.bookmarks || [];
        setGlobalBMs(bms);
        globalBMsRef.current = bms;
      }).catch(() => {});
    }
    prevFileRef.current = currentFile;
  }, [currentFile]);

  const openTagFile = useCallback(() => {
    setCurrentFile("TagList.org");
  }, []);

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
          onClose=${currentFile ? () => setShowPicker(false) : null} />
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
  const existingNames = new Set((files || []).map((f) => f.name));
  const validFavorites = favorites.filter((name) => existingNames.has(name));
  const validRecentFiles = recentFiles.filter((name) => existingNames.has(name));

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
                  canUndo=${canUndo} canRedo=${canRedo} onUndo=${undo} onRedo=${redo}
                  notesVisible=${notesVisible} onToggleNotesVisible=${toggleNotesVisible}
                  numberedBullets=${numberedBullets} onToggleNumberedBullets=${toggleNumberedBullets}
                  verticalLines=${verticalLines} onToggleVerticalLines=${toggleVerticalLines}
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
                  onOpenTextSearch=${() => setShowTextSearch(true)}
                  canGoBack=${canGoBack} canGoForward=${canGoForward}
                  onGoBack=${goBack} onGoForward=${goForward} />
      ${showHelp && html`<${CommandPalette} commands=${buildCommands({
          undo, redo, canUndo, canRedo,
          goBack, goForward, canGoBack, canGoForward,
          toggleTheme, toggleTitleFormatMode, toggleTextMode,
          toggleNotesVisible, notesVisible,
          toggleNumberedBullets, numberedBullets,
          toggleVerticalLines, verticalLines,
          toggleReadingWidth, readingWidth,
          toggleSidebar, sidebarVisible,
          toggleHoist, isHoisted,
          toggleTagPanel, tagPanelVisible,
          toggleBookmarkPanel, bookmarkPanelVisible,
          foldToLevel,
          setView, view,
          setShowPicker, setShowTextSearch, setShowFolderPicker,
          setShowHelp,
        })} onClose=${() => setShowHelp(false)} />`}
      ${showFolderPicker && html`
        <${FolderPicker}
          initialPath=${homeDir || "/"}
          onSelect=${changeHomeDir}
          onCancel=${() => setShowFolderPicker(false)} />
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
          onCancel=${() => setShowLinkPicker(false)} />
      `}
      <div className="app-layout">
        ${sidebarVisible && html`
          <${Sidebar} favorites=${validFavorites} recentFiles=${validRecentFiles} currentFile=${currentFile}
            onSelect=${loadFile} onToggleFavorite=${toggleFavorite}
            bookmarks=${fileOnlyBookmarks}
            onNavigateToBookmark=${navigateToBookmark}
            onDeleteBookmark=${deleteBookmark}
            onReorderBookmarks=${updateBookmarkOrder} />
        `}
        ${bookmarkPanelVisible && !textMode && html`
          <${BookmarkPanel} globalBMs=${globalBMs}
            onUpdateBMs=${updateGlobalBMs}
            onNestBM=${nestBM}
            onAddBMToItem=${addBMToItem}
            onEditBookmarkFile=${openBookmarkFile}
            width=${bookmarkPanelWidth}
            onWidthChange=${setBookmarkPanelWidthPersisted} />
        `}
        ${bookmarkPanelVisible && !textMode && html`
          <${ItemBookmarkPane} node=${focusedNode} dispatch=${dispatch} onAddToGlobalBMs=${addToGlobalBMs} />
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
          <div className="outline-pane">
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
                  numberedBullets=${numberedBullets} siblingIndex=${i + 1}
                  verticalLines=${verticalLines}
                  bodyEditingId=${bodyEditingId} bodyRefs=${bodyRefs} />
              `)}
            </div>
          </div>
        `}
        ${view === "agenda" && html`
          <div className="outline-pane">
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              <${AgendaView} nodes=${nodes} onSelect=${handleAgendaSelect} searchQuery=${searchQuery} selectedTags=${selectedTags} />
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
        ${view === "search" && searchResults && html`
          <div className="outline-pane">
            <div className=${"outline-content" + (readingWidth ? " reading-width" : "")}>
              <div className="tag-search-header">
                <button className="tag-search-back" onClick=${() => setView("outline")}>← Back</button>
                <span className="tag-search-title-label">
                  ${searchResults.type === "tag"
                    ? html`Tag search: <code>:${searchResults.query}:</code>`
                    : html`Text search: <code>${searchResults.query}</code>`}
                  ${searchResults.results !== null ? html` — ${searchResults.results.length} result${searchResults.results.length === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              ${searchResults.results === null ? html`
                <div className="tag-search-loading">Searching…</div>
              ` : searchResults.results.length === 0 ? html`
                <div className="tag-search-empty">
                  ${searchResults.type === "tag"
                    ? html`No nodes tagged <code>:${searchResults.query}:</code> found in any org file.`
                    : html`No matches for <code>${searchResults.query}</code> found in any org file.`}
                </div>
              ` : searchResults.results.map((r, i) => html`
                <div key=${i}
                     className=${"tag-search-result" + (r.inSubdir ? " tag-search-result-subdir" : "")}
                     onClick=${r.inSubdir ? undefined : async () => {
                       pendingTagNavRef.current = { file: r.file, title: r.title };
                       await loadFile(r.file);
                       setView("outline");
                     }}>
                  <div className="tag-search-result-file">
                    ${r.file}
                    ${r.inSubdir && html`<span className="tag-search-result-subdir-badge" title="In subdirectory — open manually">subfolder</span>`}
                  </div>
                  <div className="tag-search-result-title">${r.title}</div>
                  ${r.context && html`<div className="tag-search-result-context">${r.context}</div>`}
                  ${r.tags && r.tags.length > 0 && html`<div className="tag-search-result-tags">${r.tags.map((t) => html`<span key=${t} className="tag-search-result-tag">:${t}:</span>`)}</div>`}
                </div>
              `)}
            </div>
          </div>
        `}
        ${tagPanelVisible && !textMode && html`
          <${NodeTagsPane} node=${focusedNode} dispatch=${dispatch} onAddToGlobalTags=${addToGlobalTags} />
        `}
        ${tagPanelVisible && !textMode && html`
          <${TagPanel} globalTags=${globalTags}
            onUpdateTags=${updateGlobalTags}
            onNestTag=${nestTag}
            onAddTagToItem=${addTagToItem}
            onEditTagFile=${openTagFile}
            selectedTags=${selectedTags}
            onToggleTag=${toggleTag}
            onClearTags=${clearTags}
            width=${tagPanelWidth}
            onWidthChange=${setTagPanelWidthPersisted}
            onSearch=${searchTag} />
        `}
        <${DetailPane} ref=${detailPaneRef} key=${detailKey} node=${detailNode} isPreamble=${isPreambleFocused}
          dispatch=${dispatch} inputRefs=${inputRefs}
          width=${detailWidth} visible=${detailVisible}
          onWidthChange=${setDetailWidthPersisted}
          onOpen=${() => setDetailVisiblePersisted(true)}
          titleFormatMode=${titleFormatMode}
          globalTags=${globalTags} />
      </div>
    </div>
  `;
}

const FOLD_LEVELS = [1, 2, 3, 4];

// --- Toolbar icons ---
// Inline SVG (not emoji/icon-font glyphs) so they render identically on
// every machine regardless of installed system fonts. They inherit
// currentColor, so active/hover/dark-mode styling all come for free from
// the surrounding button's CSS.

const ICON_PROPS = { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" };

const TOPBAR_COLORS = { green: "#166534", blue: "#3d72a8", red: "#991b1b" };

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
  return html`<svg ...${ICON_PROPS}><polyline points="15 18 9 12 15 6"/></svg>`;
}
function IconNavForward() {
  return html`<svg ...${ICON_PROPS}><polyline points="9 18 15 12 9 6"/></svg>`;
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
    <svg ...${ICON_PROPS}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  `;
}

function IconRedo() {
  return html`
    <svg ...${ICON_PROPS}>
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

function IconFormatted() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24">
      <text x="12" y="17" fontSize="13" fontWeight="700" textAnchor="middle" fill="currentColor">Aa</text>
    </svg>
  `;
}

function IconTextMode() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24">
      <text x="12" y="17" fontSize="15" fontWeight="700" textAnchor="middle" fill="currentColor">T</text>
    </svg>
  `;
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

// File link picker — triggered by typing [[ in a node title or body.
// Shows a filterable list of org files; selecting one inserts an org link.
function FileLinkPicker({ files, onSelect, onCancel }) {
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

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); if (filtered[highlighted]) select(filtered[highlighted].name); return; }
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
            ${filtered.length === 0 ? html`
              <div className="file-link-empty">No files match "${filter}"</div>
            ` : filtered.map((f, i) => html`
              <div key=${f.name}
                   className=${"file-link-item" + (i === highlighted ? " highlighted" : "")}
                   onClick=${() => select(f.name)}
                   onMouseEnter=${() => setHighlighted(i)}>
                <span className="file-link-filename">${f.name.replace(/\.org$/, "")}</span>
                <span className="file-link-ext">.org</span>
              </div>
            `)}
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

// A general options menu, extensible as more entries get added — for now
// just the one, toggling numbered outline bullets (Dynalist-style).
function HamburgerMenu({
  numberedBullets, onToggleNumberedBullets, verticalLines, onToggleVerticalLines,
  // Everything below is only rendered when `collapsed` — Header measured
  // that the toolbar/search/etc. don't fit and rendered them away, so
  // their controls are reachable from here instead. On an uncollapsed
  // header those are already toolbar buttons, so this stays unused there.
  collapsed,
  view, setView, titleFormatMode, onToggleTitleFormat, textMode, onToggleTextMode,
  notesVisible, onToggleNotesVisible, isHoisted, canToggleHoist, onToggleHoist,
  readingWidth, onToggleReadingWidth, onFoldToLevel,
  searchQuery, setSearchQuery, allTags, selectedTags, onToggleTag,
  theme, onToggleTheme, onHelp, syncStatus,
  topBarColor, onSetTopBarColor,
  homeDir, onPickHomeDir,
}) {
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

  return html`
    <div className=${"hamburger-menu" + (collapsed ? " collapsed" : "")} ref=${containerRef}>
      <button className=${"panel-toggle-btn" + (open ? " active" : "")} onClick=${() => setOpen((o) => !o)} title="More options">
        <${IconHamburger} />
      </button>
      ${open && html`
        <div className="hamburger-menu-popup">
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${numberedBullets} onChange=${onToggleNumberedBullets} disabled=${textMode} />
            <span>Toggle numbering for all outline bullets</span>
          </label>
          <label className="hamburger-menu-option">
            <input type="checkbox" checked=${verticalLines} onChange=${onToggleVerticalLines} disabled=${textMode} />
            <span>Toggle vertical lines</span>
          </label>

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
            </div>
          </div>

          <div className="hamburger-menu-option hamburger-homefolder-row">
            <span>Home Folder</span>
            <button className="homefolder-path-btn" title="Click to change home folder" onClick=${onPickHomeDir}>
              ${homeDir || "…"}
            </button>
          </div>

          ${collapsed && html`
          <div className="hamburger-mobile-only">
            <div className="hamburger-mobile-section">
              <div className="hamburger-segmented">
                <button className=${"hamburger-segmented-btn" + (view === "outline" ? " active" : "")}
                        onClick=${() => setView("outline")}><${IconOutline} /> Outline</button>
                <button className=${"hamburger-segmented-btn" + (view === "agenda" ? " active" : "")}
                        onClick=${() => setView("agenda")}><${IconAgenda} /> Agenda</button>
                <button className=${"hamburger-segmented-btn" + (view === "todo" ? " active" : "")}
                        onClick=${() => setView("todo")}><${IconTodo} /> TODO</button>
              </div>
            </div>

            ${view === "outline" && html`
              <div className="hamburger-mobile-section">
                <label className="hamburger-menu-option">
                  <input type="checkbox" checked=${titleFormatMode} onChange=${onToggleTitleFormat} disabled=${textMode} />
                  <span>Formatted text</span>
                </label>
                <label className="hamburger-menu-option">
                  <input type="checkbox" checked=${textMode} onChange=${onToggleTextMode} />
                  <span>Text mode (raw org source)</span>
                </label>
                ${!textMode && html`
                  <label className="hamburger-menu-option">
                    <input type="checkbox" checked=${notesVisible} onChange=${onToggleNotesVisible} />
                    <span>Show notes inline</span>
                  </label>
                  <label className="hamburger-menu-option">
                    <input type="checkbox" checked=${isHoisted} onChange=${onToggleHoist} disabled=${!canToggleHoist} />
                    <span>Hoist (isolate focused item)</span>
                  </label>
                `}
              </div>
            `}

            <div className="hamburger-mobile-section">
              <label className="hamburger-menu-option">
                <input type="checkbox" checked=${readingWidth} onChange=${onToggleReadingWidth} />
                <span>Reading width</span>
              </label>
            </div>

            ${view === "outline" && !textMode && html`
              <div className="hamburger-mobile-section">
                <div className="hamburger-mobile-row">
                  <span>Fold to level</span>
                  <span>
                    ${FOLD_LEVELS.map((lvl) => html`
                      <button key=${lvl} onClick=${() => { onFoldToLevel(lvl); setOpen(false); }}>${lvl}</button>
                    `)}
                  </span>
                </div>
              </div>
            `}

            ${!textMode && html`
              <div className="hamburger-mobile-section hamburger-mobile-search">
                <input type="text" placeholder="Filter…" value=${searchQuery || ""}
                       onChange=${(e) => setSearchQuery(e.target.value)} />
              </div>
            `}

            ${!textMode && allTags.length > 0 && html`
              <div className="hamburger-mobile-section">
                ${allTags.map((tag) => html`
                  <label className="hamburger-menu-option" key=${tag}>
                    <input type="checkbox" checked=${selectedTags.includes(tag)} onChange=${() => onToggleTag(tag)} />
                    <span>#${tag}</span>
                  </label>
                `)}
              </div>
            `}

            <div className="hamburger-mobile-section">
              <label className="hamburger-menu-option">
                <input type="checkbox" checked=${theme === "dark"} onChange=${onToggleTheme} />
                <span>Dark mode</span>
              </label>
              <div className="hamburger-mobile-row">
                <span>${SYNC_LABELS[syncStatus] || syncStatus}</span>
                <button onClick=${() => { onHelp(); setOpen(false); }}>Help</button>
              </div>
            </div>
          </div>
          `}
        </div>
      `}
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

function Header({ onHelp, syncStatus, view, setView, currentFile, onBack, searchQuery, setSearchQuery, searchInputRef, allTags, selectedTags, onToggleTag, onClearTags, detailVisible, onToggleDetails, tagPanelVisible, onToggleTagPanel, bookmarkPanelVisible, onToggleBookmarkPanel, titleFormatMode, onToggleTitleFormat, textMode, onToggleTextMode, textModeError, notesVisible, onToggleNotesVisible, numberedBullets, onToggleNumberedBullets, verticalLines, onToggleVerticalLines, isHoisted, canToggleHoist, onToggleHoist, readingWidth, onToggleReadingWidth, sidebarVisible, onToggleSidebar, onFoldToLevel, theme, onToggleTheme, topBarColor, onSetTopBarColor, canUndo, canRedo, onUndo, onRedo, homeDir, onPickHomeDir, onOpenTextSearch, canGoBack, canGoForward, onGoBack, onGoForward }) {
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
  const headerRef = useRef(null);
  const probeRef = useRef(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const probe = probeRef.current;
    if (!header || !probe || typeof ResizeObserver === "undefined") return;
    const check = () => setCollapsed(probe.scrollWidth > header.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(header);
    ro.observe(probe);
    return () => ro.disconnect();
  }, []);

  function renderInner(expanded) {
    const showFull = expanded || !collapsed;
    return html`
      ${currentFile && html`
        <div className="header-left-icons">
          <button className=${"panel-toggle-btn" + (sidebarVisible ? " active" : "")}
                  onClick=${onToggleSidebar}
                  title="Toggle Favorites / Recent Files sidebar"><${IconSidebar} /></button>
          ${!textMode && html`
            <button className=${"panel-toggle-btn" + (bookmarkPanelVisible ? " active" : "")}
                    onClick=${onToggleBookmarkPanel}
                    title=${bookmarkPanelVisible ? "Close bookmark panel" : "Open bookmark panel"}>
              <${IconBookmark} />
            </button>
          `}
        </div>
      `}
      <div className="header-left">
        <h1>Epicorg</h1>
        ${currentFile && html`
          <button className="file-back-btn" onClick=${onBack} title="Switch file">
            ${currentFile}
          </button>
        `}
      </div>
      ${currentFile && showFull && html`
        <div className="toolbar">
          ${view === "outline" && !textMode && html`
            <div className="view-toggle">
              ${FOLD_LEVELS.map((lvl) => html`
                <button key=${lvl} className="view-tab"
                        onClick=${() => onFoldToLevel(lvl)}
                        title=${"Fold to level " + lvl + " (Alt+" + lvl + ")"}>${lvl}</button>
              `)}
            </div>
            <div className="view-toggle">
              <button className=${"view-tab" + (notesVisible ? " active" : "")}
                      onClick=${onToggleNotesVisible}
                      title=${notesVisible ? "Hide notes" : "Show notes inline"}><${IconNotes} /></button>
              <button className=${"view-tab" + (isHoisted ? " active" : "")}
                      onClick=${onToggleHoist} disabled=${!canToggleHoist}
                      title=${isHoisted ? "Show full outline again" : "Hoist — isolate the focused item and its children"}>
                ${isHoisted ? html`<${IconHoistOn} />` : html`<${IconHoistOff} />`}
              </button>
            </div>
          `}
          <div className="view-toggle">
            <button className="view-tab" onClick=${onGoBack} disabled=${!canGoBack}
                    title="Go back (Alt+←)"><${IconNavBack} /></button>
            <button className="view-tab" onClick=${onGoForward} disabled=${!canGoForward}
                    title="Go forward (Alt+→)"><${IconNavForward} /></button>
          </div>
          <div className="view-toggle">
            <button className="view-tab" onClick=${onUndo} disabled=${!canUndo || textMode}
                    title=${textMode ? "Not available in text mode" : "Undo (Ctrl+Z)"}><${IconUndo} /></button>
            <button className="view-tab" onClick=${onRedo} disabled=${!canRedo || textMode}
                    title=${textMode ? "Not available in text mode" : "Redo (Ctrl+Shift+Z)"}><${IconRedo} /></button>
          </div>
          <div className="view-toggle">
            <button className=${"view-tab" + (view === "outline" ? " active" : "")}
                    onClick=${() => setView("outline")} title="Outline view"><${IconOutline} /></button>
            <button className=${"view-tab" + (view === "agenda" ? " active" : "")}
                    onClick=${() => setView("agenda")} title="Agenda view"><${IconAgenda} /></button>
            <button className=${"view-tab" + (view === "todo" ? " active" : "")}
                    onClick=${() => setView("todo")} title="TODO list"><${IconTodo} /></button>
          </div>
          ${view === "outline" && html`
            <div className="view-toggle">
              <button className=${"view-tab" + (titleFormatMode ? " active" : "")}
                      onClick=${onToggleTitleFormat} disabled=${textMode}
                      title=${textMode ? "Not available in text mode" : titleFormatMode ? "Showing formatted titles — click a title to edit it" : "Show *bold*, /italic/, etc. as formatted text"}><${IconFormatted} /></button>
              <button className=${"view-tab" + (textMode ? " active" : "")}
                      onClick=${onToggleTextMode}
                      title=${textMode
                        ? "Exit text mode — reparse and return to the outline"
                        : "Text mode — edit the raw org text directly, including heading asterisks, tags, and properties"}><${IconTextMode} /></button>
            </div>
            ${textModeError && html`<span className="text-mode-error" title="Couldn't switch modes — see console">Error</span>`}
          `}
          ${!textMode && html`
            <div className="view-toggle">
              <button className=${"view-tab" + (readingWidth ? " active" : "")}
                      onClick=${onToggleReadingWidth}
                      title=${readingWidth ? "Showing reading width — click for full width" : "Center content in a narrower reading column"}><${IconWidth} /></button>
            </div>
          `}
        </div>
      `}
      ${currentFile && showFull && !textMode && html`
        <div className="search-box">
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
        <button className="global-search-btn" title="Search all files (Ctrl+Shift+F)" onClick=${onOpenTextSearch}>
          <${IconSearch} />
        </button>
      `}
      <div className="header-right">
        ${currentFile && html`
          <${HamburgerMenu} numberedBullets=${numberedBullets} onToggleNumberedBullets=${onToggleNumberedBullets}
            verticalLines=${verticalLines} onToggleVerticalLines=${onToggleVerticalLines}
            collapsed=${collapsed}
            view=${view} setView=${setView}
            titleFormatMode=${titleFormatMode} onToggleTitleFormat=${onToggleTitleFormat}
            textMode=${textMode} onToggleTextMode=${onToggleTextMode}
            notesVisible=${notesVisible} onToggleNotesVisible=${onToggleNotesVisible}
            isHoisted=${isHoisted} canToggleHoist=${canToggleHoist} onToggleHoist=${onToggleHoist}
            readingWidth=${readingWidth} onToggleReadingWidth=${onToggleReadingWidth}
            onFoldToLevel=${onFoldToLevel}
            searchQuery=${searchQuery} setSearchQuery=${setSearchQuery}
            allTags=${allTags} selectedTags=${selectedTags} onToggleTag=${onToggleTag}
            theme=${theme} onToggleTheme=${onToggleTheme} onHelp=${onHelp} syncStatus=${syncStatus}
            topBarColor=${topBarColor} onSetTopBarColor=${onSetTopBarColor}
            homeDir=${homeDir} onPickHomeDir=${onPickHomeDir} />
        `}
        ${(!currentFile || showFull) && html`
          <${SyncIndicator} status=${syncStatus} />
          <button className="theme-toggle-btn" onClick=${onToggleTheme}
                  title=${theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            ${theme === "dark" ? html`<${IconSun}/>` : html`<${IconMoon}/>`}
          </button>
          <button className="help-btn" onClick=${onHelp} title="Keyboard shortcuts (Ctrl+H)">?</button>
        `}
        ${currentFile && !textMode && html`
          <button className=${"panel-toggle-btn" + (tagPanelVisible ? " active" : "") + (selectedTags.length > 0 ? " has-filter" : "")}
                  onClick=${onToggleTagPanel}
                  title=${tagPanelVisible ? "Close tag panel" : "Open tag panel"}>
            <${IconTag} />
            ${selectedTags.length > 0 && html`<span className="tag-filter-count">${selectedTags.length}</span>`}
          </button>
        `}
        ${currentFile && html`
          <button className=${"detail-toggle-btn" + (detailVisible ? " active" : "")}
                  onClick=${onToggleDetails}
                  title="Toggle details pane"><${IconDetails} /></button>
        `}
      </div>
    `;
  }

  const headerBg = topBarColor ? TOPBAR_COLORS[topBarColor] : null;
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
    toggleTheme, toggleTitleFormatMode, toggleTextMode,
    toggleNotesVisible, notesVisible,
    toggleNumberedBullets, numberedBullets,
    toggleVerticalLines, verticalLines,
    toggleReadingWidth, readingWidth,
    toggleSidebar, sidebarVisible,
    toggleHoist, isHoisted,
    toggleTagPanel, tagPanelVisible,
    toggleBookmarkPanel, bookmarkPanelVisible,
    foldToLevel,
    setView, view,
    setShowPicker, setShowTextSearch, setShowFolderPicker, setShowHelp,
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
    { category: "View", label: "Toggle Numbered Bullets",  desc: numberedBullets ? "Switch to dot bullets" : "Switch to numbered bullets", keys: "", action: toggleNumberedBullets },
    // Fold
    { category: "Folding", label: "Fold to Level 1",      desc: "Collapse all but top level",     keys: "Alt+1",         action: () => foldToLevel(1) },
    { category: "Folding", label: "Fold to Level 2",      desc: "Expand to level 2",              keys: "Alt+2",         action: () => foldToLevel(2) },
    { category: "Folding", label: "Fold to Level 3",      desc: "Expand to level 3",              keys: "Alt+3",         action: () => foldToLevel(3) },
    { category: "Folding", label: "Fold to Level 4",      desc: "Expand to level 4",              keys: "Alt+4",         action: () => foldToLevel(4) },
    { category: "Folding", label: "Expand All",           desc: "Unfold everything",              keys: "Alt+9",         action: () => foldToLevel(9) },
    // Edit
    { category: "Edit", label: "Undo",                    desc: "Undo last change",               keys: "Ctrl+Z",        action: undo,      disabled: !canUndo },
    { category: "Edit", label: "Redo",                    desc: "Redo last undone change",        keys: "Ctrl+Shift+Z",  action: redo,      disabled: !canRedo },
    { category: "Edit", label: "Hoist / Unhoist",         desc: isHoisted ? "Unhoist — show full tree" : "Hoist focused item", keys: "", action: toggleHoist },
    // Search
    { category: "Search", label: "Full-text Search…",    desc: "Search across all org files",    keys: "Ctrl+Shift+F",  action: () => setShowTextSearch(true) },
    // Settings
    { category: "Settings", label: "Toggle Dark/Light Theme", desc: "Switch colour theme",       keys: "",              action: toggleTheme },
    { category: "Settings", label: "Toggle Rich/Plain Titles", desc: "Switch title format mode", keys: "",              action: toggleTitleFormatMode },
    { category: "Settings", label: "Toggle Text Mode",    desc: "Edit raw org text",              keys: "",              action: toggleTextMode },
    { category: "Settings", label: "Change Home Folder…", desc: "Pick a new home org folder",    keys: "",              action: () => setShowFolderPicker(true) },
    // Help
    { category: "Help", label: "Keyboard Shortcuts",      desc: "Show this command palette",      keys: "Ctrl+H",        action: () => setShowHelp(true) },
  ].filter((c) => !c.disabled);
}

function CommandPalette({ commands, onClose }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

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

  useEffect(() => { setHighlighted(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[highlighted];
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const run = (cmd) => {
    onClose();
    cmd.action();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter")     { e.preventDefault(); if (filtered[highlighted]) run(filtered[highlighted]); }
  };

  // Group by category for display when not filtering
  const grouped = useMemo(() => {
    if (query.trim()) return null; // flat list when searching
    const map = {};
    for (const c of filtered) {
      const cat = c.category || "Other";
      if (!map[cat]) map[cat] = [];
      map[cat].push(c);
    }
    return map;
  }, [filtered, query]);

  // Flat index \u2192 command mapping (needed for highlight tracking across groups)
  const flatFiltered = filtered;

  return html`
    <div className="cp-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp-dialog">
        <div className="cp-input-row">
          <svg className="cp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input ref=${inputRef} className="cp-input" type="text"
                 placeholder="Search commands\u2026"
                 value=${query} onInput=${(e) => setQuery(e.target.value)}
                 onKeyDown=${onKeyDown} />
          <button className="cp-close" onClick=${onClose}>\u00D7</button>
        </div>
        <div ref=${listRef} className="cp-list">
          ${flatFiltered.length === 0 && html`
            <div className="cp-empty">No commands match "${query}"</div>
          `}
          ${grouped
            ? Object.entries(grouped).map(([cat, cmds]) => html`
                <div key=${cat} className="cp-group">
                  <div className="cp-group-label">${cat}</div>
                  ${cmds.map((cmd) => {
                    const idx = flatFiltered.indexOf(cmd);
                    return html`
                      <div key=${cmd.label}
                           className=${"cp-item" + (idx === highlighted ? " highlighted" : "")}
                           onMouseEnter=${() => setHighlighted(idx)}
                           onMouseDown=${(e) => { e.preventDefault(); run(cmd); }}>
                        <span className="cp-item-label">${cmd.label}</span>
                        ${cmd.keys && html`<span className="cp-item-keys">${cmd.keys}</span>`}
                      </div>
                    `;
                  })}
                </div>
              `)
            : flatFiltered.map((cmd, idx) => html`
                <div key=${cmd.label}
                     className=${"cp-item" + (idx === highlighted ? " highlighted" : "")}
                     onMouseEnter=${() => setHighlighted(idx)}
                     onMouseDown=${(e) => { e.preventDefault(); run(cmd); }}>
                  <div className="cp-item-left">
                    <span className="cp-item-label">${cmd.label}</span>
                    <span className="cp-item-desc">${cmd.desc}</span>
                  </div>
                  ${cmd.keys && html`<span className="cp-item-keys">${cmd.keys}</span>`}
                </div>
              `)
          }
        </div>
        <div className="cp-footer">
          <span>\u2191\u2193 navigate</span><span>\u21B5 run</span><span>Esc close</span>
        </div>
      </div>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
