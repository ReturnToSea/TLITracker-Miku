# TLI Tracker

A real-time farming tracker for **Torchlight: Infinite** that reads the game's local log file to track map runs, item pickups, inventory value, market activity, and session history.

## Features

### Session Tracking
- **Map tracking** — detects map entries and exits, shows a list of all maps run this session with time spent per map
- **Loot per map** — tracks items picked up during each map run and their FE value
- **Map cost tracking** — detects items consumed when opening a map (beacons, compasses) and subtracts them from profit
- **Net profit per map** — gross loot minus map cost, shown per map and for the full session
- **FE/hr and FE/min** — based on time spent in maps only (excludes town time), with real-time rate shown as secondary
- **Session stats** — maps run, average profit per map, and best map of the session highlighted
- **Session reset** — save the current session to history and start fresh without losing your inventory snapshot

### Inventory & Market
- **Inventory networth** — live value of everything in your bag, sorted by value; filter by item category
- **Instant market updates** — inventory updates immediately when you list, buy, or claim items on the exchange
- **Market log** — dedicated tab showing all your recent listed, claimed, and bought market events

### Prices
- **Live market prices** — fetches price data from titrack.ninja on startup and on demand
- **In-game price capture** — also updates prices when you search the in-game exchange

### Session History
- **Saved sessions** — sessions are automatically saved to disk when you reset or close the app
- **Per-session stats** — view profit, FE/hr, maps run, and best map for any past session
- **Per-map breakdown** — click any saved session to drill into individual map loot and costs
- **Export to Discord** — copy a formatted session summary (stats + top drops) to your clipboard with one click

### Interface
- **Compact overlay mode** — shrinks to a small always-on-top window showing profit, FE/hr, map time, and real time while you play
- **Theme options** — Midnight (dark default), Light, Miku (image background), and Custom (your own background image)
- **Auto-updater** — notifies you when a new version is available and downloads it in the background

## How it works

Torchlight: Infinite writes game events to a local log file when logging is enabled in settings. This tracker watches that file in real time and parses:

- `SwitchBattleAreaUtil:_JoinFightSuccess()` — map entry with area ID, map ID, and type
- `ItemChange@ ProtoName=PickItems` — item pickups (delta from previous slot count)
- `ItemChange@ ProtoName=Spv3Open` — items consumed opening a map (beacon/compass cost)
- `ItemChange@ ProtoName=XchgForSale` — item listed on market (removed from inventory)
- `ItemChange@ ProtoName=XchgReceive` — FE claimed from a sale (added to inventory)
- `ItemChange@ ProtoName=XchgBuy` — FE spent buying from market (deducted from inventory)
- `ItemChange@ ProtoName=ResetItemsLayout` — full inventory snapshot (on sort or relog)
- `BagMgr@:InitBagData` — inventory snapshot on login
- `XchgSearchPrice` socket messages — price data captured from in-game exchange searches

No data is sent anywhere. Everything runs locally.

## Setup

### Requirements

- Windows 10 or 11
- Torchlight Infinite installed and logging enabled

### In-game setup

1. Open TLI settings and enable **Logging**
2. When you first start the tracker, **sort your inventory** or **relog** — this forces the game to write your current inventory state so the tracker can pick it up

### Running the tracker

1. Download the latest installer (`TLI-Tracker-Setup-x.x.x.exe`) from the [Releases](../../releases) page
2. Run the installer and choose your install location
3. Launch **TLI Tracker**
4. Go to **Settings** and click **Select Log File**, then navigate to your `UE_game.log`:
   ```
   C:\Users\<you>\AppData\Local\[TLI folder]\TorchLight\Saved\Logs\UE_game.log
   ```
   *(The exact path varies by install — search for `UE_game.log` if unsure)*

   Alternatively, click **Select Game Directory** and point it to your TLI install folder — the tracker will find the log automatically.
5. Start playing — the tracker updates in real time

### Windows SmartScreen warning

Because the app is unsigned, Windows may show a "Windows protected your PC" warning on first run. Click **More info → Run anyway** to proceed. The app is open source and you can inspect the full source code in this repo.

## Development

```bash
# Install dependencies
npm install
npm install --prefix frontend

# Run in dev mode (hot reload)
npm run dev

# Build Windows installer
npm run build:win

# Run log parser tests
node test/log-parser-test.js
```

## Credit

The log file watcher (`src/tor/main.js`) is based on the original [YiHuo ETor (易火-ETor)](https://etor-beta.710421059.xyz/) by the Chinese TLI developer community, English translation by GIBOo_. The rest of this project (frontend, Electron main process, log parsing logic) was built separately.
