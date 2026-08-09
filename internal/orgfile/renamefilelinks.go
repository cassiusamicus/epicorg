package orgfile

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// RenameFileLinks updates all [[file:...oldName...]] org links across every
// .org file in dir, plus journalDir (journal/ files live in their own
// directory — either dir/journal by default, or wherever journalDir points
// when configured — and are never listed by a plain, non-recursive scan of
// dir, so they're scanned separately here rather than skipped). It matches
// oldName as the final path component of the link target — whether the link
// is a bare filename ([[file:oldName]], as inserted by the in-app file
// picker) or a full path ([[file:/abs/dir/oldName]] or [[file:./oldName]],
// as produced by dragging a file in from the OS, pasting an absolute path,
// or the live path-linkify-while-typing feature) — so any leading directory
// prefix is preserved and only the filename itself is swapped in place. Call
// this after the file has already been renamed on disk so the renamed file
// itself is also updated (in case it contains self-links or links to other
// files that were updated).
//
// journalDir may be empty, meaning the default dir/journal.
//
// Returns the number of files changed and total link occurrences replaced.
func RenameFileLinks(dir, journalDir, oldName, newName string) (filesChanged, replacements int, err error) {
	pattern := regexp.MustCompile(`\[\[file:([^\]\n]*/)?` + regexp.QuoteMeta(oldName) + `(\]|::)`)
	replace := func(match string) string {
		loc := pattern.FindStringSubmatch(match)
		return "[[file:" + loc[1] + newName + loc[2]
	}

	scanDir := func(scanDir string) error {
		entries, derr := os.ReadDir(scanDir)
		if os.IsNotExist(derr) {
			return nil
		}
		if derr != nil {
			return derr
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".org") {
				continue
			}
			path := filepath.Join(scanDir, e.Name())
			data, ferr := os.ReadFile(path)
			if ferr != nil {
				continue
			}
			content := string(data)
			matches := pattern.FindAllString(content, -1)
			if len(matches) == 0 {
				continue
			}
			updated := pattern.ReplaceAllStringFunc(content, replace)
			if ferr = os.WriteFile(path, []byte(updated), 0644); ferr != nil {
				return ferr
			}
			filesChanged++
			replacements += len(matches)
		}
		return nil
	}

	if err := scanDir(dir); err != nil {
		return filesChanged, replacements, err
	}
	if journalDir == "" {
		journalDir = filepath.Join(dir, "journal")
	}
	if err := scanDir(journalDir); err != nil {
		return filesChanged, replacements, err
	}
	return filesChanged, replacements, nil
}
