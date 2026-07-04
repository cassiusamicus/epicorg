package orgfile

import (
	"os"
	"path/filepath"
	"strings"
)

type OrgBookmark struct {
	Name      string        `json:"name"`
	Children  []OrgBookmark `json:"children,omitempty"`
	Collapsed bool          `json:"collapsed,omitempty"`
}

const BookmarksFilename = "Bookmarks.org"

func LoadOrgBookmarks(dir string) ([]OrgBookmark, error) {
	return LoadOrgBookmarksFromFile(filepath.Join(dir, BookmarksFilename))
}

func LoadOrgBookmarksFromFile(path string) ([]OrgBookmark, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return []OrgBookmark{}, nil
	}
	if err != nil {
		return nil, err
	}
	return parseOrgBookmarksOrg(string(data)), nil
}

func SaveOrgBookmarks(dir string, bms []OrgBookmark) error {
	return SaveOrgBookmarksToFile(filepath.Join(dir, BookmarksFilename), bms)
}

func SaveOrgBookmarksToFile(path string, bms []OrgBookmark) error {
	var buf strings.Builder
	writeOrgBookmarksOrg(&buf, bms, 1)
	return os.WriteFile(path, []byte(buf.String()), 0644)
}

func writeOrgBookmarksOrg(buf *strings.Builder, bms []OrgBookmark, level int) {
	prefix := strings.Repeat("*", level) + " "
	for _, bm := range bms {
		buf.WriteString(prefix + bm.Name + "\n")
		if len(bm.Children) > 0 {
			writeOrgBookmarksOrg(buf, bm.Children, level+1)
		}
	}
}

type flatBMEntry struct {
	level int
	name  string
}

func parseOrgBookmarksOrg(content string) []OrgBookmark {
	var entries []flatBMEntry
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimRight(line, "\r")
		lvl := 0
		for lvl < len(line) && line[lvl] == '*' {
			lvl++
		}
		if lvl == 0 || lvl >= len(line) || line[lvl] != ' ' {
			continue
		}
		name := strings.TrimSpace(line[lvl+1:])
		if name != "" {
			entries = append(entries, flatBMEntry{lvl, name})
		}
	}
	bms, _ := buildBMTree(entries, 0, 1)
	return bms
}

func buildBMTree(entries []flatBMEntry, start, level int) ([]OrgBookmark, int) {
	var result []OrgBookmark
	i := start
	for i < len(entries) {
		e := entries[i]
		if e.level < level {
			break
		}
		bm := OrgBookmark{Name: e.name}
		i++
		bm.Children, i = buildBMTree(entries, i, e.level+1)
		result = append(result, bm)
	}
	return result, i
}
