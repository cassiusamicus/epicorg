package orgfile

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Emacs-style numbered backups: saving Welcome.org keeps prior on-disk
// states alongside it as Welcome.org.~1~, Welcome.org.~2~, etc., pruned to
// the most recent N (configurable in Settings → Versioning/Backups). This
// is deliberately independent of the git snapshot history — a simpler,
// directly-browsable fallback that doesn't require knowing git.
//
// The ".~N~" suffix never ends in ".org" (or any other tracked extension),
// so every existing file listing/search path — all of which filter by
// extension via WalkWorkspace(Exts) — already excludes backups with no
// extra filtering needed. Only the raw directory browser (which can list
// files with no extension filter at all) needs an explicit exclusion; see
// isBackupFile below.

const defaultBackupMaxVersions = 5

var backupVersionRe = regexp.MustCompile(`\.~(\d+)~$`)

// isBackupFile reports whether name looks like a numbered backup
// ("*.~N~"), for callers that list files without an extension filter.
func isBackupFile(name string) bool {
	return backupVersionRe.MatchString(name)
}

// IsBackupFile is the exported form of isBackupFile, for use outside the package.
func IsBackupFile(name string) bool {
	return isBackupFile(name)
}

func backupPath(path string, n int) string {
	return path + ".~" + strconv.Itoa(n) + "~"
}

// existingBackupVersions returns path's existing backup version numbers, ascending.
func existingBackupVersions(path string) []int {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	prefix := base + ".~"
	var versions []int
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, "~") {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, prefix), "~")); err == nil {
			versions = append(versions, n)
		}
	}
	sort.Ints(versions)
	return versions
}

// backupFile snapshots name's *current* on-disk content as a new numbered
// backup, then prunes to the configured retention count. Best-effort: a
// failure here never blocks the caller's actual save/commit. No-ops if
// max <= 0 (backups disabled), the file doesn't exist yet, or its content
// matches the most recent existing backup (nothing changed since the last
// checkpoint, so a new copy would be redundant).
//
// Takes max as a parameter rather than calling GetBackupMaxVersions itself
// because callers invoke this from both inside and outside s.mu — resolving
// it internally would either deadlock (LoadFile already holds the write
// lock) or race (reading the field with no lock at all).
//
// Called at the same three points git already snapshots (file load,
// 20-minute idle, shutdown) rather than on every autosave — at a few-second
// autosave cadence, "5-10 recent versions" would otherwise cover less than
// a minute of editing and be useless as a recovery point.
func (s *Store) backupFile(name string, max int) {
	if max <= 0 {
		return
	}
	path := s.resolveFilePath(name)
	content, err := os.ReadFile(path)
	if err != nil {
		return
	}
	versions := existingBackupVersions(path)
	if len(versions) > 0 {
		last := versions[len(versions)-1]
		if prev, err := os.ReadFile(backupPath(path, last)); err == nil && string(prev) == string(content) {
			return
		}
	}
	next := 1
	if len(versions) > 0 {
		next = versions[len(versions)-1] + 1
	}
	if err := os.WriteFile(backupPath(path, next), content, 0644); err != nil {
		return
	}
	versions = append(versions, next)
	for len(versions) > max {
		os.Remove(backupPath(path, versions[0])) //nolint:errcheck — best-effort prune
		versions = versions[1:]
	}
}
