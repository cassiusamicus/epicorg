package orgfile

import (
	"os"
	"path/filepath"
	"strings"
)

// RenameFileLinks updates all [[file:oldName...]] org links across every .org
// file in dir. The token "[[file:oldName" is specific enough to only match
// inside org link syntax — it cannot appear as ordinary prose. Call this after
// the file has already been renamed on disk so the renamed file itself is
// also updated (in case it contains self-links or links to other files that
// were updated).
//
// Returns the number of files changed and total link occurrences replaced.
func RenameFileLinks(dir, oldName, newName string) (filesChanged, replacements int, err error) {
	oldToken := "[[file:" + oldName
	newToken := "[[file:" + newName

	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".org") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, ferr := os.ReadFile(path)
		if ferr != nil {
			continue
		}
		content := string(data)
		count := strings.Count(content, oldToken)
		if count == 0 {
			continue
		}
		updated := strings.ReplaceAll(content, oldToken, newToken)
		if ferr = os.WriteFile(path, []byte(updated), 0644); ferr != nil {
			return filesChanged, replacements, ferr
		}
		filesChanged++
		replacements += count
	}
	return filesChanged, replacements, nil
}
