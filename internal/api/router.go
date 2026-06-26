package api

import (
	"net/http"

	"epicorg/internal/orgfile"
)

// Register sets up API routes on the given mux. defaultFile, if non-empty,
// is reported to the frontend as the file to open automatically on startup.
func Register(mux *http.ServeMux, store *orgfile.Store, onSave func(), defaultFile string) {
	h := &handlers{store: store, onSave: onSave, defaultFile: defaultFile}

	mux.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.listFiles(w, r)
		case http.MethodPost:
			h.createFile(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Delete/rename a file. Separate from /api/files above, which is the
	// exact-match list/create route — this is a prefix route for
	// operations on one specific file.
	mux.HandleFunc("/api/files/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodDelete:
			h.deleteFile(w, r)
		case http.MethodPut:
			h.renameFile(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/doc/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.getDoc(w, r)
		case http.MethodPut, http.MethodPost: // POST for sendBeacon compatibility
			h.putDoc(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Lightweight disk-hash probe used by the frontend to detect external
	// edits while idle, without paying the cost of a full reload.
	mux.HandleFunc("/api/hash/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.diskHash(w, r)
	})

	// Stateless conversions backing text mode: nodes<->raw org text, with
	// no disk access. Both POST-only since they take a body.
	mux.HandleFunc("/api/render", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.renderText(w, r)
	})
	mux.HandleFunc("/api/parse", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.parseText(w, r)
	})

	// Opens a local file path with xdg-open (system default handler).
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.openPath(w, r)
	})

	// Favorites are workspace-level (shared across whoever opens this
	// directory), unlike Recent Files which lives in the browser's
	// localStorage.
	mux.HandleFunc("/api/favorites", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.getFavorites(w, r)
		case http.MethodPut:
			h.setFavorite(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Global bookmarks — persisted to ~/.config/epicorg/bookmarks.json,
	// visible across all files.
	mux.HandleFunc("/api/global-bookmarks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.getGlobalBookmarks(w, r)
		case http.MethodPut:
			h.putGlobalBookmarks(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Org-based bookmark list — persisted to Bookmarks.org in the workspace dir.
	mux.HandleFunc("/api/bookmarks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.getOrgBookmarks(w, r)
		case http.MethodPut:
			h.putOrgBookmarks(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Global tags — persisted to ~/.config/epicorg/tags.json.
	mux.HandleFunc("/api/global-tags", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.getGlobalTags(w, r)
		case http.MethodPut:
			h.putGlobalTags(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
