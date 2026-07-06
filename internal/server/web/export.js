import { renderOrgInline } from "./tree.js";

// Convert org-mode inline markup to Markdown equivalents.
function orgToMdInline(text) {
  if (!text) return "";
  const LINK_RE = /\[\[([^\]]+)\]\[([^\]]*)\]\]|\[\[([^\]]+)\]\]/g;
  // Replace org links first so markup regex doesn't touch them.
  let out = text.replace(LINK_RE, (_, url1, label1, url2) => {
    const url = url1 !== undefined ? url1 : url2;
    const label = label1 || url;
    if (/^https?:/i.test(url)) return `[${label}](${url})`;
    if (/^file:/i.test(url)) return `[${label}](${url.replace(/^file:\/\//i, "").replace(/^file:/i, "")})`;
    return `[[${label}]]`; // wiki-links stay as-is in markdown
  });
  // Single-pass emphasis conversion (same order as MARKUP_RE in tree.js).
  out = out.replace(/\*([^\s*][^*]*?)\*/g, "**$1**");
  out = out.replace(/\/([^\s/][^/]*?)\//g, "*$1*");
  out = out.replace(/_([^\s_][^_]*?)_/g, "_$1_");
  out = out.replace(/=([^\s=][^=]*?)=/g, "`$1`");
  out = out.replace(/~([^\s~][^~]*?)~/g, "`$1`");
  out = out.replace(/\+([^\s+][^+]*?)\+/g, "~~$1~~");
  return out;
}

// Convert a node tree to GitHub-flavoured Markdown.
export function generateMarkdown(nodes, preamble, filename) {
  const lines = [];

  if (preamble && preamble.trim()) {
    lines.push(orgToMdInline(preamble.trim()));
    lines.push("");
  }

  function walkNodes(list, depth) {
    for (const node of list || []) {
      const hashes = "#".repeat(Math.min(depth, 6));
      let titleMd = orgToMdInline(node.title || "");

      // Status prefix
      if (node.status === "DONE" || node.status === "CANCELLED") {
        titleMd = `~~${titleMd}~~`;
      } else if (node.status) {
        titleMd = `\`${node.status}\` ${titleMd}`;
      }
      // Priority
      if (node.priority) titleMd = `[#${node.priority}] ${titleMd}`;

      lines.push(`${hashes} ${titleMd}`);

      // Scheduled / Deadline
      const sched = node.properties?.SCHEDULED;
      const dl = node.properties?.DEADLINE;
      if (sched || dl) {
        const parts = [];
        if (sched) parts.push(`📅 Scheduled: ${sched}`);
        if (dl) parts.push(`⏰ Deadline: ${dl}`);
        lines.push(`> ${parts.join("  ")}`);
        lines.push("");
      }

      // Tags
      if (node.tags && node.tags.length) {
        lines.push(`*Tags: ${node.tags.map((t) => `:${t}:`).join(" ")}*`);
        lines.push("");
      }

      // Body text
      if (node.body && node.body.trim()) {
        lines.push(orgToMdInline(node.body.trim()));
        lines.push("");
      }

      if (!sched && !dl && !(node.tags && node.tags.length) && !(node.body && node.body.trim())) {
        lines.push("");
      }

      walkNodes(node.children, depth + 1);
    }
  }

  walkNodes(nodes, 1);

  return lines.join("\n");
}

