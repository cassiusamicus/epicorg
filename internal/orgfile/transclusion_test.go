package orgfile

import (
	"path/filepath"
	"testing"
)

func TestFindTranscludeSourceTopLevel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Notes.org")
	writeTestFile(t, path, "* Quote\n:PROPERTIES:\n:TRANSCLUDE_ID: tc-1\n:END:\nThe quoted text.\n")

	node, err := FindTranscludeSource(path, "tc-1")
	if err != nil {
		t.Fatalf("FindTranscludeSource: %v", err)
	}
	if node.Title != "Quote" {
		t.Fatalf("expected title %q, got %q", "Quote", node.Title)
	}
	if node.Body != "The quoted text." {
		t.Fatalf("expected body %q, got %q", "The quoted text.", node.Body)
	}
}

func TestFindTranscludeSourceNested(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Notes.org")
	writeTestFile(t, path, "* Parent\n** Child\n:PROPERTIES:\n:TRANSCLUDE_ID: tc-2\n:END:\nNested quote.\n")

	node, err := FindTranscludeSource(path, "tc-2")
	if err != nil {
		t.Fatalf("FindTranscludeSource: %v", err)
	}
	if node.Title != "Child" {
		t.Fatalf("expected title %q, got %q", "Child", node.Title)
	}
}

func TestFindTranscludeSourceNotFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Notes.org")
	writeTestFile(t, path, "* Quote\nSome text.\n")

	if _, err := FindTranscludeSource(path, "tc-missing"); err == nil {
		t.Fatalf("expected an error for a missing TRANSCLUDE_ID, got nil")
	}
}
