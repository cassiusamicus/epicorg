package model

import (
	"strings"
	"testing"

	"github.com/niklasfasching/go-org/org"
)

func parseTitle(t *testing.T, headline string) string {
	t.Helper()
	doc := org.New().Parse(strings.NewReader(headline+"\n"), "")
	items := FromDocument(doc)
	if len(items) == 0 {
		t.Fatalf("no items parsed from %q", headline)
	}
	return items[0].Title
}

func TestFromDocumentPreservesEmphasisMarkers(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"bold", "* see *important* thing", "see *important* thing"},
		{"italic", "* see /important/ thing", "see /important/ thing"},
		{"underline", "* see _important_ thing", "see _important_ thing"},
		{"strikethrough", "* see +important+ thing", "see +important+ thing"},
		{"code", "* see =important= thing", "see =important= thing"},
		{"verbatim", "* see ~important~ thing", "see ~important~ thing"},
		{"multiple markers in one title", "* /one/ and *two*", "/one/ and *two*"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseTitle(t, c.in)
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}