function toLetters(n, upper) {
  let result = "";
  while (n > 0) { result = String.fromCharCode((upper ? 65 : 97) + (n - 1) % 26) + result; n = Math.floor((n - 1) / 26); }
  return result + ".";
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectAllTags(nodes) {
  const tags = new Set();
  function walk(list) {
    for (const n of list || []) {
      for (const t of n.tags || []) tags.add(t);
      walk(n.children);
    }
  }
  walk(nodes);
  return [...tags].sort();
}

function renderNodesHtml(nodes, depth, outlineFormat, levelFormats) {
  let out = "";
  for (let i = 0; i < (nodes || []).length; i++) {
    const node = nodes[i];
    const siblingIndex = i + 1;
    const tags = (node.tags || []).join(",");
    const titleHtml = renderOrgInline(node.title || "");
    const bodyHtml = node.body ? renderOrgInline(node.body) : "";
    const status = node.status || "";
    const isDone = status === "DONE" || status === "CANCELLED";
    const tagChips = (node.tags || []).map(t =>
      `<span class="tc" onclick="setTag('${esc(t)}')" data-tag="${esc(t)}">${esc(t)}</span>`
    ).join("");

    const hasKids = node.children?.length > 0;
    const chId = `ch-${esc(node.id || "")}`;

    // depth is 1-based here; levelFormats keys are 0-based (matching app.js OutlineNode depth)
    const fmt = (levelFormats && levelFormats[depth - 1]) || outlineFormat || "bullets";
    const isIndexed = fmt === "numbers" || fmt === "letters" || fmt === "upper";
    const label = fmt === "letters" ? toLetters(siblingIndex) : fmt === "upper" ? toLetters(siblingIndex, true) : siblingIndex + ".";

    out += `<div class="ns" data-level="${depth}" data-tags="${esc(tags)}" id="n-${esc(node.id || "")}">`;
    out += `<div class="nh${isDone ? " done" : ""}">`;
    if (isIndexed) {
      if (hasKids) {
        out += `<span class="nb-caret tog" onclick="toggleNode(this,'${chId}')" title="Collapse">▼</span>`;
      } else {
        out += `<span class="nb-caret"></span>`;
      }
      out += `<span class="nb-idx">${esc(label)}</span>`;
    } else {
      if (hasKids) {
        out += `<span class="nb tog" onclick="toggleNode(this,'${chId}')" title="Collapse">▼</span>`;
      } else {
        out += `<span class="nb"></span>`;
      }
    }
    if (status) out += `<span class="sbadge s-${status.toLowerCase()}">${esc(status)}</span>`;
    out += `<span class="nt">${titleHtml}</span>`;
    if (tagChips) out += `<span class="tg">${tagChips}</span>`;
    out += `</div>`;

    if (node.body) {
      out += `<div class="nbody">${bodyHtml}</div>`;
    }

    if (hasKids) {
      out += `<div class="ch" id="${chId}">`;
      out += renderNodesHtml(node.children, depth + 1, outlineFormat, levelFormats);
      out += `</div>`;
    }

    out += `</div>`;
  }
  return out;
}

function buildNavHtml(nodes) {
  let out = "";
  for (const node of nodes || []) {
    const hasKids = node.children?.length > 0;
    const href = `#n-${esc(node.id || "")}`;
    const label = esc(node.title || "(untitled)");
    out += `<div class="ni">`;
    out += `<div class="ni-row">`;
    if (hasKids) {
      out += `<button class="ni-tog" onclick="navToggle(this)" title="Expand">▶</button>`;
    } else {
      out += `<span class="ni-leaf"></span>`;
    }
    out += `<a class="nl" href="${href}" onclick="navClick(event,this)">${label}</a>`;
    out += `</div>`;
    if (hasKids) {
      out += `<div class="ni-ch" hidden>${buildNavHtml(node.children)}</div>`;
    }
    out += `</div>`;
  }
  return out;
}

function extractOrgTitle(preamble) {
  if (!preamble) return null;
  const m = preamble.match(/^#\+TITLE:\s*(.+)/im);
  return m ? m[1].trim() : null;
}

export function generateExportHtml(nodes, preamble, filename, theme, accentColor, outlineFormat, levelFormats) {
  const accentBg = accentColor || null;
  const allTags = collectAllTags(nodes);
  const contentHtml = renderNodesHtml(nodes, 1, outlineFormat, levelFormats);
  const navHtml = buildNavHtml(nodes);
  const fileTitle = (filename || "Document").replace(/\.org$/, "");
  const orgTitle = extractOrgTitle(preamble) || fileTitle;
  const isDark = theme === "dark";

  const tbBgL = accentBg || "#ebebeb";
  const tbBgD = accentBg || "#2a2a2c";
  const tbFgL = accentBg ? "#fff" : "#1a1a1a";
  const tbFgD = accentBg ? "#fff" : "#e0e0e0";

  const tagPanelHtml = `
  <aside id="tag-panel" hidden>
    <div class="ph">Tags</div>
    <div id="tlist">
      <button class="tbtn active" onclick="setTag('')">All items</button>
      ${allTags.map(t => `<button class="tbtn" onclick="setTag('${esc(t)}')" data-tag="${esc(t)}">${esc(t)}</button>`).join("\n      ")}
      ${allTags.length === 0 ? `<span class="no-tags">No tags in document</span>` : ""}
    </div>
  </aside>`;

  const tagToggleBtn = `
  <button class="tb-btn" id="btn-tags" onclick="toggleTags()" title="Tag panel">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
  </button>`;

  return `<!DOCTYPE html>
<html data-theme="${isDark ? "dark" : "light"}" lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(orgTitle)}</title>
<style>
${exportCss(tbBgL, tbBgD, tbFgL, tbFgD)}
</style>
</head>
<body>
<div id="tb">
  <button class="tb-btn" id="btn-nav" onclick="toggleNav()" title="Toggle navigation panel">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <span class="tb-title">${esc(orgTitle)}</span>
  <span class="tb-spacer"></span>
  <div class="lvl-row" title="Show outline to this depth">
    <span class="lvl-label">Depth</span>
    <button class="lb active" data-lvl="0" onclick="lvl(0)">All</button>
    <button class="lb" data-lvl="1" onclick="lvl(1)">1</button>
    <button class="lb" data-lvl="2" onclick="lvl(2)">2</button>
    <button class="lb" data-lvl="3" onclick="lvl(3)">3</button>
    <button class="lb" data-lvl="4" onclick="lvl(4)">4</button>
  </div>
  <input id="srch" type="search" placeholder="Filter…" oninput="applyFilters()" autocomplete="off">
  <button class="tb-btn" onclick="toggleRW()" title="Toggle reading width">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <button class="tb-btn" onclick="toggleTheme()" title="Toggle light/dark theme">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
  </button>
  ${tagToggleBtn}
</div>
<div id="layout">
  <nav id="nav-panel" hidden>
    <div class="ph">Navigation</div>
    <div id="nav-body">${navHtml || "<span class='nav-empty'>No headings</span>"}</div>
  </nav>
  <main id="content">
    <div id="outline">${contentHtml}</div>
  </main>
  ${tagPanelHtml}
</div>
<script>
${exportJs()}
</script>
</body>
</html>`;
}

function exportCss(tbBgL, tbBgD, tbFgL, tbFgD) {
  return `*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#fff;--surface:#f5f5f5;--text:#1a1a1a;--dim:#888;--border:#e8e8e8;
  --link:#1a73e8;--code-bg:#efefef;
  --todo-bg:#fff3cd;--todo-text:#856404;
  --done-bg:#d4edda;--done-text:#155724;
  --cancelled-bg:#f0f0f0;--cancelled-text:#777;
  --next-bg:#e8f0fe;--next-text:#3c4ee0;
  --bullet:#c0c0c0;
  --tbg:${tbBgL};--tfg:${tbFgL};
  --nav-bg:#fafafa;--tags-bg:#fafafa;
}
[data-theme=dark]{
  --bg:#1c1c1e;--surface:#2c2c2e;--text:#e6e6e6;--dim:#8a8a8e;--border:#3a3a3c;
  --link:#5b9bf7;--code-bg:#333335;
  --todo-bg:#4a3f1f;--todo-text:#e0c068;
  --done-bg:#1f3324;--done-text:#7fcf9a;
  --cancelled-bg:#2a2a2c;--cancelled-text:#888;
  --next-bg:#1a2240;--next-text:#7a9ef7;
  --bullet:#555;
  --tbg:${tbBgD};--tfg:${tbFgD};
  --nav-bg:#212123;--tags-bg:#212123;
}
html,body{height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.55;font-size:14px}
*{scrollbar-color:var(--border) transparent;scrollbar-width:thin}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

/* TOPBAR */
#tb{display:flex;align-items:center;gap:8px;padding:0 12px;height:52px;background:var(--tbg);color:var(--tfg);flex-shrink:0;border-bottom:1px solid rgba(0,0,0,.12);z-index:10;position:relative}
.tb-btn{background:none;border:none;color:var(--tfg);cursor:pointer;padding:5px 7px;border-radius:5px;display:flex;align-items:center;opacity:.8}
.tb-btn:hover{opacity:1;background:rgba(128,128,128,.2)}
.tb-title{position:absolute;left:50%;transform:translateX(-50%);font-weight:700;font-size:18px;pointer-events:none;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;letter-spacing:-.01em;opacity:.95}
.tb-spacer{flex:1}
.lvl-row{display:flex;align-items:center;gap:3px;flex-shrink:0}
.lvl-label{font-size:11px;opacity:.65;margin-right:2px}
.lb{background:rgba(128,128,128,.2);border:none;color:var(--tfg);cursor:pointer;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:500}
.lb:hover{background:rgba(128,128,128,.35)}
.lb.active{background:rgba(128,128,128,.5);font-weight:700}
#srch{background:rgba(128,128,128,.18);border:1px solid rgba(128,128,128,.28);color:var(--tfg);padding:5px 10px;border-radius:6px;font-size:13px;outline:none;width:170px}
#srch:focus{background:rgba(128,128,128,.26);border-color:rgba(128,128,128,.5)}
#srch::placeholder{color:var(--tfg);opacity:.55}

/* LAYOUT */
#layout{display:flex;height:calc(100vh - 52px);overflow:hidden}

/* NAV PANEL */
#nav-panel{width:260px;flex-shrink:0;background:var(--nav-bg);border-right:1px solid var(--border);display:flex;flex-direction:column}
#nav-panel[hidden]{display:none}
.ph{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);padding:10px 12px 8px;flex-shrink:0;border-bottom:1px solid var(--border)}
#nav-body{padding:4px 0;flex:1;overflow-y:auto}
.ni{display:block}
.ni-row{display:flex;align-items:center;gap:1px;padding:0 4px}
.ni-tog{background:none;border:none;cursor:pointer;color:var(--dim);font-size:9px;width:18px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:0;border-radius:3px;transition:color .1s}
.ni-tog:hover{color:var(--text);background:var(--surface)}
.ni-leaf{width:18px;flex-shrink:0}
.ni-ch{padding-left:14px}
.ni-ch[hidden]{display:none}
.nl{display:block;flex:1;padding:3px 6px;color:var(--text);text-decoration:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px;min-width:0}
.nl:hover{background:var(--surface);color:var(--link)}
.nl.nav-active{font-weight:600;color:var(--link)}
.nav-empty{display:block;padding:12px;color:var(--dim);font-size:13px}

/* CONTENT */
#content{flex:1;overflow-y:auto;padding:20px 32px 60px;min-width:0}
#outline{max-width:100%}
#content.rw #outline{max-width:820px;margin:0 auto}

/* TAG PANEL */
#tag-panel{width:190px;flex-shrink:0;background:var(--tags-bg);border-left:1px solid var(--border);display:flex;flex-direction:column}
#tag-panel[hidden]{display:none}
#tlist{padding:8px 6px;overflow-y:auto;flex:1}
.tbtn{display:block;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:5px 10px;border-radius:5px;font-size:13px;color:var(--text);margin-bottom:2px}
.tbtn:hover{background:var(--surface)}
.tbtn.active{background:var(--link);color:#fff}

/* PREAMBLE (unused but kept for compatibility) */
.preamble{display:none}
.no-tags{display:block;padding:6px 10px;color:var(--dim);font-size:12px;font-style:italic}

/* NODE STRUCTURE */
.ns{display:block}
.ns[hidden]{display:none!important}
.ch[hidden]{display:none!important}
.ns .ns{margin-left:24px}
.nh{display:flex;align-items:baseline;gap:5px;padding:3px 0 2px;position:relative;min-height:22px}
.nb{width:14px;height:14px;flex-shrink:0;align-self:flex-start;margin-top:3px;display:flex;align-items:center;justify-content:center}
.nb:not(.tog)::before{content:'';display:block;width:6px;height:6px;border-radius:50%;background:var(--bullet)}
.tog{cursor:pointer;color:var(--bullet);font-size:11px;user-select:none;transition:color .1s}
.tog:hover{color:var(--text)}
.nt{font-size:14px;line-height:1.5;word-break:break-word}
.nh.done .nt{text-decoration:line-through;color:var(--dim)}
.nbody{font-size:13px;color:var(--dim);padding:3px 0 8px 19px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.nbody p{margin-bottom:.5em}

/* Depth-based heading sizes */
.ns[data-level="1"]>.nh>.nt{font-weight:600;font-size:15px}
.ns[data-level="2"]>.nh>.nt{font-weight:500;font-size:14px}
.ns[data-level="3"]>.nh>.nt{font-size:14px}

/* Depth-based bullet sizes */
.ns[data-level="1"]>.nh>.nb:not(.tog)::before{width:8px;height:8px}
.ns[data-level="2"]>.nh>.nb:not(.tog)::before{width:7px;height:7px}

/* Indexed (numbered/lettered) nodes */
.nb-caret{width:14px;height:14px;flex-shrink:0;align-self:flex-start;margin-top:3px;display:flex;align-items:center;justify-content:center;color:var(--bullet);font-size:11px;user-select:none;transition:color .1s}
.nb-caret.tog{cursor:pointer}
.nb-caret.tog:hover{color:var(--text)}
.nb-idx{font-size:12px;color:var(--dim);flex-shrink:0;padding-right:4px;align-self:flex-start;margin-top:2px;font-variant-numeric:tabular-nums}

/* STATUS BADGES */
.sbadge{font-size:11px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;letter-spacing:.03em}
.s-todo{background:var(--todo-bg);color:var(--todo-text)}
.s-done{background:var(--done-bg);color:var(--done-text)}
.s-cancelled{background:var(--cancelled-bg);color:var(--cancelled-text)}
.s-next{background:var(--next-bg);color:var(--next-text)}

/* TAG CHIPS in content */
.tg{display:inline-flex;flex-wrap:wrap;gap:3px;margin-left:4px;vertical-align:baseline}
.tc{font-size:11px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1px 7px;cursor:pointer;color:var(--dim)}
.tc:hover{border-color:var(--link);color:var(--link)}
.tc.tag-active{background:var(--link);color:#fff;border-color:var(--link)}

/* ORG INLINE MARKUP */
strong{font-weight:700}
em{font-style:italic}
u{text-decoration:underline}
code{background:var(--code-bg);border-radius:3px;padding:1px 4px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:var(--link)}
a:hover{text-decoration:underline}
del,s{text-decoration:line-through}
sup.org-fn-ref{color:var(--link);font-size:.78em;vertical-align:super}
sup.fn-ref{cursor:pointer;border-bottom:1px dotted var(--link)}
sup.fn-ref:hover{opacity:.7}
sup.fn-def-marker{cursor:default;font-weight:700}
.fn-back{color:var(--link);font-size:.8em;text-decoration:none;margin-left:3px;opacity:.7}
.fn-back:hover{opacity:1}
@keyframes fn-flash{0%,15%{outline:2px solid var(--link);border-radius:3px;outline-offset:2px}100%{outline:2px solid transparent}}
.fn-flash{animation:fn-flash 1.2s ease-out}`;
}

function exportJs() {
  return `
var curLvl=0,curTag="",curSearch="";

function toggleNav(){var p=document.getElementById('nav-panel');p.hidden=!p.hidden;}
function toggleTags(){var p=document.getElementById('tag-panel');if(p)p.hidden=!p.hidden;}
function toggleTheme(){var h=document.documentElement;h.dataset.theme=h.dataset.theme==='dark'?'light':'dark';}
function toggleRW(){document.getElementById('content').classList.toggle('rw');}

function lvl(n){
  curLvl=n;
  document.querySelectorAll('.lb').forEach(function(b){b.classList.toggle('active',parseInt(b.dataset.lvl)===n);});
  applyFilters();
}

function setTag(tag){
  curTag=tag;
  document.querySelectorAll('.tbtn').forEach(function(b){
    b.classList.toggle('active',(!tag&&!b.dataset.tag)||b.dataset.tag===tag);
  });
  document.querySelectorAll('.tc').forEach(function(tc){
    tc.classList.toggle('tag-active',tag!==''&&tc.dataset.tag===tag);
  });
  applyFilters();
}

function applyFilters(){
  var q=(document.getElementById('srch').value||'').toLowerCase().trim();
  curSearch=q;
  document.querySelectorAll('#outline .ns').forEach(function(el){
    var level=parseInt(el.dataset.level)||1;
    var tags=el.dataset.tags?el.dataset.tags.split(',').filter(Boolean):[];
    var levelOk=curLvl===0||level<=curLvl;
    var searchOk=!q||el.textContent.toLowerCase().indexOf(q)>=0;
    var tagOk=!curTag||tags.indexOf(curTag)>=0;
    el.hidden=!(levelOk&&searchOk&&tagOk);
  });
  // Sync each .ch container and its toggle arrow with child visibility so
  // the arrow accurately reflects whether there is something to expand.
  document.querySelectorAll('#outline .ch').forEach(function(ch){
    var hasVisible=!!ch.querySelector(':scope>.ns:not([hidden])');
    ch.hidden=!hasVisible;
    var ns=ch.parentElement;
    var tog=ns&&ns.querySelector(':scope>.nh .tog');
    if(tog){tog.textContent=ch.hidden?'▶':'▼';tog.title=ch.hidden?'Expand':'Collapse';}
  });
}

function navToggle(btn){
  var ni=btn.closest('.ni');
  var ch=ni&&ni.querySelector(':scope>.ni-ch');
  if(!ch)return;
  ch.hidden=!ch.hidden;
  btn.textContent=ch.hidden?'▶':'▼';
  btn.title=ch.hidden?'Expand':'Collapse';
}

function toggleNode(el,chId){
  var ch=document.getElementById(chId);
  if(!ch)return;
  var expanding=ch.hidden;
  ch.hidden=!ch.hidden;
  el.textContent=ch.hidden?'▶':'▼';
  el.title=ch.hidden?'Expand':'Collapse';
  if(expanding){
    // Un-hide direct children that the level filter may have suppressed,
    // so clicking ▶ actually reveals content rather than showing nothing.
    ch.querySelectorAll(':scope>.ns').forEach(function(ns){ns.hidden=false;});
  }
}

function navClick(e,a){
  e.preventDefault();
  var target=document.querySelector(a.getAttribute('href'));
  if(!target)return;
  // Expand collapsed main-content .ch ancestors
  var el=target.parentElement;
  while(el&&el.id!=='layout'){
    if(el.hidden){
      el.hidden=false;
      if(el.classList.contains('ch')){
        var tog=el.parentElement&&el.parentElement.querySelector(':scope>.nh>.tog');
        if(tog){tog.textContent='▼';tog.title='Collapse';}
      }
    }
    el=el.parentElement;
  }
  // Expand nav-panel .ni-ch ancestors so the active link is visible
  var navEl=a.closest('.ni-ch');
  while(navEl){
    if(navEl.hidden){
      navEl.hidden=false;
      var ptog=navEl.parentElement&&navEl.parentElement.querySelector(':scope>.ni-row>.ni-tog');
      if(ptog){ptog.textContent='▼';ptog.title='Collapse';}
    }
    navEl=navEl.parentElement&&navEl.parentElement.closest('.ni-ch');
  }
  target.scrollIntoView({behavior:'smooth',block:'start'});
}

// Footnote bidirectional navigation
(function(){
  function expandToEl(el){
    var p=el.parentElement;
    while(p&&p.id!=='outline'){
      if(p.hidden){
        p.hidden=false;
        if(p.classList.contains('ch')){
          var tog=p.parentElement&&p.parentElement.querySelector(':scope>.nh>.tog');
          if(tog){tog.textContent='▼';tog.title='Collapse';}
        }
      }
      p=p.parentElement;
    }
  }
  function flashEl(el){
    el.classList.remove('fn-flash');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('fn-flash');
    setTimeout(function(){el.classList.remove('fn-flash');},1300);
  }
  // Determine if an .org-fn-ref element is a definition (first thing on its line)
  function isDefStart(el){
    var node=el.previousSibling,txt='';
    while(node){
      if(node.nodeType===1){txt='x';break;}
      if(node.nodeType===3)txt=node.textContent+txt;
      node=node.previousSibling;
    }
    return txt.split('\\n').pop().trim()==='';
  }
  var refCounts={};
  document.querySelectorAll('.nbody .org-fn-ref').forEach(function(el){
    var label=el.dataset.fn;
    if(!label)return;
    if(isDefStart(el)){
      // Footnote definition marker
      el.id='fndef-'+label;
      el.classList.add('fn-def-marker');
      var back=document.createElement('a');
      back.className='fn-back';
      back.title='Back to reference';
      back.textContent='↩';
      back.href='#fnref-'+label+'-1';
      back.onclick=function(e){
        e.preventDefault();
        var ref=document.getElementById('fnref-'+label+'-1');
        if(!ref)return;
        expandToEl(ref);
        ref.scrollIntoView({behavior:'smooth',block:'center'});
        flashEl(ref);
      };
      el.parentNode.insertBefore(back,el.nextSibling);
    } else {
      // Footnote reference
      refCounts[label]=(refCounts[label]||0)+1;
      el.id='fnref-'+label+'-'+refCounts[label];
      el.classList.add('fn-ref');
      (function(lbl){
        el.onclick=function(){
          var def=document.getElementById('fndef-'+lbl);
          if(!def)return;
          expandToEl(def);
          def.scrollIntoView({behavior:'smooth',block:'center'});
          flashEl(def);
        };
      })(label);
    }
  });
})();

// Highlight active nav link as user scrolls
(function(){
  var content=document.getElementById('content');
  if(!content)return;
  var ticking=false;
  content.addEventListener('scroll',function(){
    if(ticking)return;
    ticking=true;
    requestAnimationFrame(function(){
      ticking=false;
      var scrollMid=content.scrollTop+content.clientHeight/3;
      var best=null,bestTop=-Infinity;
      document.querySelectorAll('#outline .ns[id]').forEach(function(s){
        var top=s.offsetTop;
        if(top<=scrollMid&&top>bestTop){bestTop=top;best=s;}
      });
      document.querySelectorAll('.nl').forEach(function(a){
        a.classList.toggle('nav-active',best&&a.getAttribute('href')==='#'+best.id);
      });
    });
  },{passive:true});
})();`;
}
