package orgfile

import (
	"os"
	"path/filepath"
	"testing"
)

func writeOrgFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func readOrgFile(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

func TestRenameFileLinksBareFilename(t *testing.T) {
	dir := t.TempDir()
	writeOrgFile(t, dir, "journal.org", "* Today\nSee [[file:Claude Code Records.org][Claude Code Records]] for notes.\n")

	filesChanged, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if filesChanged != 1 || replacements != 1 {
		t.Fatalf("got filesChanged=%d replacements=%d, want 1, 1", filesChanged, replacements)
	}
	want := "* Today\nSee [[file:Claude.org][Claude Code Records]] for notes.\n"
	if got := readOrgFile(t, dir, "journal.org"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// This is the bug the user hit: a link created by dragging the file in from
// the OS, pasting an absolute path, or the live path-linkify-while-typing
// feature stores the full path, not just the bare filename — RenameFileLinks
// must still find and update it.
func TestRenameFileLinksAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	writeOrgFile(t, dir, "journal.org",
		"* Today\n[[file:/mnt/DriveD/Nextcloud/Org/Claude Code Records.org][Claude Code Records.org]]\n")

	filesChanged, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if filesChanged != 1 || replacements != 1 {
		t.Fatalf("got filesChanged=%d replacements=%d, want 1, 1", filesChanged, replacements)
	}
	want := "* Today\n[[file:/mnt/DriveD/Nextcloud/Org/Claude.org][Claude Code Records.org]]\n"
	if got := readOrgFile(t, dir, "journal.org"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRenameFileLinksRelativeDirPrefix(t *testing.T) {
	dir := t.TempDir()
	writeOrgFile(t, dir, "journal.org", "[[file:./Claude Code Records.org]]\n")

	_, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if replacements != 1 {
		t.Fatalf("got replacements=%d, want 1", replacements)
	}
	want := "[[file:./Claude.org]]\n"
	if got := readOrgFile(t, dir, "journal.org"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRenameFileLinksWithSearchAnchor(t *testing.T) {
	dir := t.TempDir()
	writeOrgFile(t, dir, "journal.org", "[[file:Claude Code Records.org::*Some Heading][Some Heading]]\n")

	_, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if replacements != 1 {
		t.Fatalf("got replacements=%d, want 1", replacements)
	}
	want := "[[file:Claude.org::*Some Heading][Some Heading]]\n"
	if got := readOrgFile(t, dir, "journal.org"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRenameFileLinksDoesNotMatchUnrelatedFile(t *testing.T) {
	dir := t.TempDir()
	writeOrgFile(t, dir, "journal.org",
		"[[file:Other Claude Code Records.org][unrelated]]\nClaude Code Records.org mentioned in prose without a link.\n")

	_, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if replacements != 0 {
		t.Fatalf("got replacements=%d, want 0 (unrelated file/prose should be untouched)", replacements)
	}
}

// This is the actual bug the user hit: a link in today's journal entry
// (journal/2026-08-09.org) wasn't updated by the rename at all. Journal
// files live in dir/journal (or wherever journalDir points), a separate
// directory that a plain scan of dir never visits — dir's own os.ReadDir
// lists "journal" only as a subdirectory entry, which gets skipped.
func TestRenameFileLinksScansDefaultJournalDir(t *testing.T) {
	dir := t.TempDir()
	journalDir := filepath.Join(dir, "journal")
	if err := os.MkdirAll(journalDir, 0755); err != nil {
		t.Fatalf("mkdir journal: %v", err)
	}
	writeOrgFile(t, journalDir, "2026-08-09.org",
		"* Use [[file:Claude Code Records.org][Claude Code Records]] to go through all recent articles.\n")

	filesChanged, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if filesChanged != 1 || replacements != 1 {
		t.Fatalf("got filesChanged=%d replacements=%d, want 1, 1", filesChanged, replacements)
	}
	want := "* Use [[file:Claude.org][Claude Code Records]] to go through all recent articles.\n"
	if got := readOrgFile(t, journalDir, "2026-08-09.org"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// A configured (non-default) journal directory, outside the workspace dir
// entirely, must also be scanned.
func TestRenameFileLinksScansConfiguredJournalDir(t *testing.T) {
	dir := t.TempDir()
	journalDir := t.TempDir()
	writeOrgFile(t, journalDir, "2026-08-09.org", "[[file:Claude Code Records.org]]\n")

	filesChanged, replacements, err := RenameFileLinks(dir, journalDir, "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if filesChanged != 1 || replacements != 1 {
		t.Fatalf("got filesChanged=%d replacements=%d, want 1, 1", filesChanged, replacements)
	}
	want := "[[file:Claude.org]]\n"
	if got := readOrgFile(t, journalDir, "2026-08-09.org"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRenameFileLinksNoOccurrences(t *testing.T) {
	dir := t.TempDir()
	writeOrgFile(t, dir, "journal.org", "* Today\nNothing relevant here.\n")

	filesChanged, replacements, err := RenameFileLinks(dir, "", "Claude Code Records.org", "Claude.org")
	if err != nil {
		t.Fatalf("RenameFileLinks: %v", err)
	}
	if filesChanged != 0 || replacements != 0 {
		t.Fatalf("got filesChanged=%d replacements=%d, want 0, 0", filesChanged, replacements)
	}
}
