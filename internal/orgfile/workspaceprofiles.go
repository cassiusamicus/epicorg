package orgfile

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// WorkspaceProfile is a named, saved combination of workspace settings — home
// directory, tag list, bookmark list, journal folder, and home file — so a
// user can switch between entirely separate working contexts (e.g. a public
// examples folder vs. a personal notes vault) without reconfiguring each
// setting by hand every time.
type WorkspaceProfile struct {
	Name             string `json:"name"`
	HomeDir          string `json:"homeDir"`
	TagListFile      string `json:"tagListFile,omitempty"`
	BookmarkListFile string `json:"bookmarkListFile,omitempty"`
	JournalDir       string `json:"journalDir,omitempty"`
	HomeFile         string `json:"homeFile,omitempty"`
}

func workspaceProfilesPath() (string, error) {
	dir, err := epicorgConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "saved-workspaces.json"), nil
}

// LoadWorkspaceProfiles reads the saved workspace-profile list.
// A missing file returns an empty list, not an error.
func LoadWorkspaceProfiles() ([]WorkspaceProfile, error) {
	path, err := workspaceProfilesPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return []WorkspaceProfile{}, nil
	}
	if err != nil {
		return nil, err
	}
	var profiles []WorkspaceProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return []WorkspaceProfile{}, nil
	}
	return profiles, nil
}

// SaveWorkspaceProfiles writes the full saved workspace-profile list.
func SaveWorkspaceProfiles(profiles []WorkspaceProfile) error {
	path, err := workspaceProfilesPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
