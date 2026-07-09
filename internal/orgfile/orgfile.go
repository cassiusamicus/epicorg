package orgfile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/niklasfasching/go-org/org"
	"epicorg/internal/git"
)

// Store manages a directory of org files with hash-based change detection.
type Store struct {
	dir              string
	journalDir       string // optional override; empty = dir/journal
	tagListFile      string // optional override full path; empty = {dir}/TagList.org
	bookmarkListFile string // optional override full path; empty = {dir}/Bookmarks.org
	mu               sync.RWMutex
	active           map[string]*FileState
	currentFile      string // the file currently being edited
}

// epicorgConfig holds global settings persisted to ~/.config/epicorg/config.json.
type epicorgConfig struct {
	JournalDir       string `json:"journalDir,omitempty"`
	TagListFile      string `json:"tagListFile,omitempty"`      // full path to the active tag list .org file
	BookmarkListFile string `json:"bookmarkListFile,omitempty"` // full path to the active bookmark list .org file
}

func globalConfigPath() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "epicorg", "config.json")
}

func loadGlobalConfig() epicorgConfig {
	var cfg epicorgConfig
	if data, err := os.ReadFile(globalConfigPath()); err == nil {
		json.Unmarshal(data, &cfg) //nolint:errcheck — tolerate corrupt config
	}
	return cfg
}

func saveGlobalConfig(cfg epicorgConfig) error {
	p := globalConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0644)
}

// FileState holds the parsed state and merge base for a single file.
type FileState struct {
	Doc         *org.Document
	Preamble    string
	Meta        Meta
	BaseHash    string // SHA-256 of content at time of load/last save
	BaseContent string // content at time of load/last save (merge ancestor)
}

// Meta holds UI state stored in a sidecar file.
type Meta struct {
	Collapsed map[string]bool `json:"collapsed,omitempty"`
}

// NewStore opens a directory, ensures it's a git repo, and commits current state.
func NewStore(dir string) (*Store, error) {
	// Resolve to an absolute path up front — dir may arrive relative (e.g.
	// "." from `make run`, or a bare directory name), and callers such as
	// the file picker's current-path display depend on Dir() always being
	// the full, unambiguous path rather than whatever form was passed in.
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, os.ErrInvalid
	}

	if err := git.EnsureRepo(dir); err != nil {
		return nil, err
	}

	cfg := loadGlobalConfig()
	return &Store{
		dir:              dir,
		journalDir:       cfg.JournalDir,
		tagListFile:      cfg.TagListFile,
		bookmarkListFile: cfg.BookmarkListFile,
		active:           make(map[string]*FileState),
	}, nil
}

// GetJournalDir returns the configured journal directory (empty = default journal/ subdir).
func (s *Store) GetJournalDir() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.journalDir
}

// SetJournalDir changes the journal directory and persists it to the global config.
// Pass an empty string to revert to the default (journal/ under the home folder).
func (s *Store) SetJournalDir(dir string) error {
	if dir != "" {
		dir = filepath.Clean(dir)
		info, err := os.Stat(dir)
		if err != nil {
			return fmt.Errorf("cannot access journal directory: %w", err)
		}
		if !info.IsDir() {
			return fmt.Errorf("%q is not a directory", dir)
		}
	}
	s.mu.Lock()
	s.journalDir = dir
	s.mu.Unlock()

	cfg := loadGlobalConfig()
	cfg.JournalDir = dir
	return saveGlobalConfig(cfg)
}

// GetTagListFile returns the configured tag list file path (empty = default: {workspaceDir}/TagList.org).
func (s *Store) GetTagListFile() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tagListFile
}

// SetTagListFile sets the full path to the active tag list .org file, persisting globally.
// Pass an empty string to revert to {workspaceDir}/TagList.org.
func (s *Store) SetTagListFile(path string) error {
	if path != "" {
		path = filepath.Clean(path)
		info, err := os.Stat(path)
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("cannot access tag list file: %w", err)
		}
		if err == nil && info.IsDir() {
			return fmt.Errorf("%q is a directory, not a file", path)
		}
	}
	s.mu.Lock()
	s.tagListFile = path
	s.mu.Unlock()

	cfg := loadGlobalConfig()
	cfg.TagListFile = path
	return saveGlobalConfig(cfg)
}

// GetBookmarkListFile returns the configured bookmark list file path (empty = default: {workspaceDir}/Bookmarks.org).
func (s *Store) GetBookmarkListFile() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bookmarkListFile
}

