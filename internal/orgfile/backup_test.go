package orgfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsBackupFile(t *testing.T) {
	cases := map[string]bool{
		"Welcome.org.~1~":  true,
		"Welcome.org.~42~": true,
		"Welcome.org":      false,
		"Welcome.org~":     false, // Emacs single-backup style, not our numbered style
		"Welcome.org.bak":  false,
	}
	for name, want := range cases {
		if got := IsBackupFile(name); got != want {
			t.Errorf("IsBackupFile(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestNewStoreDefaultsBackupMaxVersions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // isolate from any real ~/.config/epicorg
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if got := store.GetBackupMaxVersions(); got != defaultBackupMaxVersions {
		t.Fatalf("GetBackupMaxVersions() = %d, want default %d", got, defaultBackupMaxVersions)
	}
}

func TestSetBackupMaxVersionsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.SetBackupMaxVersions(10); err != nil {
		t.Fatalf("SetBackupMaxVersions: %v", err)
	}
	if got := store.GetBackupMaxVersions(); got != 10 {
		t.Fatalf("GetBackupMaxVersions() after set = %d, want 10", got)
	}
	// Negative values clamp to 0 (disabled), not stored as negative.
	if err := store.SetBackupMaxVersions(-3); err != nil {
		t.Fatalf("SetBackupMaxVersions(-3): %v", err)
	}
	if got := store.GetBackupMaxVersions(); got != 0 {
		t.Fatalf("GetBackupMaxVersions() after negative set = %d, want 0", got)
	}
}

func TestBackupFileCreatesNumberedCopiesAndPrunes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.org")

	store := &Store{dir: dir}

	write := func(content string) {
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	write("version 1")
	store.backupFile("a.org", 2)
	write("version 2")
	store.backupFile("a.org", 2)
	write("version 3")
	store.backupFile("a.org", 2)

	versions := existingBackupVersions(path)
	if len(versions) != 2 {
		t.Fatalf("expected 2 backups retained (max=2), got %v", versions)
	}
	// Each backupFile call snapshots whatever's on disk *at that moment*
	// (i.e. right after the preceding write). Oldest (.~1~, "version 1")
	// gets pruned once a third backup pushes the count past max=2.
	if _, err := os.Stat(backupPath(path, 1)); !os.IsNotExist(err) {
		t.Fatalf("expected .~1~ to be pruned, stat err = %v", err)
	}
	b2, err := os.ReadFile(backupPath(path, 2))
	if err != nil || string(b2) != "version 2" {
		t.Fatalf("backupPath(path,2) = %q, err %v; want %q", b2, err, "version 2")
	}
	b3, err := os.ReadFile(backupPath(path, 3))
	if err != nil || string(b3) != "version 3" {
		t.Fatalf("backupPath(path,3) = %q, err %v; want %q", b3, err, "version 3")
	}
}

func TestBackupFileDisabledIsNoop(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.org")
	if err := os.WriteFile(path, []byte("content"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	store := &Store{dir: dir}
	store.backupFile("a.org", 0)
	if versions := existingBackupVersions(path); len(versions) != 0 {
		t.Fatalf("expected no backups when max=0, got %v", versions)
	}
}

func TestBackupFileSkipsIfUnchangedSinceLastBackup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.org")
	if err := os.WriteFile(path, []byte("same content"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	store := &Store{dir: dir}
	store.backupFile("a.org", 5)
	store.backupFile("a.org", 5) // content on disk hasn't changed
	store.backupFile("a.org", 5)

	versions := existingBackupVersions(path)
	if len(versions) != 1 {
		t.Fatalf("expected exactly 1 backup for repeated unchanged content, got %v", versions)
	}
}

func TestBackupFileMissingSourceIsNoop(t *testing.T) {
	dir := t.TempDir()
	store := &Store{dir: dir}
	store.backupFile("does-not-exist.org", 5) // must not panic or create anything
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty dir, got %v", entries)
	}
}

func TestListFilesExcludesBackups(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.CreateFile("a.org", "hello"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	// Simulate what backupFile produces, directly — confirms ListFiles
	// (which walks by ".org" extension) never surfaces it, with no special
	// filtering logic of its own required.
	if err := os.WriteFile(filepath.Join(dir, "a.org.~1~"), []byte("hello"), 0644); err != nil {
		t.Fatalf("WriteFile backup: %v", err)
	}

	files, err := store.ListFiles()
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	for _, f := range files {
		if IsBackupFile(f.Name) {
			t.Fatalf("ListFiles returned a backup file: %v", f)
		}
	}
	if len(files) != 1 || files[0].Name != "a.org" {
		t.Fatalf("expected exactly [a.org], got %v", files)
	}
}
