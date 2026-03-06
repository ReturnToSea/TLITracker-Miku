# TLI Tracker

A real-time farming tracker for **Torchlight: Infinite** that reads the game's local log file to track map runs, item pickups, inventory value, and market activity.

## Features

- **Map tracking** — detects map entries and exits, shows a list of all maps run this session with time spent per map
- **Loot per map** — tracks items picked up during each map run and their FE value
- **Map cost tracking** — detects items consumed when opening a map (beacons, compasses) and subtracts them from profit
- **Net profit per map** — gross loot minus map cost, shown per map and for the full session
- **FE/hr and FE/min** — based on time spent in maps only (excludes town time), with real-time rate shown as secondary
- **Inventory networth** — live value of everything in your bag, sorted by value in the Loot tab
- **Instant market updates** — inventory updates immediately when you list an item for sale or claim FE from a sale
- **Market prices** — fetches live price data from titrack.ninja; also captures prices when you search the in-game exchange
- **Session reset** — wipe the current session's map history without losing your inventory snapshot

## How it works

Torchlight: Infinite (Unreal Engine) writes game events to a local log file when logging is enabled in settings. This tracker watches that file in real time and parses:

- `SwitchBattleAreaUtil:_JoinFightSuccess()` — map entry with area ID, map ID, and type
- `ItemChange@ ProtoName=PickItems` — item pickups (delta from previous slot count)
- `ItemChange@ ProtoName=Spv3Open` — items consumed opening a map (beacon/compass cost)
- `ItemChange@ ProtoName=XchgForSale` — item listed on market (removed from inventory)
- `ItemChange@ ProtoName=XchgReceive` — FE claimed from a sale (added to inventory)
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

1. Download the latest zip from the [Releases](../../releases) page
2. Extract it anywhere
3. Run `TLI Tracker.exe`
4. Click **Select Log File** and navigate to your `UE_game.log`:
   ```
   C:\Users\<you>\AppData\Local\[TLI folder]\TorchLight\Saved\Logs\UE_game.log
   ```
   *(The exact path varies by install — search for `UE_game.log` if unsure)*
5. Start playing — the tracker updates in real time

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
node test/log-parser-test.js
```

## Credit

The log file watcher (`src/tor/main.js`) is based on the original [YiHuo ETor (易火-ETor)](https://etor-beta.710421059.xyz/) by the Chinese TLI developer community, English translation by GIBOo_. The rest of this project (frontend, Electron main process, log parsing logic) was built separately.
