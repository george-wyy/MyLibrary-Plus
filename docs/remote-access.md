# Reading your library from other devices

MyLibrary has **no authentication** and binds to `127.0.0.1` by default. That is the
right default: the library is a personal reading surface, not a service. This page
covers how to reach it from a phone or tablet *without* putting it on the public
internet.

Rule of thumb: never expose the app directly. Either keep it inside a private
network overlay, or put an authenticating proxy in front of it.

## Option A — Tailscale Serve (recommended)

The app keeps listening on `127.0.0.1`; Tailscale terminates HTTPS inside your
tailnet and reverse-proxies to it. Only your own devices can reach it.

```bash
tailscale serve --bg 8765     # start
tailscale serve status        # inspect
tailscale serve reset         # stop
```

Then open `https://<machine>.<tailnet>.ts.net/` from any device signed into the
same tailnet.

One-time prerequisite: enable HTTPS certificates in the Tailscale admin console
(**DNS → HTTPS Certificates → Enable HTTPS**). Note that enabling it publishes the
machine's tailnet DNS *name* to public certificate-transparency logs — the name
becomes discoverable, but the service and its contents stay private to the tailnet.

Why HTTPS rather than plain HTTP: the annotation panel's "copy for AI" action uses
`navigator.clipboard`, which browsers only expose in a secure context (HTTPS or
`localhost`).

## Option B — bind to the overlay address

Skips the admin console, gives you plain HTTP:

```bash
mylibrary run --host 100.x.y.z      # your tailnet/VPN address
```

Two caveats: the bind fails if the overlay network is not up yet at boot, and the
clipboard action stays unavailable over plain HTTP.

## Option C — authenticated tunnel

To share with someone outside your own devices, use a tunnel with an identity layer
in front (for example Cloudflare Tunnel + Access). Do **not** use a bare public
tunnel such as `tailscale funnel` — that is the internet, and the app has no login.

## What not to do

- `--host 0.0.0.0` on an untrusted network. Anyone on the same café Wi-Fi gets your
  whole library, including annotations.
- Syncing the live `data/` directory through iCloud/Dropbox while the app is
  running. Cloud sync corrupts SQLite databases that are being written to. Sync a
  snapshot instead, or back up with `sqlite3 library.sqlite3 ".backup out.sqlite3"`.

## Autostart

- **macOS**: copy `com.mylibrary.local.plist.example` to
  `com.mylibrary.local.plist`, replace the placeholder paths with your checkout
  path, then:

  ```bash
  cp com.mylibrary.local.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mylibrary.local.plist
  launchctl list | grep mylibrary                              # verify
  launchctl bootout gui/$(id -u)/com.mylibrary.local           # remove
  ```

  `KeepAlive` is on, so the process comes back within seconds if it dies. Logs land
  in `data/logs/launchd.{out,err}.log`. After editing the plist you must `bootout`
  then `bootstrap` again for changes to take effect.

- **Linux (systemd)**: use the built-in generator, which writes a unit for the
  current checkout path:

  ```bash
  ./mylibrary service print --user "$USER"
  sudo ./mylibrary service install --user "$USER"
  ./mylibrary service status
  ```

- **Laptops sleep.** A sleeping machine means an unreachable library. Keep it on
  power and disable sleep-on-display-off, or run `caffeinate -s` while you need it.
