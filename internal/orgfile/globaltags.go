package orgfile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type GlobalTag struct {
	Name      string      `json:"name"`
	Children  []GlobalTag `json:"children,omitempty"`
	Collapsed bool        `json:"collapsed,omitempty"`
}

// TagListFilename is the org file stored in the workspace directory.
const TagListFilename = "TagList.org"

// LoadGlobalTags reads TagList.org from the workspace dir.
// Falls back to the legacy ~/.config/epicorg/tags.org (or tags.json) and migrates it.
func LoadGlobalTags(dir string) ([]GlobalTag, error) {
	primary := filepath.Join(dir, TagListFilename)
	data, err := os.ReadFile(primary)
	if err == nil {
		return parseTagsOrg(string(data)), nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}

	// Migrate from legacy config location if present
	if cfgDir, cerr := epicorgConfigDir(); cerr == nil {
		if legacy, lerr := os.ReadFile(filepath.Join(cfgDir, "tags.org")); lerr == nil {
			tags := parseTagsOrg(string(legacy))
			_ = SaveGlobalTags(dir, tags)
			_ = os.Remove(filepath.Join(cfgDir, "tags.org"))
			return tags, nil
		}
		if legacy, lerr := os.ReadFile(filepath.Join(cfgDir, "tags.json")); lerr == nil {
			var tags []GlobalTag
			if json.Unmarshal(legacy, &tags) == nil {
				_ = SaveGlobalTags(dir, tags)
				_ = os.Remove(filepath.Join(cfgDir, "tags.json"))
				return tags, nil
			}
		}
	}

	return []GlobalTag{}, nil
}

// SaveGlobalTags writes TagList.org into the workspace dir.
func SaveGlobalTags(dir string, tags []GlobalTag) error {
	var buf strings.Builder
	writeTagsOrg(&buf, tags, 1)
	return os.WriteFile(filepath.Join(dir, TagListFilename), []byte(buf.String()), 0644)
}

// LoadGlobalTagsFromFile reads global tags from an explicit file path.
// Returns empty list if the file does not exist.
func LoadGlobalTagsFromFile(filePath string) ([]GlobalTag, error) {
	data, err := os.ReadFile(filePath)
	if os.IsNotExist(err) {
		return []GlobalTag{}, nil
	}
	if err != nil {
		return nil, err
	}
	return parseTagsOrg(string(data)), nil
}

// SaveGlobalTagsToFile writes tags to an explicit file path.
func SaveGlobalTagsToFile(filePath string, tags []GlobalTag) error {
	var buf strings.Builder
	writeTagsOrg(&buf, tags, 1)
	return os.WriteFile(filePath, []byte(buf.String()), 0644)
}

func writeTagsOrg(buf *strings.Builder, tags []GlobalTag, level int) {
	prefix := strings.Repeat("*", level) + " "
	for _, tag := range tags {
		buf.WriteString(prefix + tag.Name + "\n")
		if len(tag.Children) > 0 {
			writeTagsOrg(buf, tag.Children, level+1)
		}
	}
}

type flatTagEntry struct {
	level int
	name  string
}

func parseTagsOrg(content string) []GlobalTag {
	var entries []flatTagEntry
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
			entries = append(entries, flatTagEntry{lvl, name})
		}
	}
	tags, _ := buildTagTree(entries, 0, 1)
	return tags
}

func buildTagTree(entries []flatTagEntry, start, level int) ([]GlobalTag, int) {
	var result []GlobalTag
	i := start
	for i < len(entries) {
		e := entries[i]
		if e.level < level {
			break
		}
		tag := GlobalTag{Name: e.name}
		i++
		tag.Children, i = buildTagTree(entries, i, e.level+1)
		result = append(result, tag)
	}
	return result, i
}
