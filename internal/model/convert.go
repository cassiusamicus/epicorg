package model

import (
	"strings"

	"github.com/niklasfasching/go-org/org"
)

// FromDocument converts a go-org Document into a flat item list.
func FromDocument(doc *org.Document) Items {
	var items Items
	walkSections(doc.Outline.Children, &items)
	return items
}

func walkSections(sections []*org.Section, items *Items) {
	for _, sec := range sections {
		if sec.Headline == nil {
			continue
		}
		h := sec.Headline
		item := Item{
			Level:  h.Lvl,
			Title:  inlineNodesToText(h.Title),
			Status: h.Status,
			Tags:   h.Tags,
		}
		if h.Properties != nil && len(h.Properties.Properties) > 0 {
			item.Properties = make(map[string]string, len(h.Properties.Properties))
			for _, prop := range h.Properties.Properties {
				if len(prop) >= 2 {
					item.Properties[prop[0]] = prop[1]
				}
			}
		}
		*items = append(*items, item)

		// Body text becomes a single item at parent level+1 with IsBody flag
		body := extractBody(h.Children)
		if body != "" {
			*items = append(*items, Item{
				Level:  h.Lvl + 1,
				IsBody: true,
				Title:  body,
			})
		}

		walkSections(sec.Children, items)
	}
}

func inlineNodesToText(nodes []org.Node) string {
	var b strings.Builder
	for _, n := range nodes {
		switch v := n.(type) {
		case org.Text:
			b.WriteString(v.Content)
		case org.Emphasis:
			marker := emphasisMarker(v.Kind)
			b.WriteString(marker)
			b.WriteString(inlineNodesToText(v.Content))
			b.WriteString(marker)
		case org.RegularLink:
			if len(v.Description) > 0 {
				b.WriteString("[[")
				b.WriteString(v.URL)
				b.WriteString("][")
				b.WriteString(inlineNodesToText(v.Description))
				b.WriteString("]]")
			} else {
				b.WriteString("[[")
				b.WriteString(v.URL)
				b.WriteString("]]")
			}
		default:
			b.WriteString(n.String())
		}
	}
	return b.String()
}

// emphasisMarker returns the org delimiter for a parsed emphasis node.
// go-org's Emphasis.Kind is the literal marker character it matched
// (e.g. "*" for bold, "/" for italic), not a descriptive word, so for the
// symmetric single-character markers the marker IS the kind.
func emphasisMarker(kind string) string {
	switch kind {
	case "*", "/", "_", "+", "~", "=":
		return kind
	default:
		return ""
	}
}

func extractBody(children []org.Node) string {
	var parts []string
	for _, child := range children {
		switch child.(type) {
		case org.Headline:
			continue
		case org.PropertyDrawer:
			continue
		default:
			s := strings.TrimSpace(child.String())
			if s != "" {
				parts = append(parts, s)
			}
		}
	}
	return strings.Join(parts, "\n")
}
