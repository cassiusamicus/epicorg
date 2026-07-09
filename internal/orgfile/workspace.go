package orgfile

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// WorkspacePath is one entry in the workspace config.
type WorkspacePath struct {
	Path     string `json:"path"`     // absolute path
	Included bool   `json:"included"` // true=include, false=exclude
}

// WorkspaceConfig holds the workspace definition.
type WorkspaceConfig struct {
	Paths []WorkspacePath `json:"paths"`
}

// DefaultWorkspace returns a WorkspaceConfig with homeDir as the single included path.
func DefaultWorkspace(homeDir string) *WorkspaceConfig {
	return &WorkspaceConfig{
		Paths: []WorkspacePath{{Path: homeDir, Included: true}},
	}
}

// LoadWorkspace reads ~/.config/epicorg/workspace.json.
// If the file is missing or unreadable, it returns a default workspace with homeDir included.
func LoadWorkspace(homeDir string) (*WorkspaceConfig, error) {
	dir, err := epicorgConfigDir()
	if err != nil {
		return DefaultWorkspace(homeDir), nil
	}
	data, err := os.ReadFile(filepath.Join(dir, "workspace.json"))
	if os.IsNotExist(err) {
		return DefaultWorkspace(homeDir), nil
	}
	if err != nil {
		return nil, err
	}
	var cfg WorkspaceConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return DefaultWorkspace(homeDir), nil
	}
	return &cfg, nil
}

// SaveWorkspace writes the workspace config to ~/.config/epicorg/workspace.json.
func SaveWorkspace(cfg *WorkspaceConfig) error {
	dir, err := epicorgConfigDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "workspace.json"), data, 0644)
}

// WalkWorkspace walks all included paths in cfg, calling fn for each .org file found.
//
//   - absPath is the absolute filesystem path to the file.
//   - displayName is the path relative to the root, with forward slashes
//     (e.g. "notes.org" or "subdir/notes.org").
//   - rootLabel is the last segment of the root directory path; it is empty for
//     the first included path (maintaining backward compatibility with homeDir files).
//
// Hidden directories are skipped. Excluded subtrees (Included=false entries) are skipped.
// Duplicate absolute paths are skipped.
func WalkWorkspace(cfg *WorkspaceConfig, fn func(absPath, displayName, rootLabel string) error) error {
	return WalkWorkspaceExts(cfg, []string{".org"}, fn)
}

// WalkWorkspaceExts is like WalkWorkspace but matches files by any of the
// given extensions (case-insensitive) instead of just ".org" — e.g. to also
// pick up ".md" files when searching.
func WalkWorkspaceExts(cfg *WorkspaceConfig, exts []string, fn func(absPath, displayName, rootLabel string) error) error {
	matchesExt := func(name string) bool {
		name = strings.ToLower(name)
		for _, e := range exts {
			if strings.HasSuffix(name, strings.ToLower(e)) {
				return true
			}
		}
		return false
	}

	// Build a set of excluded absolute paths.
	excluded := make(map[string]bool)
	for _, p := range cfg.Paths {
		if !p.Included {
			excluded[filepath.Clean(p.Path)] = true
		}
	}

	// Track seen absolute paths to avoid visiting the same file twice
	// when included roots overlap.
	seen := make(map[string]bool)

	firstIncluded := true

	for _, p := range cfg.Paths {
		if !p.Included {
			continue
		}
		root := filepath.Clean(p.Path)

		rootLabel := ""
		if !firstIncluded {
			rootLabel = filepath.Base(root)
		}
		firstIncluded = false

		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, werr error) error {
			if werr != nil {
				return nil // skip unreadable entries without aborting
			}
			absPath := filepath.Clean(path)

			if d.IsDir() {
				// Skip hidden directories (but never skip the root itself).
				if absPath != root && d.Name() != "." && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				// Skip excluded subtrees (but never skip the root itself).
				if absPath != root && excluded[absPath] {
					return filepath.SkipDir
				}
				return nil
			}

			if !matchesExt(d.Name()) {
				return nil
			}

			// Skip files we've already visited.
			if seen[absPath] {
				return nil
			}
			seen[absPath] = true

			rel, err := filepath.Rel(root, absPath)
			if err != nil {
				return nil
			}
			displayName := filepath.ToSlash(rel)

			return fn(absPath, displayName, rootLabel)
		})
		if err != nil {
			return err
		}
	}
	return nil
}
