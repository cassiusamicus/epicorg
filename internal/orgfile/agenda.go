package orgfile

import (
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"epicorg/internal/model"
)

// AgendaItem represents a node with a SCHEDULED or DEADLINE date found anywhere in the workspace.
type AgendaItem struct {
	File         string   `json:"file"`
	NodeTitle    string   `json:"nodeTitle"`
	Date         string   `json:"date"`
	Time         string   `json:"time,omitempty"`
	Kind         string   `json:"kind"` // "scheduled" or "deadline"
	Status       string   `json:"status,omitempty"`
	Tags         []string `json:"tags,omitempty"`
	Ancestors    []string `json:"ancestors,omitempty"`
	ScheduledRaw string   `json:"scheduledRaw,omitempty"`
	DeadlineRaw  string   `json:"deadlineRaw,omitempty"`
}

var agendaDateRe = regexp.MustCompile(`<(\d{4}-\d{2}-\d{2})`)
var agendaTimeRe = regexp.MustCompile(`<\d{4}-\d{2}-\d{2}[^>]*\b(\d{2}:\d{2})\b`)

func parseAgendaDate(val string) string {
	m := agendaDateRe.FindStringSubmatch(val)
	if m == nil {
		return ""
	}
	return m[1]
}

func parseAgendaTime(val string) string {
	m := agendaTimeRe.FindStringSubmatch(val)
	if m == nil {
		return ""
	}
	return m[1]
}

// ScanAgenda walks all .org files in the workspace and (if configured separately)
// the external journal directory, returning nodes with SCHEDULED or DEADLINE properties.
// When a node has both on the same date, only the SCHEDULED entry is returned.
func (s *Store) ScanAgenda() ([]AgendaItem, error) {
	s.mu.RLock()
	dir := s.dir
	jDir := s.journalDir
	s.mu.RUnlock()

	var items []AgendaItem

	// Walk workspace dir (includes journal/ subdir when it's inside the workspace).
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() != "." && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".org") {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		data, err := readFileSafe(path)
		if err != nil {
			return nil
		}
		doc := parseOrg(string(data), d.Name())
		scanItemsForDates(model.FromDocument(doc), rel, &items)
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Only scan jDir separately when it is outside the workspace; if it lives
	// inside dir the workspace walk above already covered it.
	jDirIsExternal := false
	if jDir != "" {
		if rel, relErr := filepath.Rel(dir, jDir); relErr != nil || strings.HasPrefix(rel, "..") {
			jDirIsExternal = true
		}
	}
	if jDirIsExternal {
		walkErr := filepath.WalkDir(jDir, func(path string, d fs.DirEntry, werr error) error {
			if werr != nil {
				return nil
			}
			if d.IsDir() {
				if d.Name() != "." && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(d.Name(), ".org") {
				return nil
			}
			rel, err := filepath.Rel(jDir, path)
			if err != nil {
				return nil
			}
			rel = filepath.ToSlash(rel)
			data, err := readFileSafe(path)
			if err != nil {
				return nil
			}
			doc := parseOrg(string(data), d.Name())
			scanItemsForDates(model.FromDocument(doc), "journal/"+rel, &items)
			return nil
		})
		if walkErr != nil && !isNotExistErr(walkErr) {
			return nil, walkErr
		}
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Date != items[j].Date {
			return items[i].Date < items[j].Date
		}
		return items[i].Time < items[j].Time
	})

	return items, nil
}

