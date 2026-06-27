package model

import (
	"fmt"
	"sort"
	"strings"
)

// ToOrg serializes the flat item list to org-mode format.
func (items Items) ToOrg() string {
	var b strings.Builder
	prevLevel := 0
	prevIsBody := false
	for _, item := range items {
		if item.IsBody {
			for _, line := range strings.Split(item.Title, "\n") {
				b.WriteString(line)
				b.WriteString("\n")
			}
			prevIsBody = true
			continue
		}

		// Blank line before top-level headings (except the first)
		if !prevIsBody && item.Level <= prevLevel && item.Level == 1 && b.Len() > 0 {
			b.WriteString("\n")
		}

		stars := strings.Repeat("*", item.Level)
		switch {
		case item.Status != "" && item.Priority != "":
			fmt.Fprintf(&b, "%s %s [#%s] %s", stars, item.Status, item.Priority, item.Title)
		case item.Status != "":
			fmt.Fprintf(&b, "%s %s %s", stars, item.Status, item.Title)
		case item.Priority != "":
			fmt.Fprintf(&b, "%s [#%s] %s", stars, item.Priority, item.Title)
		default:
			fmt.Fprintf(&b, "%s %s", stars, item.Title)
		}
		if len(item.Tags) > 0 {
			fmt.Fprintf(&b, " :%s:", strings.Join(item.Tags, ":"))
		}
		b.WriteString("\n")

		if len(item.Properties) > 0 {
			b.WriteString(":PROPERTIES:\n")
			// Sort keys for stable output
			keys := make([]string, 0, len(item.Properties))
			for k := range item.Properties {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				fmt.Fprintf(&b, ":%s: %s\n", k, item.Properties[k])
			}
			b.WriteString(":END:\n")
		}

		prevLevel = item.Level
		prevIsBody = false
	}
	return b.String()
}