// SetBookmarkListFile sets the full path to the active bookmark list .org file, persisting globally.
// Pass an empty string to revert to {workspaceDir}/Bookmarks.org.
func (s *Store) SetBookmarkListFile(path string) error {
	if path != "" {
		path = filepath.Clean(path)
		info, err := os.Stat(path)
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("cannot access bookmark list file: %w", err)
		}
		if err == nil && info.IsDir() {
			return fmt.Errorf("%q is a directory, not a file", path)
		}
	}
	s.mu.Lock()
	s.bookmarkListFile = path
	s.mu.Unlock()

	cfg := loadGlobalConfig()
	cfg.BookmarkListFile = path
	return saveGlobalConfig(cfg)
}

// resolveFilePath returns the absolute filesystem path for a logical file name.
// Names starting with "journal/" are redirected to journalDir when configured.
// Absolute paths (from the filesystem browser) are returned as-is.
func (s *Store) resolveFilePath(name string) string {
	if filepath.IsAbs(name) {
		return filepath.Clean(name)
	}
	if s.journalDir != "" && strings.HasPrefix(name, "journal/") {
		return filepath.Join(s.journalDir, strings.TrimPrefix(name, "journal/"))
	}
	return filepath.Join(s.dir, name)
}

// Dir returns the directory path.
func (s *Store) Dir() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dir
}