func scanItemsForDates(items model.Items, file string, out *[]AgendaItem) {
	type frame struct {
		level int
		title string
	}
	var stack []frame

	for _, item := range items {
		if item.IsBody {
			continue
		}
		for len(stack) > 0 && stack[len(stack)-1].level >= item.Level {
			stack = stack[:len(stack)-1]
		}
		ancestors := make([]string, len(stack))
		for i, f := range stack {
			ancestors[i] = f.title
		}
		stack = append(stack, frame{item.Level, item.Title})

		schedRaw := item.Properties["SCHEDULED"]
		dlRaw := item.Properties["DEADLINE"]
		schedDate := parseAgendaDate(schedRaw)
		dlDate := parseAgendaDate(dlRaw)

		if schedDate != "" {
			*out = append(*out, AgendaItem{
				File:         file,
				NodeTitle:    item.Title,
				Date:         schedDate,
				Time:         parseAgendaTime(schedRaw),
				Kind:         "scheduled",
				Status:       item.Status,
				Tags:         item.Tags,
				Ancestors:    ancestors,
				ScheduledRaw: schedRaw,
				DeadlineRaw:  dlRaw,
			})
		}
		// Only add a separate deadline entry when it falls on a different date.
		if dlDate != "" && dlDate != schedDate {
			*out = append(*out, AgendaItem{
				File:         file,
				NodeTitle:    item.Title,
				Date:         dlDate,
				Kind:         "deadline",
				Status:       item.Status,
				Tags:         item.Tags,
				Ancestors:    ancestors,
				ScheduledRaw: schedRaw,
				DeadlineRaw:  dlRaw,
			})
		}
	}
}

func isNotExistErr(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "no such file or directory")
}

// TodoItem represents a node with a non-empty TODO keyword found anywhere in the workspace.
type TodoItem struct {
	File      string   `json:"file"`
	NodeTitle string   `json:"nodeTitle"`
	Status    string   `json:"status"`
	Priority  string   `json:"priority,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	Ancestors []string `json:"ancestors,omitempty"`
	Scheduled string   `json:"scheduled,omitempty"`
	Deadline  string   `json:"deadline,omitempty"`
}

// ScanTodos walks all .org files in the workspace, returning nodes with a non-empty
// TODO keyword. Returns all statuses (including DONE/CANCELLED) so the frontend can filter.
func (s *Store) ScanTodos() ([]TodoItem, error) {
	s.mu.RLock()
	dir := s.dir
	jDir := s.journalDir
	s.mu.RUnlock()

	var items []TodoItem

	walkDir := func(root, prefix string) {
		filepath.WalkDir(root, func(path string, d fs.DirEntry, werr error) error {
			if werr != nil {
				return nil
			}
			if d.IsDir() {
				if d.Name() != "." && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(d.Name(), ".org") {
				return nil
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return nil
			}
			rel = prefix + filepath.ToSlash(rel)
			data, err := readFileSafe(path)
			if err != nil {
				return nil
			}
			doc := parseOrg(string(data), d.Name())
			scanItemsForTodos(model.FromDocument(doc), rel, &items)
			return nil
		})
	}

	walkDir(dir, "")

	jDirIsExternal := false
	if jDir != "" {
		if rel, relErr := filepath.Rel(dir, jDir); relErr != nil || strings.HasPrefix(rel, "..") {
			jDirIsExternal = true
		}
	}
	if jDirIsExternal {
		walkDir(jDir, "journal/")
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].File != items[j].File {
			return items[i].File < items[j].File
		}
		if items[i].Status != items[j].Status {
			return items[i].Status < items[j].Status
		}
		return items[i].NodeTitle < items[j].NodeTitle
	})

	return items, nil
}

func scanItemsForTodos(modelItems model.Items, file string, out *[]TodoItem) {
	type frame struct {
		level int
		title string
	}
	var stack []frame
	for _, item := range modelItems {
		if item.IsBody {
			continue
		}
		for len(stack) > 0 && stack[len(stack)-1].level >= item.Level {
			stack = stack[:len(stack)-1]
		}
		ancestors := make([]string, len(stack))
		for i, f := range stack {
			ancestors[i] = f.title
		}
		stack = append(stack, frame{item.Level, item.Title})
		if item.Status == "" {
			continue
		}
		*out = append(*out, TodoItem{
			File:      file,
			NodeTitle: item.Title,
			Status:    item.Status,
			Priority:  item.Priority,
			Tags:      item.Tags,
			Ancestors: ancestors,
			Scheduled: item.Properties["SCHEDULED"],
			Deadline:  item.Properties["DEADLINE"],
		})
	}
}
