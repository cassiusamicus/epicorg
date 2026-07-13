package orgfile

import "testing"

func TestScanAgendaIncludesReminderOnScheduledItems(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	content := `* TODO Send out Rent Distribution letters
:PROPERTIES:
:SCHEDULED: <2026-07-14 Tue 09:00>
:REMINDER: 30
:END:
* TODO No reminder set
:PROPERTIES:
:SCHEDULED: <2026-07-15 Wed 10:00>
:END:
`
	if err := store.CreateFile("a.org", content); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}

	items, err := store.ScanAgenda()
	if err != nil {
		t.Fatalf("ScanAgenda: %v", err)
	}

	// NewStore also loads a machine-global journalDir override from
	// ~/.config/epicorg/config.json if one is set on this machine, which
	// ScanAgenda walks in addition to dir — so filter to just our file
	// rather than asserting the total item count.
	byTitle := map[string]AgendaItem{}
	for _, it := range items {
		if it.File == "a.org" {
			byTitle[it.NodeTitle] = it
		}
	}
	if len(byTitle) != 2 {
		t.Fatalf("expected 2 agenda items from a.org, got %d: %+v", len(byTitle), byTitle)
	}

	withReminder, ok := byTitle["Send out Rent Distribution letters"]
	if !ok {
		t.Fatalf("missing expected item in %+v", items)
	}
	if withReminder.Reminder != "30" {
		t.Fatalf("expected Reminder=30, got %q", withReminder.Reminder)
	}

	withoutReminder, ok := byTitle["No reminder set"]
	if !ok {
		t.Fatalf("missing expected item in %+v", items)
	}
	if withoutReminder.Reminder != "" {
		t.Fatalf("expected empty Reminder, got %q", withoutReminder.Reminder)
	}
}

func TestScanAgendaDeadlineOnlyItemHasNoReminder(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	content := `* TODO Pay invoice
:PROPERTIES:
:DEADLINE: <2026-07-20 Mon>
:REMINDER: 60
:END:
`
	if err := store.CreateFile("a.org", content); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}

	items, err := store.ScanAgenda()
	if err != nil {
		t.Fatalf("ScanAgenda: %v", err)
	}

	// See the note in TestScanAgendaIncludesReminderOnScheduledItems about
	// why this filters to our file instead of asserting the total count.
	var found *AgendaItem
	for i := range items {
		if items[i].File == "a.org" {
			found = &items[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("expected an item from a.org, got %+v", items)
	}
	if found.Kind != "deadline" {
		t.Fatalf("expected kind=deadline, got %q", found.Kind)
	}
	if found.Reminder != "" {
		t.Fatalf("deadline-only items should not carry a Reminder (feature only applies to SCHEDULED), got %q", found.Reminder)
	}
}
