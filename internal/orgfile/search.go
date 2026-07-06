package orgfile

import (
	"os"
	"path/filepath"
	"strings"

	"epicorg/internal/model"
)

// TagSearchResult describes a single outline node that carries a specific tag.
type TagSearchResult struct {
	File      string   `json:"file"`      // relative path from home dir (e.g. "notes.org" or "sub/notes.org")
	Title     string   `json:"title"`
	Context   string   `json:"context"`
	Tags      []string `json:"tags"`
	InSubdir  bool     `json:"inSubdir"` // true when file is not in the root dir
}

// SearchTagWorkspace walks the workspace described by cfg and returns all outline
// nodes whose tag list contains tag (case-insensitive). Hidden directories are skipped.
// Files are read directly without updating per-file merge-base state.
// For homeDir files (rootLabel == ""), File is the relative displayName.
// For other-root files, File is the absolute path.
func (s *Store) SearchTagWorkspace(tag string, cfg *WorkspaceConfig) ([]TagSearchResult, error) {
	lowerTag := strings.ToLower(tag)
	var results []TagSearchResult

	err := WalkWorkspace(cfg, func(absPath, displayName, rootLabel string) error {
		fileID := displayName
		if rootLabel != "" {
			fileID = absPath
		}

		data, err := readFileSafe(absPath)
		if err != nil {
			return nil
		}
		doc := parseOrg(string(data), filepath.Base(absPath))
		items := model.FromDocument(doc)
		for i, item := range items {
			if item.IsBody || !containsTagCI(item.Tags, lowerTag) {
				continue
			}
			context := ""
			if i+1 < len(items) && items[i+1].IsBody {
				body := items[i+1].Title
				if nl := strings.IndexByte(body, '\n'); nl >= 0 {
					context = strings.TrimSpace(body[:nl])
				} else {
					context = strings.TrimSpace(body)
				}
				runes := []rune(context)
				if len(runes) > 120 {
					context = string(runes[:120]) + "…"
				}
			}
			results = append(results, TagSearchResult{
				File:     fileID,
				Title:    item.Title,
				Context:  context,
				Tags:     item.Tags,
				InSubdir: strings.Contains(displayName, "/"),
			})
		}
		return nil
	})
	return results, err
}

// SearchTag walks the entire home directory tree and returns all outline nodes
// whose tag list contains tag (case-insensitive). Hidden directories are skipped.
// Files are read directly without updating per-file merge-base state.
// Delegates to SearchTagWorkspace with the default (homeDir-only) workspace.
func (s *Store) SearchTag(tag string) ([]TagSearchResult, error) {
	return s.SearchTagWorkspace(tag, DefaultWorkspace(s.Dir()))
}

func readFileSafe(path string) ([]byte, error) { return os.ReadFile(path) }

func containsTagCI(tags []string, lowerTag string) bool {
	for _, t := range tags {
		if strings.ToLower(t) == lowerTag {
			return true
		}
	}
	return false
}
