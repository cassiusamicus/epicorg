package orgfile

import (
	"io/fs"
	"path/filepath"
	"strings"
	"unicode"

	"epicorg/internal/model"
)

// TextSearchResult describes a headline or body block that matched a text query.
type TextSearchResult struct {
	File     string `json:"file"`
	Title    string `json:"title"`   // headline of the matched node
	Context  string `json:"context"` // snippet showing the matched text
	InSubdir bool   `json:"inSubdir"`
}

// SearchText walks the entire home directory tree and returns nodes whose
// title or body text contains all of the space-separated terms in query
// (case-insensitive). Quoted phrases are matched as a unit.
func (s *Store) SearchText(query string) ([]TextSearchResult, error) {
	terms := parseTerms(query)
	if len(terms) == 0 {
		return nil, nil
	}

	dir := s.Dir()
	var results []TextSearchResult

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		if d.IsDir() {
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
		rel = filepath.ToSlash(rel)

		data, err := readFileSafe(path)
		if err != nil {
			return nil
		}
		doc := parseOrg(string(data), d.Name())
		items := model.FromDocument(doc)

		for i, item := range items {
			if item.IsBody {
				continue
			}
			// Build the searchable text for this node: title + body (if any)
			body := ""
			if i+1 < len(items) && items[i+1].IsBody {
				body = items[i+1].Title
			}
			combined := item.Title + "\n" + body

			if !allTermsMatch(terms, combined) {
				continue
			}

			context := buildContext(terms, item.Title, body)
			results = append(results, TextSearchResult{
				File:     rel,
				Title:    item.Title,
				Context:  context,
				InSubdir: strings.Contains(rel, "/"),
			})
		}
		return nil
	})
	return results, err
}

// parseTerms splits a query into terms, honouring "quoted phrases".
func parseTerms(query string) []string {
	var terms []string
	query = strings.TrimSpace(query)
	i := 0
	for i < len(query) {
		for i < len(query) && unicode.IsSpace(rune(query[i])) {
			i++
		}
		if i >= len(query) {
			break
		}
		if query[i] == '"' {
			// quoted phrase
			i++
			start := i
			for i < len(query) && query[i] != '"' {
				i++
			}
			phrase := strings.TrimSpace(query[start:i])
			if phrase != "" {
				terms = append(terms, phrase)
			}
			if i < len(query) {
				i++ // skip closing quote
			}
		} else {
			start := i
			for i < len(query) && !unicode.IsSpace(rune(query[i])) {
				i++
			}
			word := query[start:i]
			if word != "" {
				terms = append(terms, word)
			}
		}
	}
	return terms
}

func allTermsMatch(terms []string, text string) bool {
	lower := strings.ToLower(text)
	for _, t := range terms {
		if !strings.Contains(lower, strings.ToLower(t)) {
			return false
		}
	}
	return true
}

// buildContext finds the first term occurrence and returns a ±60-char snippet.
func buildContext(terms []string, title, body string) string {
	// Prefer a snippet from body if the match is there; else use title.
	for _, src := range []string{body, title} {
		if src == "" {
			continue
		}
		lower := strings.ToLower(src)
		for _, t := range terms {
			idx := strings.Index(lower, strings.ToLower(t))
			if idx < 0 {
				continue
			}
			start := idx - 60
			if start < 0 {
				start = 0
			}
			end := idx + len(t) + 60
			if end > len(src) {
				end = len(src)
			}
			snippet := strings.TrimSpace(src[start:end])
			// Collapse newlines to spaces for display
			snippet = strings.ReplaceAll(snippet, "\n", " ")
			if start > 0 {
				snippet = "…" + snippet
			}
			if end < len(src) {
				snippet = snippet + "…"
			}
			return snippet
		}
	}
	return ""
}
