package api

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"

	"epicorg/internal/model"
	"epicorg/internal/orgfile"
)

type handlers struct {
	store       *orgfile.Store
	onSave      func() // called after successful save (resets idle timer)
	defaultFile string // file to auto-open on startup, if set
}

func (h *handlers) listFiles(w http.ResponseWriter, r *http.Request) {
	files, err := h.store.ListFiles()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	resp := map[string]interface{}{"files": files}
	if h.defaultFile != "" {
		resp["default"] = h.defaultFile
	}
	writeJSON(w, resp)
}

func (h *handlers) createFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Filename string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	name := req.Filename
	if !strings.HasSuffix(name, ".org") {
		name += ".org"
	}
	if err := h.store.CreateFile(name); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, map[string]string{"filename": name})
}

// validFilename rejects path traversal and anything that isn't a plain
// .org filename within the workspace directory.
func validFilename(name string) bool {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return false
	}
	return strings.HasSuffix(name, ".org")
}

func (h *handlers) deleteFile(w http.ResponseWriter, r *http.Request) {
	name := extractFilesName(r.URL.Path)
	if !validFilename(name) {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	if err := h.store.DeleteFile(name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handlers) renameFile(w http.ResponseWriter, r *http.Request) {
	name := extractFilesName(r.URL.Path)
	if name == "" {
		http.Error(w, "missing filename", http.StatusBadRequest)
		return
	}
	var req struct {
		NewName string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	newName := req.NewName
	if !strings.HasSuffix(newName, ".org") {
		newName += ".org"
	}
	if !validFilename(newName) {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	if err := h.store.RenameFile(name, newName); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"filename": newName})
}

func (h *handlers) getDoc(w http.ResponseWriter, r *http.Request) {
	name := extractFilename(r.URL.Path)
	if name == "" {
		http.Error(w, "missing filename", http.StatusBadRequest)
		return
	}

	fs, err := h.store.LoadFile(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	items := model.FromDocument(fs.Doc)
	nodes := items.ToTree(fs.Meta.Collapsed)

	writeJSON(w, model.Document{
		Filename: name,
		Preamble: fs.Preamble,
		Hash:     fs.BaseHash,
		Nodes:    nodes,
	})
}

func (h *handlers) putDoc(w http.ResponseWriter, r *http.Request) {
	name := extractFilename(r.URL.Path)
	if name == "" {
		http.Error(w, "missing filename", http.StatusBadRequest)
		return
	}

	var doc model.Document
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	content := docToContent(doc)

	// Save collapsed state to sidecar
	collapsed := model.CollapsedFromTree(doc.Nodes)
	h.store.SaveMeta(name, collapsed)

	// Write to disk with merge-on-conflict
	result, err := h.store.SaveFile(name, content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if h.onSave != nil {
		h.onSave()
	}

	resp := map[string]interface{}{"hash": result.Hash}
	if result.ExternalChange {
		// The file changed on disk since our base, so SaveFile merged it.
		// Hand the merged result back so the client adopts it instead of
		// re-overwriting the merge on its next save.
		resp["externalChange"] = true
		if result.Conflict {
			resp["conflict"] = true
		}
		items := model.FromDocument(result.Doc)
		resp["nodes"] = items.ToTree(collapsed)
		resp["preamble"] = result.Preamble
	}
	writeJSON(w, resp)
}

// docToContent serializes a node tree + preamble into raw org text, exactly
// as putDoc does before writing to disk.
func docToContent(doc model.Document) string {
	items := model.ItemsFromTree(doc.Nodes, 1)
	preamble := doc.Preamble
	if preamble != "" && !strings.HasSuffix(preamble, "\n") {
		preamble += "\n"
	}
	return preamble + items.ToOrg()
}

// renderText converts the current in-memory node tree to raw org text,
// without touching disk — the entry point into text mode.
func (h *handlers) renderText(w http.ResponseWriter, r *http.Request) {
	var doc model.Document
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"text": docToContent(doc)})
}

// parseText parses freely-edited raw org text back into a node tree,
// without touching disk — the exit point from text mode. The caller's
// existing collapsed-by-id map is passed through so fold state survives
// when the edit didn't reorder/insert/delete headings above it.
func (h *handlers) parseText(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text      string          `json:"text"`
		Collapsed map[string]bool `json:"collapsed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	doc, preamble := orgfile.ParseText(req.Text)
	items := model.FromDocument(doc)
	writeJSON(w, map[string]interface{}{
		"preamble": preamble,
		"nodes":    items.ToTree(req.Collapsed),
	})
}

func (h *handlers) getFavorites(w http.ResponseWriter, r *http.Request) {
	favs, err := h.store.GetFavorites()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"favorites": favs})
}

func (h *handlers) setFavorite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Filename string `json:"filename"`
		Favorite bool   `json:"favorite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Filename == "" {
		http.Error(w, "missing filename", http.StatusBadRequest)
		return
	}
	favs, err := h.store.SetFavorite(req.Filename, req.Favorite)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"favorites": favs})
}

func (h *handlers) diskHash(w http.ResponseWriter, r *http.Request) {
	name := extractHashFilename(r.URL.Path)
	if name == "" {
		http.Error(w, "missing filename", http.StatusBadRequest)
		return
	}
	hash, err := h.store.DiskHash(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"hash": hash})
}

func (h *handlers) openPath(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	go exec.Command("xdg-open", req.Path).Start()
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handlers) getGlobalBookmarks(w http.ResponseWriter, r *http.Request) {
	bms, err := orgfile.LoadGlobalBookmarks()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"bookmarks": bms})
}

func (h *handlers) putGlobalBookmarks(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Bookmarks []orgfile.GlobalBookmark `json:"bookmarks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Bookmarks == nil {
		req.Bookmarks = []orgfile.GlobalBookmark{}
	}
	if err := orgfile.SaveGlobalBookmarks(req.Bookmarks); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handlers) getOrgBookmarks(w http.ResponseWriter, r *http.Request) {
	bms, err := orgfile.LoadOrgBookmarks(h.store.Dir())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"bookmarks": bms})
}

func (h *handlers) putOrgBookmarks(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Bookmarks []orgfile.OrgBookmark `json:"bookmarks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Bookmarks == nil {
		req.Bookmarks = []orgfile.OrgBookmark{}
	}
	if err := orgfile.SaveOrgBookmarks(h.store.Dir(), req.Bookmarks); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handlers) getGlobalTags(w http.ResponseWriter, r *http.Request) {
	tags, err := orgfile.LoadGlobalTags(h.store.Dir())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"tags": tags})
}

func (h *handlers) putGlobalTags(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Tags []orgfile.GlobalTag `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Tags == nil {
		req.Tags = []orgfile.GlobalTag{}
	}
	if err := orgfile.SaveGlobalTags(h.store.Dir(), req.Tags); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func extractFilename(path string) string {
	// /api/doc/notes.org -> notes.org
	const prefix = "/api/doc/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return strings.TrimPrefix(path, prefix)
}

func extractHashFilename(path string) string {
	// /api/hash/notes.org -> notes.org
	const prefix = "/api/hash/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return strings.TrimPrefix(path, prefix)
}

func extractFilesName(path string) string {
	// /api/files/notes.org -> notes.org
	const prefix = "/api/files/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return strings.TrimPrefix(path, prefix)
}
