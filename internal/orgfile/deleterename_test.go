package orgfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteFileRemovesFileSidecarAndFavorite(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	if err := store.CreateFile("a.org", ""); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	store.SaveMeta("a.org", map[string]bool{"0": true})
	if _, err := store.SetFavorite("a.org", true); err != nil {
		t.Fatalf("SetFavorite: %v", err)
	}

	if err := store.DeleteFile("a.org"); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "a.org")); !os.IsNotExist(err) {
		t.Fatalf("expected a.org to be removed, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.org.meta.json")); !os.IsNotExist(err) {
		t.Fatalf("expected a.org.meta.json to be removed, stat err = %v", err)
	}
	favs, err := store.GetFavorites()
	if err != nil {
		t.Fatalf("GetFavorites: %v", err)
	}
	if len(favs) != 0 {
		t.Fatalf("expected favorites empty after delete, got %v", favs)
	}
}

func TestDeleteFileNonexistent(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.DeleteFile("missing.org"); err == nil {
		t.Fatal("expected error deleting a nonexistent file, got nil")
	}
}

func TestRenameFileMovesFileSidecarAndFavorite(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	if err := store.CreateFile("a.org", ""); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	store.SaveMeta("a.org", map[string]bool{"0": true})
	if _, err := store.SetFavorite("a.org", true); err != nil {
		t.Fatalf("SetFavorite: %v", err)
	}

	if err := store.RenameFile("a.org", "b.org"); err != nil {
		t.Fatalf("RenameFile: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "a.org")); !os.IsNotExist(err) {
		t.Fatalf("expected a.org to be gone, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "b.org")); err != nil {
		t.Fatalf("expected b.org to exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "b.org.meta.json")); err != nil {
		t.Fatalf("expected b.org.meta.json to exist: %v", err)
	}
	favs, err := store.GetFavorites()
	if err != nil {
		t.Fatalf("GetFavorites: %v", err)
	}
	if len(favs) != 1 || favs[0] != "b.org" {
		t.Fatalf("expected favorites = [b.org], got %v", favs)
	}
}

func TestRenameFileRefusesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.CreateFile("a.org", ""); err != nil {
		t.Fatalf("CreateFile a: %v", err)
	}
	if err := store.CreateFile("b.org", ""); err != nil {
		t.Fatalf("CreateFile b: %v", err)
	}
	if err := store.RenameFile("a.org", "b.org"); err == nil {
		t.Fatal("expected error renaming onto an existing file, got nil")
	}
	// Both files should still exist untouched.
	if _, err := os.Stat(filepath.Join(dir, "a.org")); err != nil {
		t.Fatalf("expected a.org to still exist: %v", err)
	}
}

func TestRenameFileUpdatesCurrentFileTracking(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.CreateFile("a.org", ""); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if _, err := store.LoadFile("a.org"); err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if err := store.RenameFile("a.org", "b.org"); err != nil {
		t.Fatalf("RenameFile: %v", err)
	}
	// CommitCurrent should now target b.org, the renamed file, without error.
	if err := store.CommitCurrent("test commit after rename"); err != nil {
		t.Fatalf("CommitCurrent after rename: %v", err)
	}
}
