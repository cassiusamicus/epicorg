# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
make build  # go build -o epicorg .
make run    # build + run with current directory
make test   # go test ./...
go build ./...  # check compilation without producing binary
./epicorg ~/org  # run with specific directory (default: .)
./epicorg -addr :9090 ~/org  # custom port
```

The frontend has no build step — pure ES modules loaded from CDN.

## Architecture

Epicorg is a local-first outliner backed by org-mode files. The frontend owns the document as a JSON tree and mutates it synchronously. A background sync pushes the full document to the server every 3 seconds.

### Data Flow

```
React (local JSON tree) → PUT /api/doc/:file → Go converts JSON→org → writes .org file
                        ← GET /api/doc/:file ← Go converts org→JSON ← reads .org file
```

All editing operations (typing, indent, move, fold) are instant local state mutations with zero network round-trip. The server is a thin translator between JSON and org format.

### Packages

- **`internal/model`** — Core types and conversions. `Item` is the flat list representation (one per org headline or body block). `Node` is the tree representation sent to/from the frontend. Key conversion chain: `go-org Document → Items (FromDocument) → Nodes (ToTree)` for reading; `Nodes → Items (ItemsFromTree) → org text (ToOrg)` for writing.
- **`internal/orgfile`** — Directory-based file store. Manages per-file state including parsed document, preamble, collapsed metadata, and SHA-256 hash for merge-base tracking. Coordinates git commits (snapshot on load, idle, shutdown).
- **`internal/git`** — Thin wrapper shelling out to `git` CLI. `EnsureRepo`, `CommitFile`, `MergeFile` (three-way merge via `git merge-file`). Only ever stages/commits the single org file being edited.
- **`internal/api`** — HTTP handlers. Three endpoints: `GET /api/files` (list), `GET /api/doc/:file` (load), `PUT /api/doc/:file` (save with hash-based conflict detection).
- **`internal/server`** — Embeds `web/` directory via `//go:embed` and serves the SPA.

### Frontend (`internal/server/web/`)

Single-file React app using [htm](https://github.com/developit/htm) for JSX-like templates without transpilation. React and htm loaded from CDN via importmap in `index.html`. No npm, no bundler. Embedded into the Go binary at compile time.

Key state: `nodes` (the tree), `preamble`, `hash` (for sync), `currentFile`, `focusedId`, `syncStatus`. The `dispatch` function handles all actions as local tree mutations that set a dirty flag.

### Conflict Resolution

On save, the server compares the disk file's SHA-256 hash against the stored base hash. If they match (no external edit), it overwrites. If they differ, it runs `git merge-file` for three-way merge. Conflict markers are written to the file and surfaced in the UI.

### Git Lifecycle

Git only commits the single active org file, never other files in the workspace. Commits happen at three points: file load (snapshot base), 20-minute idle timeout, and server shutdown (SIGTERM/SIGINT).

## Key Conventions

- The frontend is vanilla JS/HTML/CSS — no npm, no Node.js, no bundlers. Do not introduce build tooling.
- The Go server's only external dependency is `go-org` for parsing. Keep dependencies minimal.
- Org file format is the source of truth. Body text is stored as a single `Item` with `IsBody: true` containing newlines. Properties use the `:PROPERTIES:` drawer. Status (TODO/DONE) uses org headline keywords.
- Collapsed state lives in a `.meta.json` sidecar, not in the org file.
- Node IDs are ephemeral (assigned on parse, regenerated on load). The frontend generates temporary IDs (`n1`, `n2`, ...) for new nodes. IDs are not persisted.

## Contributing

- Unit tests should be written for all functionality, in the UI and backend.
