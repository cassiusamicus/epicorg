package orgfile

import (
	"fmt"
	"os"
	"path/filepath"

	"epicorg/internal/model"
)

// FindTranscludeSource reads and parses the org file at absPath and returns
// the subtree of the node whose :TRANSCLUDE_ID: property matches id. It is
// read-only: unlike LoadFile, it does not update any per-file merge-base
// state and is not marked as the active file (same no-side-effects contract
// as ReadRawFile).
func FindTranscludeSource(absPath, id string) (*model.Node, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	doc := parseOrg(string(data), filepath.Base(absPath))
	items := model.FromDocument(doc)
	nodes := items.ToTree(nil)
	found := findByTranscludeID(nodes, id)
	if found == nil {
		return nil, fmt.Errorf("no node with TRANSCLUDE_ID %q in %s", id, absPath)
	}
	return found, nil
}

func findByTranscludeID(nodes []*model.Node, id string) *model.Node {
	for _, n := range nodes {
		if n.Properties != nil && n.Properties["TRANSCLUDE_ID"] == id {
			return n
		}
		if found := findByTranscludeID(n.Children, id); found != nil {
			return found
		}
	}
	return nil
}
