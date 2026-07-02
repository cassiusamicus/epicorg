package orgfile

import (
	"os"
	"path/filepath"
	"strings"
)

// RenameTagInDir renames a tag across all .org files in dir.
// Returns the number of files changed and total line replacements.
func RenameTagInDir(dir, oldName, newName string) (filesChanged, replacements int, err error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".org") {
			continue
		}
		n, ferr := RenameTagInFile(filepath.Join(dir, e.Name()), oldName, newName)
		if ferr != nil {
			return filesChanged, replacements, ferr
		}
		if n > 0 {
			filesChanged++
			replacements += n
		}
	}
	return filesChanged, replacements, nil
}

// RenameTagInFile renames a tag in a single .org file.
// It handles two cases on headline lines:
//   - headline text is exactly oldName (tag list entries like "* foo")
//   - headline contains :oldName: annotations (content files like "* Title :foo:bar:")
//
// Returns the number of lines changed.
func RenameTagInFile(path, oldName, newName string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	lines := strings.Split(string(data), "\n")
	count := 0
	for i, line := range lines {
		updated := renameTagInLine(line, oldName, newName)
		if updated != line {
			lines[i] = updated
			count++
		}
	}
	if count == 0 {
		return 0, nil
	}
	return count, os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

// renameTagInLine rewrites a single org headline line with the renamed tag.
// Non-headline lines are returned unchanged.
func renameTagInLine(line, oldName, newName string) string {
	stars := 0
	for stars < len(line) && line[stars] == '*' {
		stars++
	}
	if stars == 0 || stars >= len(line) || line[stars] != ' ' {
		return line // not a headline
	}
	headlineText := strings.TrimSpace(line[stars+1:])
	// Tag list format: the headline text IS the tag name (e.g. "* foo")
	if headlineText == oldName {
		return line[:stars+1] + " " + newName
	}
	// Content file format: replace :oldName: tag annotations in the headline
	return strings.ReplaceAll(line, ":"+oldName+":", ":"+newName+":")
}
