package orgfile

import (
	"io/fs"
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

// SearchTag walks the entire home directory tree and returns all outline nodes
// whose tag list contains tag (case-insensitive). Hidden directories are skipped.
// Files are read directly without updating per-file merge-base state.
func (s *Store) SearchTag(tag string) ([]TagSearchResult, error) {
	dir := s.Dir() // uses the read-lock accessor
	lowerTag := strings.ToLower(tag)
	var results []TagSearchResult

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // skip unreadable entries without aborting
		}
		if d.IsDir() {
			// Skip hidden directories (e.g. .git)
			if d.Name() != "." && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".org") {
			return nil
		}

		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel) // use forward slashes in results

		data, err := readFileSafe(path)
		if err != nil {
			return nil
		}
		doc := parseOrg(string(data), d.Name())
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
				File:     rel,
				Title:    item.Title,
				Context:  context,
				Tags:     item.Tags,
				InSubdir: strings.Contains(rel, "/"),
			})
		}
		return nil
	})
	return results, err
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
