package model

import (
	"fmt"
	"strings"
)

// Item is a single outline entry in a flat ordered list.
type Item struct {
	Level      int               `json:"-"`
	IsBody     bool              `json:"-"`
	Title      string            `json:"title"`
	Status     string            `json:"status,omitempty"`
	Priority   string            `json:"priority,omitempty"` // "A", "B", "C", or ""
	Tags       []string          `json:"tags,omitempty"`
	Properties map[string]string `json:"properties,omitempty"`
}

// Items is the flat ordered list — the source of truth.
type Items []Item

// Node is a tree node exchanged with the frontend.
type Node struct {
	ID         string            `json:"id"`
	Title      string            `json:"title"`
	Body       string            `json:"body,omitempty"`
	Status     string            `json:"status,omitempty"`
	Priority   string            `json:"priority,omitempty"` // "A", "B", "C", or ""
	Tags       []string          `json:"tags,omitempty"`
	Properties map[string]string `json:"properties,omitempty"`
	Children   []*Node           `json:"children"`
	Collapsed  bool              `json:"collapsed"`
}

// Document is the full document exchanged via GET/PUT /api/doc/:filename.
type Document struct {
	Filename string  `json:"filename"`
	Preamble string  `json:"preamble"`
	Hash     string  `json:"hash"`
	Nodes    []*Node `json:"nodes"`
}

// ToTree converts the flat item list into a nested tree for display.
// collapsed is keyed by heading index (as string).
func (items Items) ToTree(collapsed map[string]bool) []*Node {
	if len(items) == 0 {
		return []*Node{}
	}

	type indexedNode struct {
		node  *Node
		level int
	}

	nodes := make([]indexedNode, len(items))
	headingIdx := 0
	for i, item := range items {
		n := &Node{
			Title:      item.Title,
			Status:     item.Status,
			Priority:   item.Priority,
			Tags:       item.Tags,
			Properties: item.Properties,
			Children:   []*Node{},
		}
		if item.IsBody {
			n.ID = "body"
		} else {
			id := fmt.Sprintf("%d", headingIdx)
			n.ID = id
			n.Collapsed = collapsed[id]
			headingIdx++
		}
		nodes[i] = indexedNode{node: n, level: item.Level}
	}

	var roots []*Node
	type stackEntry struct {
		node  *Node
		level int
	}
	var stack []stackEntry

	for _, n := range nodes {
		for len(stack) > 0 && stack[len(stack)-1].level >= n.level {
			stack = stack[:len(stack)-1]
		}
		if len(stack) == 0 {
			roots = append(roots, n.node)
		} else {
			parent := stack[len(stack)-1].node
			parent.Children = append(parent.Children, n.node)
		}
		stack = append(stack, stackEntry{n.node, n.level})
	}

	mergeBodyChildren(roots)
	return roots
}

// mergeBodyChildren collects body child nodes into the parent's Body field
// and removes them from Children.
func mergeBodyChildren(nodes []*Node) {
	for _, n := range nodes {
		var bodyLines []string
		var headingChildren []*Node
		for _, c := range n.Children {
			if c.ID == "body" {
				bodyLines = append(bodyLines, c.Title)
			} else {
				headingChildren = append(headingChildren, c)
			}
		}
		if len(bodyLines) > 0 {
			n.Body = strings.Join(bodyLines, "\n")
		}
		if headingChildren == nil {
			headingChildren = []*Node{}
		}
		n.Children = headingChildren
		mergeBodyChildren(n.Children)
	}
}

// ItemsFromTree converts a tree of Nodes back into a flat Items list
// for serialization to org format.
func ItemsFromTree(nodes []*Node, level int) Items {
	var items Items
	for _, n := range nodes {
		items = append(items, Item{
			Level:      level,
			Title:      n.Title,
			Status:     n.Status,
			Priority:   n.Priority,
			Tags:       n.Tags,
			Properties: n.Properties,
		})
		if n.Body != "" {
			items = append(items, Item{
				Level:  level + 1,
				IsBody: true,
				Title:  n.Body,
			})
		}
		items = append(items, ItemsFromTree(n.Children, level+1)...)
	}
	return items
}

// CollapsedFromTree extracts collapsed state from a node tree.
func CollapsedFromTree(nodes []*Node) map[string]bool {
	m := make(map[string]bool)
	var walk func([]*Node)
	walk = func(nodes []*Node) {
		for _, n := range nodes {
			if n.Collapsed {
				m[n.ID] = true
			}
			walk(n.Children)
		}
	}
	walk(nodes)
	return m
}
