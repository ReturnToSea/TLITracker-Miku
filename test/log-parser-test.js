/**
 * TLI Log Parser Test
 *
 * Tests the log parsing logic against sample game log data.
 * The game writes these logs when "Enable Logging" is turned on in settings.
 * Log file location (typical):
 *   C:\Users\<user>\AppData\Local\...\TorchLight\Saved\Logs\UE_game.log
 *
 * Run with: node test/log-parser-test.js
 */

// Must be set before requiring tor/main.js so it doesn't suppress console.log
process.env.NODE_ENV = 'development';

const { parseTorchlightData, timeToTimestamp } = require('../src/tor/main');
const fs = require('fs');

// ─── Sample log lines based on the actual game log format ───────────────────
// Format: [YYYY.MM.DD-HH.MM.SS:mmm][frame]GameLog: Display: [Game] ----Socket <Type> STT----<Action>----SynId = <id>
// Followed by indented data lines until an End line appears.

const SAMPLE_LOG = `
[2026.03.06-04.51.18:479][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 101 SlotId = 35 ConfigBaseId = 7101 Num = 1
[2026.03.06-04.51.18:479][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 101 SlotId = 36 ConfigBaseId = 7087 Num = 1
[2026.03.06-04.51.18:479][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 1 ConfigBaseId = 100300 Num = 999
[2026.03.06-04.51.18:479][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 2 ConfigBaseId = 100300 Num = 999
[2026.03.06-04.51.18:479][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 3 ConfigBaseId = 100300 Num = 999
[2026.03.06-04.51.18:479][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 4 ConfigBaseId = 100300 Num = 999
[2026.03.06-04.51.18:480][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 5 ConfigBaseId = 100300 Num = 531
[2026.03.06-04.51.18:480][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 6 ConfigBaseId = 101200 Num = 200
[2026.03.06-04.51.18:480][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 7 ConfigBaseId = 100200 Num = 999
[2026.03.06-04.51.18:480][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 8 ConfigBaseId = 100200 Num = 999
[2026.03.06-04.51.18:480][445]GameLog: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 9 ConfigBaseId = 100200 Num = 999
[2026.03.06-04.51.18:481][445]GameLog: Display: [Game] SomeOtherLog: unrelated line

[2026.03.06-04.58.30:350][541]GameLog: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 301
+filters+1+refer [3004]
[2026.03.06-04.58.30:351][541]GameLog: Display: [Game] ----Socket SendMessage End----XchgSearchPrice----SynId = 301

[2026.03.06-04.58.30:400][542]GameLog: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 301
+prices+1+currency [100300]
|       +unitPrices+1 [0.5]
|       |           +2 [0.5]
|       |           +3 [0.6]
|       |           +4 [0.5]
|       |           +5 [0.7]
+itemGoldId [3004]
[2026.03.06-04.58.30:401][542]GameLog: Display: [Game] ----Socket RecvMessage End----XchgSearchPrice----SynId = 301

[2026.03.06-04.59.00:500][600]GameLog: Display: [Game] ----Socket RecvMessage STT----EnterArea----SynId = 400
+p4version [4222817]
+AreaUniqueId [3314649325744692261]
+areaId [110_df24d82e-ae4f-11f0-b2ba-00000000005c]
+mapId [111000]
+checkType [DungeonMap]
[2026.03.06-04.59.00:501][600]GameLog: Display: [Game] ----Socket RecvMessage End----EnterArea----SynId = 400
`.trim();

// ─── Wire up the parsing pipeline ────────────────────────────────────────────

const msgStartReg =
  /\[([^\]]+)\]\[[^\]]+\]GameLog:\sDisplay:\s\[Game\]\s-+.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sSTT-+([^-]+)-+SynId\s=\s(\d*).*/i;

let lastNotCompleteMsg = null;
let lastSearchPriceId = null;
let inBagInit = false;
let pendingBagInventory = {};
const events = [];

function handleItemChange(content) {
  // Individual item pickup during gameplay
  const addMatch = content.match(/^Add Id=(\d+)_\S+ BagNum=(\d+)/);
  if (addMatch) {
    events.push({ type: 'PickItem', baseId: addMatch[1], count: parseInt(addMatch[2]) });
  }
}

