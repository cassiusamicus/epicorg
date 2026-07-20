package orgfile

import (
	"path/filepath"
	"testing"
)

// IsPathAllowed guards the transclusion endpoint against a hand-edited
// :TRANSCLUDE: property pointing outside the configured workspace.
func TestIsPathAllowed(t *testing.T) {
	dir := t.TempDir()
	cfg := excludingWorkspace(dir, "excluded")

	cases := []struct {
		name string
		path string
		want bool
	}{
		{"inside included root", filepath.Join(dir, "Notes.org"), true},
		{"inside included root, nested", filepath.Join(dir, "sub", "Notes.org"), true},
		{"inside excluded subtree", filepath.Join(dir, "excluded", "Stray.org"), false},
		{"outside any root", filepath.Join(t.TempDir(), "Elsewhere.org"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := IsPathAllowed(cfg, c.path)
			if got != c.want {
				t.Fatalf("IsPathAllowed(%q) = %v, want %v", c.path, got, c.want)
			}
		})
	}
}
