# Hermes Client Bridge

A unified server + Desktop plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent) that lets a remote Hermes server inspect and control the OS, filesystem, clipboard, and local terminals of whichever **Hermes Desktop** client machine you are currently writing from.

When Hermes runs on a remote Linux server or VM while you connect from one or more Windows, macOS, or Linux laptops/workstations via Hermes Desktop, built-in server tools (`terminal`, `read_file`, `write_file`) act on the **server**. `client-bridge` gives the agent 5 orthogonal client-side primitives that execute directly on **your local Desktop machine** — with deterministic multi-machine session routing, a warm persistent shell pool, background PTY management, a 4-mode permission gate (`FULL` / `ASK` / `READ` / `OFF`), and automatic Desktop plugin self-updates.

---

## Key Features

- **Deterministic Multi-Machine Routing** — Tracks `host.state.focusedSessionId` and `activeSessionId` per Desktop window so commands automatically route to the exact laptop/PC where the active chat is open, while still allowing cross-machine targeting via `target_client`.
- **Zero-Latency Push + Adaptive Long-Polling** — Pushes requests over the live Desktop event stream (`broadcast_plugin_event`, `<5 ms`) backed by a 20s async HTTP long-poll (`GET /poll?wait=20`) for subprocess/gateway calls, with `flock`-locked state and throttled disk writes (`25s` interval).
- **Warm Persistent Shell & Background PTYs** — Reuses an idle-TTL (`5 min`) local PowerShell / POSIX PTY with marker handshakes and suppressed shell history, falling back to one-off PTYs when busy, plus full lifecycle control (`start`, `list`, `read`, `write`, `kill`) for background dev servers and watchers.
- **Status Bar Control Panel & `ASK` Approval Gate** — Click the status bar chip (`🖥️ Bridge: FULL`) to switch between **FULL**, **ASK** (interactive toast + popover approval before any write or command), **READ** (read-only), and **OFF**, inspect the last 12 operations with timings, or stop active background PTYs.
- **Zero-Touch Desktop Self-Update** — Once installed on a Desktop client, `plugin.js` checks the server's `desktop/plugin.js` SHA-256 on sync and hot-reloads updates automatically via `reconcileDesktopPlugins()`.
- **Clean Scope** — Deliberately avoids duplicating capabilities Hermes Desktop core already provides natively (`read_window_below`, `desktop_preview`, chat file attachments, `MEDIA:` file delivery).

---

## Tools Provided

| Tool | Description | Key Parameters |
|---|---|---|
| `client_list_machines` | List registered Desktop clients with OS, IP, bridge mode, battery state, active background PTYs, and plugin sync status. | `include_offline` *(bool)* |
| `client_exec` | Execute commands in the client's warm local shell (PowerShell on Windows, bash/zsh on macOS/Linux) or manage background PTYs. | `command`, `cwd`, `timeout` *(30s)*, `background` *(bool)*, `action` *(`run` \| `list` \| `read` \| `write` \| `kill` \| `reset_shell`)*, `pty_id`, `fresh_shell`, `target_client` |
| `client_list_dir` | List directory contents on the client machine via native Electron IPC. | `path` *(defaults to client home)*, `target_client` |
| `client_read_file` | Read a UTF-8 text file or the system text clipboard (`clipboard=true`) from the client machine. | `path`, `clipboard` *(bool)*, `target_client` |
| `client_write_file` | Write a UTF-8 text file onto the client machine (auto-reconciling `desktop-plugins` on write) or copy text to the client clipboard (`clipboard=true`). | `content`, `path`, `clipboard` *(bool)*, `target_client` |

Also registers a `pre_llm_call` hook (on `platform == "desktop"`) that injects compact context about the active client machine and any other online Desktop clients.

---

## Installation

### 1. Install on the Hermes Server

```bash
hermes plugins install https://github.com/MrSakal/hermes-client-bridge
hermes plugins enable client-bridge
```

*(If `hermes-dashboard` is running as a background service, restart it once so `/api/plugins/client-bridge/*` mounts with long-polling enabled.)*

### 2. Install the Desktop Half on Remote Client Machines

If Hermes Desktop runs on the **same** machine as the server, `hermes plugins install` places the desktop half automatically.

If Hermes Desktop connects **remotely** (e.g. Windows/macOS client → Linux server), copy `desktop/plugin.js` once into your client machine's `desktop-plugins/client-bridge/` folder (all future updates self-sync automatically):

**Windows (PowerShell):**
```powershell
$dir = "$env:LOCALAPPDATA\hermes\desktop-plugins\client-bridge"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Copy desktop/plugin.js from this repository into "$dir\plugin.js"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/MrSakal/hermes-client-bridge/main/desktop/plugin.js" -OutFile "$dir\plugin.js"
```

**macOS / Linux:**
```bash
mkdir -p ~/.hermes/desktop-plugins/client-bridge
curl -fsSL https://raw.githubusercontent.com/MrSakal/hermes-client-bridge/main/desktop/plugin.js \
  -o ~/.hermes/desktop-plugins/client-bridge/plugin.js
```

Hermes Desktop detects the file within a few seconds (or press `Ctrl/⌘+K` → **Reload desktop plugins**). Look for `🖥️ Bridge: FULL` in the bottom-right status bar.

---

## Repository Layout

```text
client-bridge/
├── plugin.yaml              # Hermes unified plugin manifest (id: client-bridge)
├── __init__.py              # Agent tools (5 primitives) + pre_llm_call hook
├── store.py                 # Locked client registry, session router & RPC queue
├── dashboard/
│   ├── manifest.json        # Dashboard API mount manifest
│   └── plugin_api.py        # FastAPI routes (/register, /poll, /respond, /desktop-plugin-bundle)
└── desktop/
    └── plugin.js            # Hermes Desktop ESM plugin (warm shell, PTYs, Popover UI, EN/HU i18n)
```

---

## Security & Modes

Click the status bar indicator on any connected Desktop client to control access locally at any time (stored per machine in `localStorage` and enforced **both** client-side and server-side):

- **`FULL`** — Reads, file writes, clipboard, and shell commands execute automatically.
- **`ASK`** — Directory/file/clipboard reads run automatically; every `write_file`, `exec`, or background PTY mutation pauses and pops an interactive **Approve / Deny** prompt on your Desktop.
- **`READ`** — Only `client_list_dir` and `client_read_file` are permitted; writes and shell execution are rejected.
- **`OFF`** — All remote bridge requests to that Desktop machine are rejected.

---

## License

MIT © [MrSakal](https://github.com/MrSakal)
