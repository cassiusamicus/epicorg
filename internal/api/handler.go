package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

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
	def := h.defaultFile
	if def == "" && len(files) == 1 {
		def = files[0].Name
	}
	if def != "" {
		resp["default"] = def
	}
	writeJSON(w, resp)
}

func (h *handlers) createFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Filename string `json:"filename"`
		Title    string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	name := req.Filename
	if !strings.HasSuffix(name, ".org") {
		name += ".org"
	}
	content := ""
	if req.Title != "" {
		content = "#+TITLE: " + req.Title + "\n"
	}
	if err := h.store.CreateFile(name, content); err != nil {
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

// validJournalPath accepts only journal/YYYY-MM-DD.org paths.
func validJournalPath(name string) bool {
	parts := strings.SplitN(name, "/", 2)
	if len(parts) != 2 || parts[0] != "journal" {
		return false
	}
	dateStr := strings.TrimSuffix(parts[1], ".org")
	_, err := time.Parse("2006-01-02", dateStr)
	return err == nil
}

func (h *handlers) listJournalFiles(w http.ResponseWriter, r *http.Request) {
	files, err := h.store.ListJournalFiles()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"files": files})
}

func (h *handlers) createTodayJournal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Date string `json:"date"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	date := body.Date
	if date == "" {
		date = time.Now().Format("2006-01-02")
	} else if _, err := time.Parse("2006-01-02", date); err != nil {
		http.Error(w, "invalid date: must be YYYY-MM-DD", http.StatusBadRequest)
		return
	}

	name := "journal/" + date + ".org"
	if err := h.store.CreateJournalFile(name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"filename": name})
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
	// Update [[file:oldName...]] links across all org files in the workspace.
	filesChanged, replacements, _ := orgfile.RenameFileLinks(h.store.Dir(), name, newName)
	writeJSON(w, map[string]any{
		"filename":     newName,
		"filesChanged": filesChanged,
		"replacements": replacements,
	})
}

func (h *handlers) getDoc(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("abs")
	if name == "" {
		name = extractFilename(r.URL.Path)
	}
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
	name := r.URL.Query().Get("abs")
	if name == "" {
		name = extractFilename(r.URL.Path)
	}
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
	name := r.URL.Query().Get("abs")
	if name == "" {
		name = extractHashFilename(r.URL.Path)
	}
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
	go openWithSystem(req.Path)
	writeJSON(w, map[string]bool{"ok": true})
}

func openWithSystem(path string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	cmd.Start()
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
	var bms []orgfile.OrgBookmark
	var err error
	if f := h.store.GetBookmarkListFile(); f != "" {
		bms, err = orgfile.LoadOrgBookmarksFromFile(f)
	} else {
		bms, err = orgfile.LoadOrgBookmarks(h.store.Dir())
	}
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
	var err error
	if f := h.store.GetBookmarkListFile(); f != "" {
		err = orgfile.SaveOrgBookmarksToFile(f, req.Bookmarks)
	} else {
		err = orgfile.SaveOrgBookmarks(h.store.Dir(), req.Bookmarks)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handlers) getBookmarkListFile(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"file": h.store.GetBookmarkListFile()})
}

func (h *handlers) setBookmarkListFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		File string `json:"file"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if err := h.store.SetBookmarkListFile(req.File); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"file": req.File})
}

func (h *handlers) getGlobalTags(w http.ResponseWriter, r *http.Request) {
	var tags []orgfile.GlobalTag
	var err error
	if f := h.store.GetTagListFile(); f != "" {
		tags, err = orgfile.LoadGlobalTagsFromFile(f)
	} else {
		tags, err = orgfile.LoadGlobalTags(h.store.Dir())
	}
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
	var err error
	if f := h.store.GetTagListFile(); f != "" {
		err = orgfile.SaveGlobalTagsToFile(f, req.Tags)
	} else {
		err = orgfile.SaveGlobalTags(h.store.Dir(), req.Tags)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handlers) renameTag(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OldName string `json:"oldName"`
		NewName string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.OldName == "" || req.NewName == "" {
		http.Error(w, "invalid request: oldName and newName required", http.StatusBadRequest)
		return
	}
	if req.OldName == req.NewName {
		writeJSON(w, map[string]int{"filesChanged": 0, "replacements": 0})
		return
	}
	dir := h.store.Dir()
	filesChanged, replacements, err := orgfile.RenameTagInDir(dir, req.OldName, req.NewName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// If the custom tag list file lives outside the home dir, process it separately.
	if f := h.store.GetTagListFile(); f != "" && !strings.HasPrefix(f, dir) {
		n, ferr := orgfile.RenameTagInFile(f, req.OldName, req.NewName)
		if ferr == nil && n > 0 {
			filesChanged++
			replacements += n
		}
	}
	writeJSON(w, map[string]int{"filesChanged": filesChanged, "replacements": replacements})
}

func (h *handlers) getTagListFile(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"file": h.store.GetTagListFile()})
}

func (h *handlers) setTagListFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		File string `json:"file"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if err := h.store.SetTagListFile(req.File); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"file": req.File})
}

func (h *handlers) getHomeDir(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"dir": h.store.Dir()})
}

func (h *handlers) setHomeDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Dir == "" {
		http.Error(w, "missing dir", http.StatusBadRequest)
		return
	}
	if err := h.store.SetDir(req.Dir); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"dir": req.Dir})
}

func (h *handlers) getJournalDir(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"dir": h.store.GetJournalDir()})
}

func (h *handlers) setJournalDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	// Empty string = revert to default (journal/ under home folder)
	if err := h.store.SetJournalDir(req.Dir); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"dir": req.Dir})
}

func (h *handlers) browseDir(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" || path == "." {
		path = h.store.Dir()
	}
	path = filepath.Clean(path)

	entries, err := os.ReadDir(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ext := r.URL.Query().Get("ext") // e.g. ".org" to also list matching files
	var dirs, files []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		} else if ext != "" && strings.HasSuffix(e.Name(), ext) {
			files = append(files, e.Name())
		}
	}
	parent := filepath.Dir(path)
	if parent == path {
		parent = ""
	}
	writeJSON(w, map[string]interface{}{
		"path":   path,
		"parent": parent,
		"dirs":   dirs,
		"files":  files,
	})
}

func (h *handlers) searchText(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	results, err := h.store.SearchText(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if results == nil {
		results = []orgfile.TextSearchResult{}
	}
	writeJSON(w, map[string]interface{}{"results": results})
}

func (h *handlers) searchTag(w http.ResponseWriter, r *http.Request) {
	tag := r.URL.Query().Get("q")
	if tag == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	results, err := h.store.SearchTag(tag)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if results == nil {
		results = []orgfile.TagSearchResult{}
	}
	writeJSON(w, map[string]interface{}{"results": results})
}

func (h *handlers) getAgenda(w http.ResponseWriter, r *http.Request) {
	items, err := h.store.ScanAgenda()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []orgfile.AgendaItem{}
	}
	writeJSON(w, map[string]interface{}{"items": items})
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
