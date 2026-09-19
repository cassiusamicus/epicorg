# Running epicorg as a standalone app window (Linux)

epicorg is a local web server (see [README](README.md)) — normally you just open it in a
regular browser tab. If you'd rather have it behave like a native app — its own window,
its own icon, its own entry in your taskbar/dock/panel, no address bar or tabs — you can
wrap it in a minimal WebKitGTK-based browser and give it its own desktop launcher. This is
entirely optional desktop integration; it requires no changes to epicorg itself.

Panel/dock applets (e.g. dockbarx, and most taskbar implementations) group and control
windows by their X11 `WM_CLASS`. A PWA installed through a full browser (Chrome, Vivaldi,
etc.) often doesn't get a clean, distinct `WM_CLASS` — the window can still look like it
belongs to the browser. A dedicated site-specific browser instance sidesteps that
entirely: you assign the window its own class explicitly, so your panel treats it as a
fully separate app (start, stop, minimize, taskbar icon — all work correctly).

## 1. Install a minimal GTK+WebKitGTK browser

[luakit](https://github.com/luakit/luakit) works well for this — small, GTK3 +
WebKitGTK, packaged on most mainstream distros at the same version.

```bash
# Arch / Manjaro
sudo pacman -S luakit

# Debian / Ubuntu / Mint
sudo apt install luakit
```

Any other GTK3-based browser works the same way, since the trick below (`--class` /
`--name`) comes from GTK itself, not from luakit specifically — e.g.
[surf](https://surf.suckless.org/) (AUR on Arch, not in Debian's repos) is an even more
minimal alternative if you want less browser chrome.

## 2. Install the icon

```bash
mkdir -p ~/.local/share/icons/hicolor/scalable/apps
cp /path/to/epicorg/internal/server/web/favicon.svg ~/.local/share/icons/hicolor/scalable/apps/epicorg.svg
```

Installing it under the standard `hicolor` icon theme path means the `.desktop` file
below can just reference `epicorg` by name — no hardcoded path, so the same file works on
any machine regardless of where the epicorg repo/binary happens to live there.

## 3. Create the desktop launcher

Save as `~/Desktop/Epicorg.desktop` (and optionally also copy it to
`~/.local/share/applications/Epicorg.desktop` so it shows up in your application menu,
not just as a desktop icon). Adjust the port in the URL to match how you run epicorg
(`-addr`, default `:8080` unless overridden).

```ini
[Desktop Entry]
Version=1.0
Type=Application
Name=Epicorg
Comment=Open the LMH Org outliner as a standalone app window
Exec=luakit --class=Epicorg --name=epicorg -U -u http://localhost:58217/
Icon=epicorg
StartupWMClass=Epicorg
Terminal=false
StartupNotify=true
Categories=Utility;
```

Then mark it executable:

```bash
chmod 755 ~/Desktop/Epicorg.desktop
```

(Some desktop environments additionally require right-clicking the icon once and choosing
"Allow Launching" / "Trust this executable" before it'll run from the file manager.)

The `--class=Epicorg` / `--name=epicorg` flags are what give the window a distinct,
predictable `WM_CLASS` (`StartupWMClass` in the `.desktop` file must match the class
value) — that's the piece your panel/dock needs to manage the window as its own app.
`-U` (`--nounique`) makes each launch open a fresh window with that class, rather than
possibly merging into an unrelated already-running instance of the same browser.

This launcher assumes epicorg's server is already running (`./epicorg` / whatever your
usual start command is) — it only opens a window pointed at it, it doesn't start the
server itself.
