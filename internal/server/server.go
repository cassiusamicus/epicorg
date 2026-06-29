package server

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed web
var webFS embed.FS

// RegisterStatic sets up static file serving for the SPA.
func RegisterStatic(mux *http.ServeMux) {
	sub, _ := fs.Sub(webFS, "web")
	fileServer := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Serve static files if they exist, otherwise serve index.html (SPA fallback)
		if r.URL.Path != "/" && !strings.HasPrefix(r.URL.Path, "/api/") {
			// Try to open the file
			f, err := sub.Open(strings.TrimPrefix(r.URL.Path, "/"))
			if err == nil {
				f.Close()
				// Prevent stale JS/CSS after a binary rebuild.
				ext := r.URL.Path[strings.LastIndex(r.URL.Path, ".")+1:]
				if ext == "js" || ext == "css" {
					w.Header().Set("Cache-Control", "no-store")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// SPA fallback: serve index.html
		if r.URL.Path == "/" || !strings.HasPrefix(r.URL.Path, "/api/") {
			data, err := fs.ReadFile(sub, "index.html")
			if err != nil {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(data)
			return
		}

		http.NotFound(w, r)
	})
}
