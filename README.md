# Antigravity-GO

Your Antigravity sessions, live on your phone.

Antigravity-GO (AGGO) is a lightweight server that connects to a running Antigravity IDE instance over the Chrome DevTools Protocol and streams the chat interface to any browser on your local network. You can read the conversation, send messages, tap buttons, check your quota, and get push notifications when the AI finishes all without being at your desk.

---

## Setup

```bash
npm install
antigravity . --remote-debugging-port=9000
node server.js
```

Open `http://<your-local-ip>:6969` on your phone. Done.

On Windows you can also just run `run.bat`  it handles dependency installation and config creation automatically.

> Both devices need to be on the same network.

## What It Does

**Live mirror** :  The server captures a snapshot of the Antigravity chat UI every 2 seconds, cleans it up (strips editor overlays, virtualizer spacers, and other IDE artifacts), and pushes it to your phone over WebSocket.

**Send messages** : Type in the mobile input and your message gets injected directly into Antigravity's chat editor via CDP.

**Tap to click** : Interactive elements in the mirrored view are clickable. Taps are relayed back as real click events in Antigravity.

**Quota bar** : A collapsible bar at the top showing your model usage, scraped from the Antigravity UI automatically.

**Push notifications** : AGGO watches for AI completion by tracking content stability across snapshots. When the response is done, you get a push notification. Works with your screen off.

**Password protection** : Optional. Set a password in `config.json` and AGGO gates access with HMAC-SHA256 signed cookies. Leave the password empty and auth is completely bypassed.

**Process control** : Launch or kill Antigravity instances from the settings panel without going back to your computer.

**PWA** : Install it to your home screen for a native app feel.

## Configuration

A `config.json` file is created automatically on first run from `config.example.json`. Here's what you can set:

```jsonc
{
  "port": 6969,                              // Server port
  "password": "",                            // Set to enable auth, leave empty to disable
  "antigravityPath": "",                     // Executable path (for remote launch)
  "cdpPorts": [9000, 9001, 9002, 9003],      // Ports to scan for Antigravity instances
  "snapshotInterval": 2000,                  // How often to capture (ms)
  "vapidPublicKey": "",                      // Auto-generated on first run
  "vapidPrivateKey": "",                     // Auto-generated on first run
  "vapidSubject": ""                         // Auto-set if empty
}
```

## API

If you want to build your own client, AGGO exposes everything over HTTP and WebSocket:

| Endpoint | Method | What it does |
|---|---|---|
| `/snapshot` | GET | Current HTML + CSS snapshot |
| `/send` | POST | Send a message (`{ "message": "..." }`) |
| `/click/:index` | GET | Click an element by its data-index |
| `/new-conversation` | GET | Start a new chat |
| `/api/status` | GET | Connection state + config |
| `/api/auth-status` | GET | Auth state |
| `/api/login` | POST | Authenticate (`{ "password": "..." }`) |
| `/api/push/vapid-key` | GET | VAPID public key for push subscriptions |
| `/api/push/subscribe` | POST | Register a push subscription |
| `/api/push/unsubscribe` | POST | Remove a push subscription |
| `/api/launch` | POST | Start an Antigravity process |
| `/api/kill` | POST | Kill all Antigravity processes |
| `ws://` | WebSocket | Live snapshot stream |

## Project Structure

```
├── server.js            # HTTP + WebSocket server
├── lib/
│   ├── cdp.js           # CDP discovery and connection
│   ├── snapshot.js       # HTML/CSS capture and cleanup
│   ├── auth.js           # Cookie-based auth
│   ├── push.js           # Push notifications
│   └── launcher.js       # Process management
├── public/
│   ├── index.html        # Mobile UI
│   ├── login.html        # Auth page
│   ├── sw.js             # Service worker
│   └── manifest.json     # PWA manifest
├── config.example.json
└── run.bat
```

## Requirements

- Node.js 18+
- Antigravity IDE running with `--remote-debugging-port`

>Inspired by [AG-Chat](https://github.com/gherghett/Antigravity-Shit-Chat) project, rebuilt from scratch with a modular architecture and modern tooling.