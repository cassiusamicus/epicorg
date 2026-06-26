package orgfile

import "testing"

func TestFavoritesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	if favs, err := store.GetFavorites(); err != nil {
		t.Fatalf("GetFavorites: %v", err)
	} else if len(favs) != 0 {
		t.Fatalf("expected no favorites initially, got %v", favs)
	}

	favs, err := store.SetFavorite("a.org", true)
	if err != nil {
		t.Fatalf("SetFavorite(a.org, true): %v", err)
	}
	if len(favs) != 1 || favs[0] != "a.org" {
		t.Fatalf("expected [a.org], got %v", favs)
	}

	favs, err = store.SetFavorite("b.org", true)
	if err != nil {
		t.Fatalf("SetFavorite(b.org, true): %v", err)
	}
	if len(favs) != 2 {
		t.Fatalf("expected 2 favorites, got %v", favs)
	}

	// Re-favoriting an already-favorited file should be a no-op, not a duplicate.
	favs, err = store.SetFavorite("a.org", true)
	if err != nil {
		t.Fatalf("SetFavorite(a.org, true) again: %v", err)
	}
	if len(favs) != 2 {
		t.Fatalf("expected re-favoriting not to duplicate, got %v", favs)
	}

	favs, err = store.SetFavorite("a.org", false)
	if err != nil {
		t.Fatalf("SetFavorite(a.org, false): %v", err)
	}
	if len(favs) != 1 || favs[0] != "b.org" {
		t.Fatalf("expected [b.org] after removing a.org, got %v", favs)
	}

	// A fresh Store instance reading the same directory should see the
	// persisted favorites (confirms it round-trips through the sidecar file,
	// not just in-memory state).
	store2, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore (second): %v", err)
	}
	favs, err = store2.GetFavorites()
	if err != nil {
		t.Fatalf("GetFavorites (second store): %v", err)
	}
	if len(favs) != 1 || favs[0] != "b.org" {
		t.Fatalf("expected persisted [b.org], got %v", favs)
	}
}
