import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import * as tree from "./tree.js";

const html = htm.bind(React.createElement);

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
};

// --- Agenda helpers ---

function collectDatedItems(nodes, ancestors = []) {
  const items = [];
  for (const n of nodes) {
    const raw = n.properties?.DEADLINE;
    const date = tree.parseOrgDate(raw);
    if (date) {
      items.push({ id: n.id, title: n.title, date, status: n.status, ancestors });
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

function PreambleRow({ focused, dispatch, inputRefs }) {
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
      <span className="preamble-label">Preamble</span>
    </div>
  `;
}

function OutlineNode({ node, focusedId, dispatch, inputRefs, depth }) {
  const isFocused = focusedId === node.id;
  const hasChildren = node.children?.length > 0;
  const titleRef = useRef(null);

  useEffect(() => {
    const ta = titleRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [node.title]);

  useEffect(() => {
    const ta = titleRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);

  return html`
    <div>
      <div className=${"node-row" + (isFocused ? " focused" : "")}>
        <span style=${{ width: depth * 24, flexShrink: 0 }} />
        <span className=${"bullet" + (hasChildren ? " has-children" : "")}
              onMouseDown=${(e) => {
                e.preventDefault();
                if (hasChildren) dispatch(node.id, "toggle");
              }}>
          ${hasChildren ? (node.collapsed ? "\u25B6" : "\u25BC") : "\u2022"}
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
        <textarea
          rows=${1}
          ref=${(el) => { titleRef.current = el; if (el) inputRefs.current[node.id] = el; }}
          className=${"node-title" + (node.status === "DONE" ? " done" : "")}
          value=${node.title}
          placeholder=""
          onFocus=${() => dispatch(node.id, "focus")}
          onKeyDown=${(e) => handleKey(e, node.id, dispatch)}
          onChange=${(e) => dispatch(node.id, "change", e.target.value)}
        />
      </div>
      ${hasChildren && !node.collapsed && node.children.map(
        (child) => html`
          <${OutlineNode}
            key=${child.id}
            node=${child}
            focusedId=${focusedId}
            dispatch=${dispatch}
            inputRefs=${inputRefs}
            depth=${depth + 1}
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

const DETAIL_MIN_WIDTH = 220;
const DETAIL_MAX_WIDTH_RATIO = 0.70;
const DETAIL_CLOSED_WIDTH = 14;

function DetailPane({ node, isPreamble, dispatch, inputRefs, bodyTextareaRef, width, visible, pinned, onWidthChange, onTogglePin, onOpen }) {
  const [bodyText, setBodyText] = useState(isPreamble ? (node?.body || "") : (node?.body || ""));
  const localRef = useRef(null);

  useEffect(() => {
    const ta = localRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
  }, [bodyText]);

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

  const hasTarget = !!node || isPreamble;
  const header = isPreamble ? "Preamble" : (node?.title || (hasTarget ? "Untitled" : "No selection"));
  const inner = html`
    <div className="detail-header">
      <span className="detail-title">${header}</span>
      <button className=${"detail-pin" + (pinned ? " pinned" : "")}
              onMouseDown=${(e) => e.preventDefault()}
              onClick=${onTogglePin}
              title=${pinned ? "Unpin (Esc closes pane)" : "Pin to keep open"}
              aria-label=${pinned ? "Unpin pane" : "Pin pane open"}>
        \u{1F4CC}
      </button>
    </div>
    <div className="detail-section">
      <label className="detail-label">${isPreamble ? "Content" : "Body"}</label>
      <textarea
        ref=${(el) => { localRef.current = el; if (bodyTextareaRef) bodyTextareaRef.current = el; }}
        className="detail-body"
        value=${hasTarget ? bodyText : ""}
        disabled=${!hasTarget}
        placeholder=${!hasTarget ? "Select an item to see details" : (isPreamble ? "File header, #+TITLE, etc..." : "Add notes...")}
        onChange=${(e) => {
          if (!hasTarget) return;
          setBodyText(e.target.value);
          if (isPreamble) dispatch("preamble", "change-preamble", e.target.value);
          else dispatch(node.id, "change-body", e.target.value);
        }}
        onKeyDown=${(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            dispatch(isPreamble ? "preamble" : node?.id, "focus-outline");
          }
        }}
      />
    </div>
    ${!isPreamble && html`
      <div className="detail-section">
        <label className="detail-label">Due date</label>
        <input type="date" className="detail-date"
          value=${node ? tree.parseOrgDate(node.properties?.DEADLINE) : ""}
          disabled=${!node}
          onChange=${(e) => {
            if (!node) return;
            const updated = { ...(node.properties || {}) };
            if (e.target.value) updated.DEADLINE = tree.formatOrgDate(e.target.value);
            else delete updated.DEADLINE;
            dispatch(node.id, "update-properties", updated);
          }} />
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
}

function AgendaView({ nodes, onSelect, searchQuery }) {
  let items = collectDatedItems(nodes);
  if (searchQuery) items = items.filter((item) => tree.fuzzyMatch(searchQuery, item.title));
  items.sort((a, b) => a.date.localeCompare(b.date));

  if (items.length === 0) {
    return html`<div className="agenda-empty">${searchQuery ? "No matches" : "No items with due dates"}</div>`;
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
            <div className="agenda-item" key=${item.id} onClick=${() => onSelect(item.id)}>
              <span className="agenda-item-title">${item.title || "Untitled"}</span>
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

function handleKey(e, id, dispatch) {
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

function SyncIndicator({ status }) {
  const labels = {
    [SYNC_SAVED]: "Saved", [SYNC_DIRTY]: "Unsaved changes",
    [SYNC_SAVING]: "Saving\u2026", [SYNC_ERROR]: "Save failed",
    [SYNC_CONFLICT]: "Conflict \u2014 reload",
  };
  return html`<span className=${"sync-indicator sync-" + status}>${labels[status] || ""}</span>`;
}

// --- File Picker ---

function FilePicker({ files, onSelect, onCreate }) {
  const [newName, setNewName] = useState("");

  return html`
    <div className="file-picker">
      <h2>Choose a file</h2>
      <div className="file-list">
        ${files.map((f) => html`
          <div className="file-item" key=${f} onClick=${() => onSelect(f)}>
            <span className="file-icon">\u{1F4C4}</span>
            <span>${f}</span>
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

// --- App ---

function App() {
  const [files, setFiles] = useState(null);
  const [currentFile, setCurrentFile] = useState(null);
  const [nodes, setNodes] = useState(null);
  const [preamble, setPreamble] = useState("");
  const [hash, setHash] = useState("");
  const [focusedId, setFocusedId] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [syncStatus, setSyncStatus] = useState(SYNC_SAVED);
  const [view, setView] = useState("outline");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const [detailWidth, setDetailWidth] = useState(() => {
    try {
      const stored = parseInt(localStorage.getItem("torg.detailWidth"), 10);
      if (Number.isFinite(stored) && stored > 0) return stored;
    } catch {}
    return Math.round(window.innerWidth * 0.20);
  });
  const [detailPinned, setDetailPinned] = useState(() => {
    try { return localStorage.getItem("torg.detailPinned") === "1"; } catch { return false; }
  });
  const [detailVisible, setDetailVisible] = useState(() => {
    try { return localStorage.getItem("torg.detailPinned") === "1"; } catch { return false; }
  });
  const detailPinnedRef = useRef(detailPinned);
  useEffect(() => { detailPinnedRef.current = detailPinned; }, [detailPinned]);
  const setDetailWidthPersisted = useCallback((w) => {
    setDetailWidth(w);
    try { localStorage.setItem("torg.detailWidth", String(w)); } catch {}
  }, []);
  const toggleDetailPinned = useCallback(() => {
    setDetailPinned((p) => {
      const next = !p;
      try { localStorage.setItem("torg.detailPinned", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const pendingFocusRef = useRef(null);
  const inputRefs = useRef({});
  const bodyTextareaRef = useRef(null);
  const dirtyRef = useRef(false);
  const nodesRef = useRef(null);
  const visibleNodesRef = useRef(null);
  const preambleRef = useRef("");
  const hashRef = useRef("");
  const currentFileRef = useRef(null);

  const visibleNodes = useMemo(
    () => searchQuery && nodes ? tree.filterTree(nodes, searchQuery) : nodes,
    [nodes, searchQuery]
  );

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { preambleRef.current = preamble; }, [preamble]);
  useEffect(() => { hashRef.current = hash; }, [hash]);
  useEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setSyncStatus(SYNC_DIRTY);
  }, []);

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
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        setNodes((prev) => prev ? tree.foldToLevel(prev, parseInt(e.key)) : prev);
        markDirty();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [markDirty]);

  // Focus effect
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id !== null) {
      pendingFocusRef.current = null;
      requestAnimationFrame(() => {
        const el = inputRefs.current[id];
        if (el) { el.focus(); if (el.setSelectionRange) el.selectionStart = el.selectionEnd = el.value?.length || 0; }
      });
    }
  });

  const focusedIdRef = useRef(focusedId);
  useEffect(() => { focusedIdRef.current = focusedId; }, [focusedId]);

  const focusNode = useCallback((id) => {
    if (focusedIdRef.current !== id && !detailPinnedRef.current) setDetailVisible(false);
    setFocusedId(id);
    pendingFocusRef.current = id;
  }, []);

  // Load file list on mount
  useEffect(() => {
    api.get("/api/files").then((data) => {
      const f = data.files || [];
      setFiles(f);
      if (f.length === 1) loadFile(f[0]);
    });
  }, []);

  const loadFile = useCallback(async (name) => {
    const data = await api.get("/api/doc/" + encodeURIComponent(name));
    setCurrentFile(name);
    setNodes(data.nodes || []);
    setPreamble(data.preamble || "");
    setHash(data.hash || "");
    dirtyRef.current = false;
    setSyncStatus(SYNC_SAVED);
    const flat = tree.flattenVisible(data.nodes || []);
    if (flat.length > 0) focusNode(flat[0].id);
  }, [focusNode]);

  const handleCreateFile = useCallback(async (name) => {
    if (!name.endsWith(".org")) name += ".org";
    await api.post("/api/files", { filename: name });
    const data = await api.get("/api/files");
    setFiles(data.files || []);
    loadFile(name);
  }, [loadFile]);

  // Background sync
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!dirtyRef.current || !nodesRef.current || !currentFileRef.current) return;
      dirtyRef.current = false;
      setSyncStatus(SYNC_SAVING);
      try {
        const result = await api.put("/api/doc/" + encodeURIComponent(currentFileRef.current), {
          hash: hashRef.current,
          preamble: preambleRef.current,
          nodes: nodesRef.current,
        });
        setHash(result.hash);
        hashRef.current = result.hash;
        if (result.conflict) {
          setSyncStatus(SYNC_CONFLICT);
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

  const handleAgendaSelect = useCallback((itemId) => {
    setView("outline");
    setNodes((prev) => tree.uncollapseToNode(prev, itemId));
    requestAnimationFrame(() => focusNode(itemId));
  }, [focusNode]);

  // Dispatch: all operations are local state mutations
  const dispatch = useCallback((nodeId, action, value) => {
    const navTree = visibleNodesRef.current || nodesRef.current || [];
    const flat = [{ id: "preamble" }, ...tree.flattenVisible(navTree)];
    const idx = flat.findIndex((n) => n.id === nodeId);

    if (action === "focus") {
      if (focusedIdRef.current !== nodeId && !detailPinnedRef.current) setDetailVisible(false);
      setFocusedId(nodeId);
      return;
    }

    if (action === "focus-outline") {
      setFocusedId(nodeId);
      if (!detailPinnedRef.current) setDetailVisible(false);
      requestAnimationFrame(() => {
        const el = inputRefs.current[nodeId];
        if (el) { el.focus(); if (el.setSelectionRange) el.selectionStart = el.selectionEnd = el.value?.length || 0; }
      });
      return;
    }

    if (action === "focus-body") {
      setDetailVisible(true);
      requestAnimationFrame(() => { if (bodyTextareaRef.current) bodyTextareaRef.current.focus(); });
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
  }, [focusNode, markDirty]);

  // Loading state
  if (files === null) return html`<div className="empty">Loading...</div>`;

  // File picker (no file selected)
  if (!currentFile) {
    return html`
      <div>
        <${Header} onHelp=${() => setShowHelp(true)} syncStatus=${syncStatus}
                    view=${view} setView=${setView} currentFile=${null} />
        <${FilePicker} files=${files} onSelect=${loadFile} onCreate=${handleCreateFile} />
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

  return html`
    <div>
      <${Header} onHelp=${() => setShowHelp(true)} syncStatus=${syncStatus}
                  view=${view} setView=${setView} currentFile=${currentFile}
                  searchQuery=${searchQuery} setSearchQuery=${setSearchQuery}
                  searchInputRef=${searchInputRef}
                  detailVisible=${detailVisible} detailPinned=${detailPinned}
                  onToggleDetails=${() => {
                    if (detailPinned) return;
                    setDetailVisible((v) => !v);
                  }}
                  onBack=${() => { setCurrentFile(null); setNodes(null); }} />
      ${showHelp && html`<${HelpPanel} onClose=${() => setShowHelp(false)} />`}
      <div className="app-layout">
        ${view === "outline" && html`
          <div className="outline-pane">
            ${!searchQuery && html`<${PreambleRow} focused=${isPreambleFocused} dispatch=${dispatch} inputRefs=${inputRefs} />`}
            ${visibleNodes.length === 0 ? html`
              <div className="empty" onClick=${() => {
                if (searchQuery) { setSearchQuery(""); return; }
                const nn = tree.newNode();
                setNodes([nn]); focusNode(nn.id); markDirty();
              }}>${searchQuery ? "No matches — click to clear search" : "Click or press any key to start"}</div>
            ` : visibleNodes.map((node) => html`
              <${OutlineNode} key=${node.id} node=${node} focusedId=${focusedId}
                dispatch=${dispatch} inputRefs=${inputRefs} depth=${0} />
            `)}
          </div>
        `}
        ${view === "agenda" && html`
          <div className="outline-pane">
            <${AgendaView} nodes=${nodes} onSelect=${handleAgendaSelect} searchQuery=${searchQuery} />
          </div>
        `}
        <${DetailPane} key=${detailKey} node=${detailNode} isPreamble=${isPreambleFocused}
          dispatch=${dispatch} inputRefs=${inputRefs} bodyTextareaRef=${bodyTextareaRef}
          width=${detailWidth} visible=${detailVisible} pinned=${detailPinned}
          onWidthChange=${setDetailWidthPersisted} onTogglePin=${toggleDetailPinned}
          onOpen=${() => setDetailVisible(true)} />
      </div>
    </div>
  `;
}

function Header({ onHelp, syncStatus, view, setView, currentFile, onBack, searchQuery, setSearchQuery, searchInputRef, detailVisible, detailPinned, onToggleDetails }) {
  return html`
    <header>
      <div className="header-left">
        <h1>torg</h1>
        ${currentFile && html`
          <button className="file-back-btn" onClick=${onBack} title="Switch file">
            ${currentFile}
          </button>
        `}
      </div>
      ${currentFile && html`
        <div className="toolbar">
          <div className="view-toggle">
            <button className=${"view-tab" + (view === "outline" ? " active" : "")}
                    onClick=${() => setView("outline")}>Outline</button>
            <button className=${"view-tab" + (view === "agenda" ? " active" : "")}
                    onClick=${() => setView("agenda")}>Agenda</button>
          </div>
          <div className="view-toggle">
            <button className=${"view-tab" + ((detailVisible || detailPinned) ? " active" : "")}
                    onClick=${onToggleDetails}
                    disabled=${detailPinned}
                    title=${detailPinned ? "Details pinned open — unpin in the pane to hide" : "Toggle details pane"}>Details</button>
          </div>
        </div>
      `}
      ${currentFile && html`
        <div className="search-box">
          <input
            ref=${searchInputRef}
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
      `}
      <div className="header-right">
        <${SyncIndicator} status=${syncStatus} />
        <button className="help-btn" onClick=${onHelp} title="Keyboard shortcuts (Ctrl+H)">?</button>
      </div>
    </header>
  `;
}

function HelpPanel({ onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return html`
    <div className="help-overlay" onClick=${onClose}>
      <div className="help-panel" onClick=${(e) => e.stopPropagation()}>
        <div className="help-header">
          <h2>Keyboard shortcuts</h2>
          <button className="help-close" onClick=${onClose}>\u00D7</button>
        </div>
        <div className="help-body">
          <${HelpSection} title="Navigation">
            <${HelpRow} keys="\u2191 / \u2193" desc="Move between items" />
            <${HelpRow} keys="Enter" desc="Create new item below" />
            <${HelpRow} keys="Shift + Enter" desc="Focus body / preamble" />
            <${HelpRow} keys="Escape" desc="Return to outline" />
            <${HelpRow} keys="Backspace" desc="Delete empty item" />
          <//>
          <${HelpSection} title="Structure">
            <${HelpRow} keys="Alt + \u2190" desc="Outdent (promote)" />
            <${HelpRow} keys="Alt + \u2192" desc="Indent (demote)" />
            <${HelpRow} keys="Alt + \u2191" desc="Move item up" />
            <${HelpRow} keys="Alt + \u2193" desc="Move item down" />
          <//>
          <${HelpSection} title="Folding">
            <${HelpRow} keys="Tab" desc="Fold / unfold children" />
            <${HelpRow} keys="Alt + 1\u20139" desc="Fold to level N" />
          <//>
          <${HelpSection} title="Other">
            <${HelpRow} keys="Ctrl + H" desc="Toggle this help" />
          <//>
        </div>
      </div>
    </div>
  `;
}

function HelpSection({ title, children }) {
  return html`<div className="help-section"><h3>${title}</h3><div className="help-rows">${children}</div></div>`;
}

function HelpRow({ keys, desc }) {
  return html`<div className="help-row"><span className="help-keys">${keys}</span><span className="help-desc">${desc}</span></div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
