package orgfile

import (
	"os"
	"path/filepath"
	"testing"
)

// Regression coverage for a real bug: WikiLinkEntries/BacklinkSearch/
// UnlinkedMentions used to walk the directory tree themselves instead of
// going through WalkWorkspace, so they ignored the workspace's configured
// exclusions entirely. A malformed file sitting in an excluded folder (e.g.
// another app's own backup directory synced into the same tree) would still
// get opened and parsed, logging a warning on every note load.

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func excludingWorkspace(dir, excludedSubdir string) *WorkspaceConfig {
	return &WorkspaceConfig{
		Paths: []WorkspacePath{
			{Path: dir, Included: true},
			{Path: filepath.Join(dir, excludedSubdir), Included: false},
		},
	}
}

func TestWikiLinkEntriesRespectsExclusions(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "Kept.org"), "#+TITLE: Kept\n* Heading\n")
	writeTestFile(t, filepath.Join(dir, "excluded", "Stray.org"), "#+TITLE: Stray\n* Heading\n")
	store := &Store{dir: dir}

	entries, err := store.WikiLinkEntries(excludingWorkspace(dir, "excluded"))
	if err != nil {
		t.Fatalf("WikiLinkEntries: %v", err)
	}
	for _, e := range entries {
		if e.Title == "Stray" {
			t.Fatalf("excluded file leaked into WikiLinkEntries: %+v", entries)
		}
	}
	found := false
	for _, e := range entries {
		if e.Title == "Kept" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected Kept.org to be included, got %+v", entries)
	}
}

func TestBacklinkSearchRespectsExclusions(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "Kept.org"), "* Refers [[Target]] here\n")
	writeTestFile(t, filepath.Join(dir, "excluded", "Stray.org"), "* Also refers [[Target]] here\n")
	store := &Store{dir: dir}

	results, err := store.BacklinkSearch("Target", "", excludingWorkspace(dir, "excluded"))
	if err != nil {
		t.Fatalf("BacklinkSearch: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 backlink (from Kept.org only), got %d: %+v", len(results), results)
	}
	if results[0].File != "Kept.org" {
		t.Fatalf("expected backlink from Kept.org, got %q", results[0].File)
	}
}

func TestUnlinkedMentionsRespectsExclusions(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "Kept.org"), "* Mentions Target in passing\n")
	writeTestFile(t, filepath.Join(dir, "excluded", "Stray.org"), "* Also mentions Target in passing\n")
	store := &Store{dir: dir}

	results, err := store.UnlinkedMentions("Target", "", excludingWorkspace(dir, "excluded"))
	if err != nil {
		t.Fatalf("UnlinkedMentions: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 unlinked mention (from Kept.org only), got %d: %+v", len(results), results)
	}
	if results[0].File != "Kept.org" {
		t.Fatalf("expected mention from Kept.org, got %q", results[0].File)
	}
}

// A malformed SETUPFILE (or any other content go-org can't fully resolve)
// sitting in an excluded folder must never be opened/parsed at all — not
// just excluded from the results.
func TestExcludedMalformedFileNeverParsed(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "Kept.org"), "* Mentions Target here\n")
	writeTestFile(t, filepath.Join(dir, "excluded", "Bad.org"),
		"#+SETUPFILE: https://example.invalid/does-not-exist.setup\n* Also mentions Target here\n")
	store := &Store{dir: dir}
	cfg := excludingWorkspace(dir, "excluded")

	if _, err := store.BacklinkSearch("Target", "", cfg); err != nil {
		t.Fatalf("BacklinkSearch: %v", err)
	}
	if _, err := store.UnlinkedMentions("Target", "", cfg); err != nil {
		t.Fatalf("UnlinkedMentions: %v", err)
	}
	if _, err := store.WikiLinkEntries(cfg); err != nil {
		t.Fatalf("WikiLinkEntries: %v", err)
	}
}
