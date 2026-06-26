package orgfile

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type GlobalBookmark struct {
	Name string `json:"name"`
	File string `json:"file"`
}

func epicorgConfigDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "epicorg"), nil
}

func LoadGlobalBookmarks() ([]GlobalBookmark, error) {
	dir, err := epicorgConfigDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "bookmarks.json"))
	if os.IsNotExist(err) {
		return []GlobalBookmark{}, nil
	}
	if err != nil {
		return nil, err
	}
	var bms []GlobalBookmark
	if err := json.Unmarshal(data, &bms); err != nil {
		return []GlobalBookmark{}, nil
	}
	return bms, nil
}

func SaveGlobalBookmarks(bms []GlobalBookmark) error {
	dir, err := epicorgConfigDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(bms, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "bookmarks.json"), data, 0644)
}