function routeLine(line) {
  // BagMgr@:InitBagData — full inventory snapshot (login / area enter)
  const bagMatch = line.match(/BagMgr@:InitBagData.*ConfigBaseId\s*=\s*(\d+)\s+Num\s*=\s*(\d+)/);
  if (bagMatch) {
    if (!inBagInit) {
      inBagInit = true;
      pendingBagInventory = {};
    }
    const baseId = bagMatch[1], count = parseInt(bagMatch[2]);
    if (pendingBagInventory[baseId]) pendingBagInventory[baseId].count += count;
    else pendingBagInventory[baseId] = { baseId, count };
    return;
  }

  // Finalize inventory snapshot when BagMgr lines stop
  if (inBagInit) {
    events.push({ type: 'InventorySnapshot', items: Object.values(pendingBagInventory) });
    inBagInit = false;
    pendingBagInventory = {};
  }

  // ItemChange@ — individual item changes during gameplay
  const itemChangeMatch = line.match(/\]GameLog:\sDisplay:\s\[Game\]\sItemChange@\s(.+)/);
  if (itemChangeMatch) {
    handleItemChange(itemChangeMatch[1].trim());
    return;
  }

  // Socket message format (price checking)
  const isMsgEnd = line.match(/.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sEnd.*/i);
  if (isMsgEnd) {
    if (!lastNotCompleteMsg) return;
    const msg = lastNotCompleteMsg;
    lastNotCompleteMsg = null;
    const rawData = msg.data.join('\n');

    if (msg.action === 'XchgSyncSearchPrice' && msg.type === 'SendMessage') {
      const parsed = parseTorchlightData(rawData);
      if (parsed.itemBaseId > 0) lastSearchPriceId = parsed.itemBaseId;
      events.push({ type: 'PriceSearchStart', itemId: lastSearchPriceId });

    } else if (msg.action === 'XchgSearchPrice' && msg.type === 'SendMessage') {
      const parsed = parseTorchlightData(rawData);
      lastSearchPriceId = parsed?.filters?.['1']?.refer;
      events.push({ type: 'PriceSearchStart', itemId: lastSearchPriceId });

    } else if (msg.action === 'XchgSearchPrice' && msg.type === 'RecvMessage') {
      const parsed = parseTorchlightData(rawData);
      const unitPrices = [];
      Object.values(parsed.prices || {}).forEach((p) => {
        if (p.currency == '100300') {
          Object.values(p.unitPrices || {}).forEach((v) => unitPrices.push(Number(v)));
        }
      });
      events.push({ type: 'PriceResult', itemId: lastSearchPriceId, prices: unitPrices });

    } else if (msg.action === 'EnterArea' && msg.type === 'RecvMessage') {
      const parsed = parseTorchlightData(rawData);
      events.push({ type: 'EnterArea', areaId: parsed.areaId, mapId: parsed.mapId });
    }
  } else {
    const msgStart = line.match(msgStartReg);
    if (msgStart) {
      lastNotCompleteMsg = { type: msgStart[2], action: msgStart[3].trim(), synId: msgStart[4], data: [] };
    } else if (lastNotCompleteMsg && !line.match(/errCode/) && !line.match(/^\[[^\]]+\].*GameLog.*/)) {
      lastNotCompleteMsg.data.push(line);
    }
  }
}

// ─── Run the test ─────────────────────────────────────────────────────────────

console.log('=== TLI Log Parser Test ===\n');

const lines = SAMPLE_LOG.split('\n');
lines.forEach((line) => routeLine(line.trim()));

console.log(`Parsed ${events.length} events from ${lines.length} log lines:\n`);

events.forEach((evt, i) => {
  console.log(`[${i + 1}] ${evt.type}`);
  console.log(JSON.stringify(evt, null, 2));
  console.log();
});

// ─── Test parseTorchlightData directly ───────────────────────────────────────

console.log('=== Direct parseTorchlightData test ===\n');

const rawPickItems = `+items+1+baseId [3004]
|      +count [5]
|      +uuid [abc-001]
+items+2+baseId [100300]
|      +count [120]
|      +uuid [abc-002]`;

const parsed = parseTorchlightData(rawPickItems);
console.log('Parsed item data:');
console.log(JSON.stringify(parsed, null, 2));

// ─── Optional: test against a real log file ───────────────────────────────────

const realLogPath = process.argv[2];
if (realLogPath) {
  console.log(`\n=== Reading real log file: ${realLogPath} ===\n`);
  if (fs.existsSync(realLogPath)) {
    const content = fs.readFileSync(realLogPath, 'utf8');
    const realLines = content.split('\n');
    lastNotCompleteMsg = null;
    lastSearchPriceId = null;
    const realEventsBefore = events.length;

    realLines.forEach((line) => routeLine(line.trim()));

    const realEventsFound = events.slice(realEventsBefore);
    console.log(`Found ${realEventsFound.length} events in real log:`);
    const counts = {};
    realEventsFound.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
    console.log(counts);
  } else {
    console.log('File not found:', realLogPath);
  }
} else {
  console.log('Tip: Pass a real UE_game.log path as an argument to test against live data:');
  console.log('  node test/log-parser-test.js "C:\\path\\to\\UE_game.log"');
}
