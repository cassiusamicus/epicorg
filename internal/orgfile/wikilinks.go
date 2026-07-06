package orgfile

import (
	"io/fs"
	"path/filepath"
	"strings"

	"epicorg/internal/model"
)

// WikiLinkEntry pairs an org filename with its human-readable title.
type WikiLinkEntry struct {
	File  string `json:"file"`
	Title string `json:"title"`
}

// WikiLinkEntries returns all .org files in the workspace with their titles.
// Title comes from #+TITLE: in the preamble; falls back to a humanized filename.
func (s *Store) WikiLinkEntries() ([]WikiLinkEntry, error) {
	dir := s.Dir()
	var entries []WikiLinkEntry

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
		entries = append(entries, WikiLinkEntry{
			File:  rel,
			Title: wikiTitle(string(data), d.Name()),
		})
		return nil
	})
	return entries, err
}

// BacklinkSearch finds all nodes across the workspace that reference selfFile,
// matching both [[Title]] wiki-links and [[file:selfFile...]] file-link syntax.
func (s *Store) BacklinkSearch(title, selfFile string) ([]TextSearchResult, error) {
	if title == "" && selfFile == "" {
		return nil, nil
	}

	// Build the set of patterns to treat as a backlink.
	// Match [[Title]] (wiki-link) and [[file:selfFile (file link, bare or labeled).
	var pats []string
	if title != "" {
		pats = append(pats, strings.ToLower("[["+title+"]]"))
	}
	if selfFile != "" {
		pats = append(pats, strings.ToLower("[[file:"+selfFile))
	}

	anyMatch := func(text string) bool {
		lower := strings.ToLower(text)
		for _, p := range pats {
			if strings.Contains(lower, p) {
				return true
			}
		}
		return false
	}

	// For buildContext: use the wiki-link pattern if present, else the file pattern.
	contextTerm := "[[" + title + "]]"
	if title == "" {
		contextTerm = "[[file:" + selfFile
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
		if rel == selfFile {
			return nil // skip self
		}
		data, err := readFileSafe(path)
		if err != nil {
			return nil
		}
		content := string(data)
		if !anyMatch(content) {
			return nil // fast path: skip file entirely
		}
		doc := parseOrg(content, d.Name())
		items := model.FromDocument(doc)
		for i, item := range items {
			if item.IsBody {
				continue
			}
			body := ""
			if i+1 < len(items) && items[i+1].IsBody {
				body = items[i+1].Title
			}
			combined := item.Title + "\n" + body
			if !anyMatch(combined) {
				continue
			}
			ctx := buildContext([]string{contextTerm}, item.Title, body)
			results = append(results, TextSearchResult{
				File:     rel,
				Title:    item.Title,
				Context:  ctx,
				InSubdir: strings.Contains(rel, "/"),
			})
		}
		return nil
	})
	return results, err
}

// UnlinkedMentions finds nodes where title appears as plain text but no formal
// [[Title]] or [[file:selfFile]] link exists in that node. Used to surface
// potential connections the user hasn't linked yet.
func (s *Store) UnlinkedMentions(title, selfFile string) ([]TextSearchResult, error) {
	if title == "" {
		return nil, nil
	}
	titleLower := strings.ToLower(title)
	formalPats := []string{strings.ToLower("[[" + title + "]]")}
	if selfFile != "" {
		formalPats = append(formalPats, strings.ToLower("[[file:"+selfFile))
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
		if rel == selfFile {
			return nil
		}
		data, err := readFileSafe(path)
		if err != nil {
			return nil
		}
		content := string(data)
		if !strings.Contains(strings.ToLower(content), titleLower) {
			return nil
		}
		doc := parseOrg(content, d.Name())
		items := model.FromDocument(doc)
		for i, item := range items {
			if item.IsBody {
				continue
			}
			body := ""
			if i+1 < len(items) && items[i+1].IsBody {
				body = items[i+1].Title
			}
			combined := item.Title + "\n" + body
			combinedLower := strings.ToLower(combined)
			if !strings.Contains(combinedLower, titleLower) {
				continue
			}
			hasFormal := false
			for _, p := range formalPats {
				if strings.Contains(combinedLower, p) {
					hasFormal = true
					break
				}
			}
			if hasFormal {
				continue
			}
			ctx := buildContext([]string{title}, item.Title, body)
			results = append(results, TextSearchResult{
				File:     rel,
				Title:    item.Title,
				Context:  ctx,
				InSubdir: strings.Contains(rel, "/"),
			})
		}
		return nil
	})
	return results, err
}

// wikiTitle extracts #+TITLE: from preamble, falling back to a humanized filename.
func wikiTitle(content, filename string) string {
	for _, line := range strings.SplitN(content, "\n", 30) {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToUpper(trimmed), "#+TITLE:") {
			t := strings.TrimSpace(trimmed[8:])
			if t != "" {
				return t
			}
		}
		if strings.HasPrefix(trimmed, "*") {
			break // first headline — preamble is over
		}
	}
	// Humanize filename: strip .org, split on dashes/underscores, title-case
	base := strings.TrimSuffix(filename, ".org")
	words := strings.FieldsFunc(base, func(r rune) bool { return r == '-' || r == '_' })
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}