// SetDir changes the working directory at runtime. All cached file state is
// cleared and git is initialized in the new directory.
func (s *Store) SetDir(dir string) error {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	} else {
		dir = filepath.Clean(dir)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("cannot access directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%q is not a directory", dir)
	}
	if err := git.EnsureRepo(dir); err != nil {
		return fmt.Errorf("cannot initialize git repo: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dir = dir
	s.active = make(map[string]*FileState)
	s.currentFile = ""
	return nil
}

// FileInfo describes a single org file for the file picker.
type FileInfo struct {
	Name    string    `json:"name"`
	Root    string    `json:"root,omitempty"` // display label for the root; empty for homeDir files
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

// ListFilesWorkspace returns .org file info for all included workspace paths, sorted by name.
// For homeDir files (rootLabel == ""), Name is the displayName relative to the root.
// For files from other roots, Name is the absolute path and Root is the root folder name.
func (s *Store) ListFilesWorkspace(cfg *WorkspaceConfig) ([]FileInfo, error) {
	var files []FileInfo

	err := WalkWorkspace(cfg, func(absPath, displayName, rootLabel string) error {
		info, err := os.Stat(absPath)
		if err != nil {
			return nil
		}
		name := displayName
		if rootLabel != "" {
			name = absPath
		}
		files = append(files, FileInfo{
			Name:    name,
			Root:    rootLabel,
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files, nil
}

// ListFiles returns .org file info for the directory, sorted by name.
// The frontend re-sorts client-side, so the exact order here only matters
// for determinism.
// Delegates to ListFilesWorkspace with the default (homeDir-only) workspace.
func (s *Store) ListFiles() ([]FileInfo, error) {
	return s.ListFilesWorkspace(DefaultWorkspace(s.Dir()))
}

// LoadFile reads and parses an org file, storing its content as the merge base.
func (s *Store) LoadFile(name string) (*FileState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.resolveFilePath(name)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	content := string(data)
	preamble := strings.TrimRight(extractPreamble(content), "\n")

	conf := org.New()
	doc := conf.Parse(strings.NewReader(content), path)

	meta := loadMeta(path + ".meta.json")

	// Commit current disk state as merge base before editing
	git.CommitFile(s.dir, name, "epicorg: snapshot base for "+name)

	fs := &FileState{
		Doc:         doc,
		Preamble:    preamble,
		Meta:        meta,
		BaseHash:    contentHash(content),
		BaseContent: content,
	}
	s.active[name] = fs
	s.currentFile = name
	return fs, nil
}

// ReadRawFile resolves name (same convention as LoadFile — relative to the
// store dir, or absolute for files outside it) and returns its raw text
// content verbatim, with no org/markdown parsing and no side effects (no
// git snapshot, not marked as the active file). Used for read-only preview
// of files that shouldn't be treated as edit targets, like Markdown search
// results.
func (s *Store) ReadRawFile(name string) (string, error) {
	s.mu.RLock()
	path := s.resolveFilePath(name)
	s.mu.RUnlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SaveResult reports the outcome of SaveFile, including the merged
// document when an external edit was detected so the caller can hand the
// reconciled content back to the client instead of letting it re-overwrite
// the merge on the next save.
type SaveResult struct {
	Hash           string
	ExternalChange bool
	Conflict       bool
	Doc            *org.Document // merged document; set only if ExternalChange
	Preamble       string        // merged preamble; set only if ExternalChange
}

// SaveFile writes content to disk with hash-based conflict detection.
// If the file changed on disk since our base, performs a three-way merge.
func (s *Store) SaveFile(name, content string) (SaveResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.resolveFilePath(name)
	fs := s.active[name]

	// Read what's currently on disk
	diskData, diskErr := os.ReadFile(path)
	if diskErr != nil && !os.IsNotExist(diskErr) {
		return SaveResult{}, diskErr
	}
	diskContent := string(diskData)
	diskHash := contentHash(diskContent)

	// Did the file change externally since we last loaded/saved?
	if fs != nil && diskHash != fs.BaseHash {
		// External edit detected — three-way merge
		merged, hasConflicts, mergeErr := git.MergeFile(content, fs.BaseContent, diskContent)
		if mergeErr != nil {
			return SaveResult{}, mergeErr
		}
		if err := os.WriteFile(path, []byte(merged), 0644); err != nil {
			return SaveResult{}, err
		}
		h := contentHash(merged)
		fs.BaseHash = h
		fs.BaseContent = merged
		fs.Doc = parseOrg(merged, path)
		fs.Preamble = strings.TrimRight(extractPreamble(merged), "\n")
		return SaveResult{Hash: h, ExternalChange: true, Conflict: hasConflicts, Doc: fs.Doc, Preamble: fs.Preamble}, nil
	}

	// No external changes — just overwrite
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return SaveResult{}, err
	}
	h := contentHash(content)
	if fs != nil {
		fs.BaseHash = h
		fs.BaseContent = content
		fs.Doc = parseOrg(content, path)
		fs.Preamble = strings.TrimRight(extractPreamble(content), "\n")
	}
	return SaveResult{Hash: h}, nil
}

// DiskHash returns the current SHA-256 hash of the file's on-disk content
// without touching git or any in-memory parsed state — cheap enough to poll.
func (s *Store) DiskHash(name string) (string, error) {
	data, err := os.ReadFile(s.resolveFilePath(name))
	if err != nil {
		if os.IsNotExist(err) {
			return contentHash(""), nil
		}
		return "", err
	}
	return contentHash(string(data)), nil
}

// CreateFile creates a new org file with optional initial content.
func (s *Store) CreateFile(name, content string) error {
	path := filepath.Join(s.dir, name)
	if _, err := os.Stat(path); err == nil {
		return os.ErrExist
	}
	return os.WriteFile(path, []byte(content), 0644)
}

// DeleteFile removes name from disk, along with its collapsed-state
// sidecar and any favorites entry, and commits the deletion to git (so
// it's recoverable from history even though there's no in-app undo).
func (s *Store) DeleteFile(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := filepath.Join(s.dir, name)
	if err := os.Remove(path); err != nil {
		return err
	}
	os.Remove(path + ".meta.json") // best-effort; sidecar may not exist

	delete(s.active, name)
	if s.currentFile == name {
		s.currentFile = ""
	}

	if favs, err := s.readFavoritesLocked(); err == nil {
		for i, f := range favs {
			if f == name {
				s.writeFavoritesLocked(append(favs[:i], favs[i+1:]...))
				break
			}
		}
	}

	return git.CommitFile(s.dir, name, "epicorg: delete "+name)
}

// RenameFile renames name to newName on disk, carrying over its collapsed
// state sidecar and favorites entry, and commits the rename to git.
func (s *Store) RenameFile(name, newName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	oldPath := filepath.Join(s.dir, name)
	newPath := filepath.Join(s.dir, newName)
	if _, err := os.Stat(newPath); err == nil {
		return os.ErrExist
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	os.Rename(oldPath+".meta.json", newPath+".meta.json") // best-effort

	if fs, ok := s.active[name]; ok {
		delete(s.active, name)
		s.active[newName] = fs
	}
	if s.currentFile == name {
		s.currentFile = newName
	}

	if favs, err := s.readFavoritesLocked(); err == nil {
		for i, f := range favs {
			if f == name {
				favs[i] = newName
				sort.Strings(favs)
				s.writeFavoritesLocked(favs)
				break
			}
		}
	}

	return git.CommitFiles(s.dir, []string{name, newName}, "epicorg: rename "+name+" to "+newName)
}

// SaveMeta writes collapsed state to the sidecar file.
func (s *Store) SaveMeta(name string, collapsed map[string]bool) {
	path := filepath.Join(s.dir, name) + ".meta.json"
	data, _ := json.Marshal(Meta{Collapsed: collapsed})
	os.WriteFile(path, data, 0644)
}

// favoritesPath returns the workspace-level favorites sidecar path.
// Favorites are shared across whoever opens this directory (unlike Recent
// Files, which is per-browser), so they live alongside the org files rather
// than in the client's localStorage.
func (s *Store) favoritesPath() string {
	return filepath.Join(s.dir, ".epicorg-favorites.json")
}

// GetFavorites returns the list of favorited filenames.
func (s *Store) GetFavorites() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.readFavoritesLocked()
}

// SetFavorite adds or removes name from the favorites list and returns the
// updated list.
func (s *Store) SetFavorite(name string, favorite bool) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	favs, err := s.readFavoritesLocked()
	if err != nil {
		return nil, err
	}

	idx := -1
	for i, f := range favs {
		if f == name {
			idx = i
			break
		}
	}
	if favorite && idx == -1 {
		favs = append(favs, name)
	} else if !favorite && idx != -1 {
		favs = append(favs[:idx], favs[idx+1:]...)
	}
	sort.Strings(favs)

	if err := s.writeFavoritesLocked(favs); err != nil {
		return nil, err
	}
	return favs, nil
}

// writeFavoritesLocked persists favs to the sidecar. Caller must hold s.mu.
func (s *Store) writeFavoritesLocked(favs []string) error {
	data, err := json.Marshal(struct {
		Favorites []string `json:"favorites"`
	}{Favorites: favs})
	if err != nil {
		return err
	}
	return os.WriteFile(s.favoritesPath(), data, 0644)
}

func (s *Store) readFavoritesLocked() ([]string, error) {
	data, err := os.ReadFile(s.favoritesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	var parsed struct {
		Favorites []string `json:"favorites"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return []string{}, nil // tolerate a corrupt sidecar rather than failing the whole request
	}
	if parsed.Favorites == nil {
		return []string{}, nil
	}
	return parsed.Favorites, nil
}

// CommitCurrent commits the currently active file to git.
func (s *Store) CommitCurrent(message string) error {
	s.mu.RLock()
	name := s.currentFile
	s.mu.RUnlock()
	if name == "" {
		return nil
	}
	return git.CommitFile(s.dir, name, message)
}

// ListJournalFiles returns file info for all .org files in the journal directory,
// sorted in reverse chronological order (newest first).
func (s *Store) ListJournalFiles() ([]FileInfo, error) {
	s.mu.RLock()
	dir := s.dir
	jDir := s.journalDir
	s.mu.RUnlock()

	journalDir := jDir
	if journalDir == "" {
		journalDir = filepath.Join(dir, "journal")
	}
	entries, err := os.ReadDir(journalDir)
	if os.IsNotExist(err) {
		return []FileInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	var files []FileInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".org") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:    "journal/" + e.Name(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	// Reverse chronological (newest first)
	sort.Slice(files, func(i, j int) bool { return files[i].Name > files[j].Name })
	return files, nil
}

// CreateJournalFile creates a daily journal file at the configured journal directory.
// Does nothing if the file already exists.
func (s *Store) CreateJournalFile(name string) error {
	s.mu.RLock()
	dir := s.dir
	jDir := s.journalDir
	s.mu.RUnlock()

	var targetDir string
	if jDir != "" {
		targetDir = jDir
	} else {
		targetDir = filepath.Join(dir, "journal")
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return err
	}
	path := filepath.Join(targetDir, filepath.Base(name))
	if _, err := os.Stat(path); err == nil {
		return nil // already exists
	}
	base := filepath.Base(name)
	dateStr := strings.TrimSuffix(base, ".org")
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return fmt.Errorf("invalid date in journal filename: %w", err)
	}
	content := fmt.Sprintf("#+TITLE: %s\n#+DATE: [%s %s]\n\n",
		t.Format("2006-01-02"),
		t.Format("2006-01-02"),
		t.Format("Mon"),
	)
	return os.WriteFile(path, []byte(content), 0644)
}

// --- helpers ---

func contentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

func extractPreamble(content string) string {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if len(line) > 0 && line[0] == '*' {
			if i == 0 {
				return ""
			}
			return strings.Join(lines[:i], "\n") + "\n"
		}
	}
	return content
}

func parseOrg(content, path string) *org.Document {
	conf := org.New()
	return conf.Parse(strings.NewReader(content), path)
}

// ParseText parses raw org content into a document and its preamble,
// without touching any file on disk or the Store's load/save state. Used
// by the text-mode round trip, where the frontend hands back freely-edited
// raw text to be reparsed into the node tree.
func ParseText(content string) (*org.Document, string) {
	doc := parseOrg(content, "")
	preamble := strings.TrimRight(extractPreamble(content), "\n")
	return doc, preamble
}

func loadMeta(path string) Meta {
	meta := Meta{Collapsed: make(map[string]bool)}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &meta)
		if meta.Collapsed == nil {
			meta.Collapsed = make(map[string]bool)
		}
	}
	return meta
}
