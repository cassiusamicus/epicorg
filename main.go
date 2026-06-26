package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"epicorg/internal/api"
	"epicorg/internal/git"
	"epicorg/internal/orgfile"
	"epicorg/internal/server"
)

// reorderArgs moves recognized flags (and their values) ahead of positional
// arguments. The standard flag package stops parsing at the first
// non-flag token, so without this, "epicorg DIR -file x.org" would silently
// ignore -file — flags must normally come before positional args.
func reorderArgs(args []string) (flags, positional []string) {
	takesValue := map[string]bool{"addr": true, "file": true, "no-browser": false}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
			continue
		}
		flags = append(flags, a)
		name := strings.TrimLeft(a, "-")
		if strings.Contains(name, "=") {
			continue // value embedded as -flag=value
		}
		if takesValue[name] && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return flags, positional
}

func main() {
	addr      := flag.String("addr", ":58217", "listen address")
	file      := flag.String("file", "", "default file to open on startup")
	noBrowser := flag.Bool("no-browser", false, "do not open browser on startup")

	flagArgs, positionalArgs := reorderArgs(os.Args[1:])
	flag.CommandLine.Parse(flagArgs)

	dir := "."
	if len(positionalArgs) > 0 {
		dir = positionalArgs[0]
	}

	defaultFile := *file
	if defaultFile != "" && !strings.HasSuffix(defaultFile, ".org") {
		defaultFile += ".org"
	}

	// Ensure directory exists
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("cannot create directory %s: %v", dir, err)
		}
	}

	store, err := orgfile.NewStore(dir)
	if err != nil {
		log.Fatalf("failed to open directory: %v", err)
	}

	// Idle commit timer — fires after 20 minutes of no saves
	idleTimer := time.NewTimer(20 * time.Minute)
	idleTimer.Stop()

	onSave := func() {
		idleTimer.Reset(20 * time.Minute)
	}

	mux := http.NewServeMux()
	api.Register(mux, store, onSave, defaultFile)
	server.RegisterStatic(mux)

	srv := &http.Server{Addr: *addr, Handler: mux}

	// Signal handling for graceful shutdown. SIGHUP is included so closing
	// the terminal (the .desktop launcher runs in one) triggers the same
	// final-commit path as Ctrl+C, instead of an abrupt kill.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()

	// Idle timer goroutine
	go func() {
		for {
			select {
			case <-idleTimer.C:
				if err := store.CommitCurrent(git.AutoSaveMessage()); err != nil {
					log.Printf("idle commit: %v", err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	host := *addr
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	url := "http://" + host

	fmt.Printf("epicorg listening on %s (dir: %s)\n", url, dir)
	if !*noBrowser {
		openBrowser(url)
	}

	go func() {
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	fmt.Println("\nshutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)

	// Final commit on shutdown
	if err := store.CommitCurrent(git.ShutdownMessage()); err != nil {
		log.Printf("shutdown commit: %v", err)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start()
}
