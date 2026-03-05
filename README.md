# TLI Tracker

A farming tracker for **Torchlight: Infinite** that tracks item pickups, map runs, and in-game prices by reading the game's local log file.

## Why does this exist?

The original tracker — [YiHuo ETor (易火-ETor)](https://etor-beta.710421059.xyz/), translated to English by GIBOo_ — was getting a blank window. The reason is that the original app is just an Electron shell that loads its UI from an external website at startup. If that site is unreachable, slow, or blocked on your machine, you get a transparent blank window with nothing to interact with.

This project fixes that by keeping all the same log-reading logic but replacing the external URL with a locally bundled UI, so it works offline and doesn't depend on any third-party server being up.

## Credit

The vast majority of the meaningful code in this project is **not mine**. Specifically:

- **`src/tor/main.js`** — the log file watcher and parser — is taken directly from the original YiHuo ETor application. This is the core of how the tracker works: it watches the game's `UE_game.log` file in real time and parses game events out of it.
- The **Electron IPC and WebSocket architecture** in `electron/main.js` is also based closely on the original app's main process code.
- The original YiHuo ETor was built by the Chinese developer community. The English translation was done by **GIBOo_**.

I built the replacement frontend UI (`frontend/`) and wired it together so it loads locally instead of from the web.

## How it works

Torchlight: Infinite (Unreal Engine) can write game events to a local log file when logging is enabled in settings. This tracker watches that file for changes and parses events like:

- **Item pickups** (`PickItem`, `PickItems`)
- **Map entry** (`EnterArea`)
- **Inventory snapshots** (`ResetItemsLayout` — triggered by sorting your bag or relogging)
- **Price data** (`XchgSearchPrice` — captured when you search prices in the in-game exchange)

No data is sent anywhere. Everything is local.

## Setup

### Requirements

- Windows 10 or 11 (with WebView2 — included by default on Win 11, auto-installed on Win 10 via Windows Update)
- Torchlight Infinite installed

### In-game setup

1. Open TLI settings and enable **Logging**
2. When you first start the tracker, either **sort your inventory** or **log out and back in** — this forces the game to write your current inventory state to the log so the tracker can pick it up

### Running the tracker

1. Download the latest zip from the [Releases](../../releases) page
2. Extract it anywhere
3. Run `TLI Tracker.exe`
4. Click **Select Log File** and navigate to your `UE_game.log`:
   ```
   C:\Users\<you>\AppData\Local\[TLI folder]\TorchLight\Saved\Logs\UE_game.log
   ```
   *(The exact path varies by install location — search for `UE_game.log` if unsure)*
5. Start playing — the tracker will update in real time

## Development

```bash
# Install dependencies
npm install
npm install --prefix frontend

# Run in dev mode (hot reload)
npm run dev

# Build Windows zip
npm run build:win

# Run log parser tests
npm test
```

## License

The original log parsing code (`src/tor/main.js`) belongs to the YiHuo ETor project and its developers. Everything else in this repo is provided as-is with no warranty.
