# epicorg

A keyboard-driven outliner with an org-mode file backend. Think Workflowy meets Todoist, backed by plain text.

Your data lives in a standard `.org` file — edit it in epicorg, Emacs, or any text editor. No database, no proprietary format.

![Outline view](docs/images/outline-view.png)

![Agenda view](docs/images/agenda-view.png)

## Features

- **Infinite nesting** — create deeply nested outlines with headings, sub-headings, and body text
- **Keyboard-first** — navigate, create, indent, move, and fold items without touching the mouse
- **Inline notes** — body text shows directly under its bullet, not tucked away in a side panel; toggle them all off for a quick scan, with a `…` marker (org-mode style) on items with notes hidden
- **Text mode** — toggle to the raw org source (asterisks, tags, `:PROPERTIES:` drawers and all) to fix anything the structured view can't, then toggle back to reparse
- **Detail pane** — status, due dates, tags, and custom properties for the focused item
- **Tag filter** — toggle one or more tags from a popup to narrow the outline (OR within tags, AND with the text filter)
- **TODO/DONE status** — clickable badges on each item, stored as standard org-mode status keywords
- **Due dates** — date picker stored as `DEADLINE` in org properties
- **Agenda view** — see all dated items sorted chronologically, grouped by date, with overdue/today indicators
- **Fold to level** — Alt+1 through Alt+9 to collapse the entire outline to a specific depth
- **Numbered bullets** — Dynalist-style "1. 2. 3." numbering per level, toggled from the hamburger menu
- **Vertical guide lines** — optional Dynalist-style lines connecting a parent to its children, toggled from the hamburger menu
- **Hoist** — isolate the focused item and its children, hiding the rest of the outline; toggle back to restore the full view
- **Responsive header** — when the toolbar/search/etc. don't actually fit (measured, not a fixed breakpoint — a long filename or many tags can trigger this even on a wide screen), it collapses to just the logo, filename, and both sidebar toggles, with everything else folded into the hamburger menu
- **Undo/redo** — Ctrl+Z / Ctrl+Shift+Z, document-wide; typing coalesces into one step per pause, structural edits each get their own
- **Preamble editing** — file-level content (like `#+TITLE`) editable via a dedicated preamble node
- **Multi-file** — point epicorg at a directory of `.org` files, switch between them with a file picker; rename or delete files from there too (hover a row for the actions)
- **Local-first editing** — all changes are instant; background sync pushes to disk every few seconds
- **Git-backed merge** — the directory is a git repo; external edits are three-way merged via `git merge-file`
- **Auto-commit** — git commits on load, after 20 minutes idle, and on shutdown
- **Single binary** — one Go binary, no npm, no build step for the frontend

## Quick start

```
go build -o epicorg .
./epicorg ~/org
```

Opens the `~/org` directory (created if it doesn't exist) and launches a browser. If the directory isn't a git repo, epicorg initializes one.

| Argument | Default | Description |
|----------|---------|-------------|
| `[directory]` | `.` | Directory containing `.org` files |
| `-addr` | `:8080` | Listen address |

## Keyboard shortcuts

### Navigation

| Key | Action |
|-----|--------|
| `Up` / `Down` | Move between items |
| `Enter` | Create new sibling item |
| `Backspace` | Delete empty item |
| `Shift+Enter` | Add/edit notes inline under the item |
| `Escape` | Return to the title from notes/detail pane |

### Structure

| Key | Action |
|-----|--------|
| `Alt+Left` | Outdent (promote) |
| `Alt+Right` | Indent (demote) |
| `Alt+Up` | Move item up |
| `Alt+Down` | Move item down |

### Folding

| Key | Action |
|-----|--------|
| `Tab` | Fold/unfold children |
| `Alt+1` through `Alt+9` | Fold entire outline to level N |

### Formatting

| Key | Action |
|-----|--------|
| `Ctrl+B` | Wrap selection in `*bold*` |
| `Ctrl+I` | Wrap selection in `/italic/` |
| `Ctrl+U` | Wrap selection in `_underline_` |

### Other

| Key | Action |
|-----|--------|
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` (or `Ctrl+Y`) | Redo |

## Architecture

```
browser (React)          Go server           disk
  local JSON tree  --->  PUT /api/doc  --->   .org file
  instant edits          JSON <-> org         plain text
                         version check
```

**Frontend** owns the document as a JSON tree. All editing — typing, indenting, moving, folding — happens as instant local state mutations. No network round-trip for any operation. A background sync pushes the full document to the server every 3 seconds when dirty.

**Backend** translates between JSON and org-mode format. Endpoints: `GET /api/files` lists org files, `GET /api/doc/:file` loads a file, `PUT /api/doc/:file` saves it. Parsing uses [go-org](https://github.com/niklasfasching/go-org). The frontend is pure ES modules with [htm](https://github.com/developit/htm) loaded from CDN — no npm, no bundler.

**Merge** uses SHA-256 hashes for change detection. On save, epicorg checks if the file changed on disk since it was last loaded. If so, it runs `git merge-file` for a three-way merge. Clean merges apply automatically; conflicts produce standard markers in the file.

**Git** auto-commits at three points: on file load (snapshot base), after 20 minutes of idle, and on server shutdown. Collapsed state is stored in a `.meta.json` sidecar so it doesn't clutter the org file.

## Org file format

epicorg reads and writes standard org-mode:

```org
#+EPICORG_VERSION: 5
* TODO Inbox
** DONE Buy milk
:PROPERTIES:
:DEADLINE: <2026-04-15 Wed>
:END:
** Write README
Body text goes here.
Multiple lines supported.
* Projects
** Build epicorg
:PROPERTIES:
:PRIORITY: high
:END:
```

## Development

The frontend lives in `internal/server/web/` and is embedded at compile time. Edit the HTML/CSS/JS, rebuild with `go build`, and refresh.

```
go build -o epicorg .
./epicorg .
```

## License

MIT
