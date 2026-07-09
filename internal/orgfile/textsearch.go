package orgfile

import (
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

// SearchTextWorkspace walks the workspace described by cfg and returns nodes whose
// title or body text contains all of the space-separated terms in query
// (case-insensitive). Quoted phrases are matched as a unit.
// For homeDir files (rootLabel == ""), File is the relative displayName.
// For other-root files, File is the absolute path.
// Org files only; see SearchTextWorkspaceOpts to also include Markdown files.
func (s *Store) SearchTextWorkspace(query string, cfg *WorkspaceConfig) ([]TextSearchResult, error) {
	return s.SearchTextWorkspaceOpts(query, cfg, false)
}

// SearchTextWorkspaceOpts is SearchTextWorkspace with an option to also
// search ".md" files. Markdown files have no org headline/body structure,
// so each file is split into sections by its ATX (#) headings instead —
// each heading plus the text under it (up to the next heading) is treated
// like one org item's title+body for matching and snippet purposes.
func (s *Store) SearchTextWorkspaceOpts(query string, cfg *WorkspaceConfig, includeMarkdown bool) ([]TextSearchResult, error) {
	terms := parseTerms(query)
	if len(terms) == 0 {
		return nil, nil
	}

	exts := []string{".org"}
	if includeMarkdown {
		exts = append(exts, ".md")
	}

	var results []TextSearchResult

	err := WalkWorkspaceExts(cfg, exts, func(absPath, displayName, rootLabel string) error {
		fileID := displayName
		if rootLabel != "" {
			fileID = absPath
		}

		data, err := readFileSafe(absPath)
		if err != nil {
			return nil
		}

		if strings.HasSuffix(strings.ToLower(absPath), ".md") {
			for _, sec := range splitMarkdownSections(string(data), filepath.Base(absPath)) {
				if !allTermsMatch(terms, sec.title, sec.body, nil, "") {
					continue
				}
				results = append(results, TextSearchResult{
					File:     fileID,
					Title:    sec.title,
					Context:  buildContext(terms, sec.title, sec.body),
					InSubdir: strings.Contains(displayName, "/"),
				})
			}
			return nil
		}

		doc := parseOrg(string(data), filepath.Base(absPath))
		items := model.FromDocument(doc)

		for i, item := range items {
			if item.IsBody {
				continue
			}
			body := ""
			if i+1 < len(items) && items[i+1].IsBody {
				body = items[i+1].Title
			}

			if !allTermsMatch(terms, item.Title, body, item.Tags, item.Status) {
				continue
			}

			context := buildContext(terms, item.Title, body)
			results = append(results, TextSearchResult{
				File:     fileID,
				Title:    item.Title,
				Context:  context,
				InSubdir: strings.Contains(displayName, "/"),
			})
		}
		return nil
	})
	return results, err
}

type markdownSection struct {
	title string
	body  string
}

// splitMarkdownSections splits markdown text into sections at each ATX (#)
// heading. Content before the first heading (if any) is grouped under
// fallbackTitle (the filename), matching how a headline-less org preamble
// would otherwise be invisible to search.
func splitMarkdownSections(content, fallbackTitle string) []markdownSection {
	var sections []markdownSection
	cur := markdownSection{title: fallbackTitle}
	var bodyLines []string

	flush := func() {
		cur.body = strings.TrimSpace(strings.Join(bodyLines, "\n"))
		if cur.title != "" || cur.body != "" {
			sections = append(sections, cur)
		}
	}

	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		level := 0
		for level < len(trimmed) && level < 6 && trimmed[level] == '#' {
			level++
		}
		if level > 0 && level < len(trimmed) && (trimmed[level] == ' ' || trimmed[level] == '\t') {
			flush()
			cur = markdownSection{title: strings.TrimSpace(trimmed[level:])}
			bodyLines = nil
			continue
		}
		bodyLines = append(bodyLines, line)
	}
	flush()
	return sections
}

// SearchText walks the entire home directory tree and returns nodes whose
// title or body text contains all of the space-separated terms in query
// (case-insensitive). Quoted phrases are matched as a unit.
// Delegates to SearchTextWorkspace with the default (homeDir-only) workspace.
func (s *Store) SearchText(query string) ([]TextSearchResult, error) {
	return s.SearchTextWorkspace(query, DefaultWorkspace(s.Dir()))
}

// searchTerm represents one parsed token from a search query.
type searchTerm struct {
	text     string
	include  bool // false = NOT/exclusion term (prefixed with -)
	isTag    bool // true = tag: prefix
	isStatus bool // true = status: prefix
}

// parseTerms splits a query into structured terms, honouring:
//   - "quoted phrases"  → matched as a single unit
//   - -word             → exclusion (NOT)
//   - tag:name          → tag filter
//   - status:keyword    → status filter
func parseTerms(query string) []searchTerm {
	var terms []searchTerm
	query = strings.TrimSpace(query)
	i := 0
	for i < len(query) {
		for i < len(query) && unicode.IsSpace(rune(query[i])) {
			i++
		}
		if i >= len(query) {
			break
		}
		var word string
		if query[i] == '"' {
			i++
			start := i
			for i < len(query) && query[i] != '"' {
				i++
			}
			word = strings.TrimSpace(query[start:i])
			if i < len(query) {
				i++
			}
		} else {
			start := i
			for i < len(query) && !unicode.IsSpace(rune(query[i])) {
				i++
			}
			word = query[start:i]
		}
		if word == "" {
			continue
		}
		switch {
		case strings.HasPrefix(word, "tag:") && len(word) > 4:
			terms = append(terms, searchTerm{text: strings.ToLower(word[4:]), include: true, isTag: true})
		case strings.HasPrefix(word, "status:") && len(word) > 7:
			terms = append(terms, searchTerm{text: strings.ToLower(word[7:]), include: true, isStatus: true})
		case strings.HasPrefix(word, "-") && len(word) > 1:
			terms = append(terms, searchTerm{text: word[1:], include: false})
		default:
			terms = append(terms, searchTerm{text: word, include: true})
		}
	}
	return terms
}

func allTermsMatch(terms []searchTerm, title, body string, tags []string, status string) bool {
	combined := strings.ToLower(title + "\n" + body)
	tagSet := make([]string, len(tags))
	for i, t := range tags {
		tagSet[i] = strings.ToLower(t)
	}
	statusLower := strings.ToLower(status)

	for _, t := range terms {
		switch {
		case t.isTag:
			found := false
			for _, tg := range tagSet {
				if tg == t.text {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		case t.isStatus:
			if statusLower != t.text {
				return false
			}
		case t.include:
			if !strings.Contains(combined, strings.ToLower(t.text)) {
				return false
			}
		default: // exclusion
			if strings.Contains(combined, strings.ToLower(t.text)) {
				return false
			}
		}
	}
	return true
}

// buildContext finds the first plain-text term occurrence and returns a ±60-char snippet.
func buildContext(terms []searchTerm, title, body string) string {
	for _, src := range []string{body, title} {
		if src == "" {
			continue
		}
		lower := strings.ToLower(src)
		for _, t := range terms {
			if t.isTag || t.isStatus || !t.include {
				continue // only use plain text terms for snippet positioning
			}
			idx := strings.Index(lower, strings.ToLower(t.text))
			if idx < 0 {
				continue
			}
			start := idx - 60
			if start < 0 {
				start = 0
			}
			end := idx + len(t.text) + 60
			if end > len(src) {
				end = len(src)
			}
			snippet := strings.TrimSpace(src[start:end])
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
