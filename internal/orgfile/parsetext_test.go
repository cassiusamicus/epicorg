package orgfile

import (
	"testing"

	"epicorg/internal/model"
)

func TestParseTextSplitsPreambleFromHeadings(t *testing.T) {
	content := "#+TITLE: My File\n#+OPTIONS: toc:4\n* TODO First item\nSome body text.\n* Second item :work:urgent:\n"
	doc, preamble := ParseText(content)

	wantPreamble := "#+TITLE: My File\n#+OPTIONS: toc:4"
	if preamble != wantPreamble {
		t.Fatalf("preamble = %q, want %q", preamble, wantPreamble)
	}

	items := model.FromDocument(doc)
	if len(items) != 3 { // First item, its body, Second item
		t.Fatalf("expected 3 items, got %d: %+v", len(items), items)
	}
	if items[0].Title != "First item" || items[0].Status != "TODO" {
		t.Fatalf("item 0 = %+v", items[0])
	}
	if items[1].Title != "Some body text." || !items[1].IsBody {
		t.Fatalf("item 1 = %+v", items[1])
	}
	if items[2].Title != "Second item" || len(items[2].Tags) != 2 || items[2].Tags[0] != "work" || items[2].Tags[1] != "urgent" {
		t.Fatalf("item 2 = %+v", items[2])
	}
}

func TestParseTextNoPreamble(t *testing.T) {
	doc, preamble := ParseText("* Just a heading\n")
	if preamble != "" {
		t.Fatalf("preamble = %q, want empty", preamble)
	}
	items := model.FromDocument(doc)
	if len(items) != 1 || items[0].Title != "Just a heading" {
		t.Fatalf("items = %+v", items)
	}
}

// The round trip this feature actually depends on: text -> nodes -> text
// should be stable, since exiting text mode reparses whatever the user
// typed and the result is what gets saved.
func TestParseTextRoundTripsThroughNodes(t *testing.T) {
	content := "* TODO Buy milk :errand:\nA note about milk.\n* Second heading\n** Nested child\n"
	doc, preamble := ParseText(content)
	items := model.FromDocument(doc)
	nodes := items.ToTree(map[string]bool{})

	roundTripped := preamble + model.ItemsFromTree(nodes, 1).ToOrg()

	doc2, preamble2 := ParseText(roundTripped)
	items2 := model.FromDocument(doc2)
	nodes2 := items2.ToTree(map[string]bool{})

	if preamble != preamble2 {
		t.Fatalf("preamble changed across round trip: %q vs %q", preamble, preamble2)
	}
	if len(nodes2) != len(nodes) {
		t.Fatalf("node count changed across round trip: %d vs %d", len(nodes), len(nodes2))
	}
	if nodes2[0].Title != "Buy milk" || len(nodes2[0].Tags) != 1 || nodes2[0].Tags[0] != "errand" {
		t.Fatalf("nodes2[0] = %+v", nodes2[0])
	}
	if nodes2[0].Body != "A note about milk." {
		t.Fatalf("nodes2[0].Body = %q", nodes2[0].Body)
	}
	if len(nodes2[1].Children) != 1 || nodes2[1].Children[0].Title != "Nested child" {
		t.Fatalf("nodes2[1] = %+v", nodes2[1])
	}
}
