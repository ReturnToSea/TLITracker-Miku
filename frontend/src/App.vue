<script setup>
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'

// ── Log parsing (same logic as src/tor/main.js dealMsg) ───────────────────
const msgStartReg =
  /\[([^\]]+)\]\[[^\]]+\]GameLog:\sDisplay:\s\[Game\]\s-+.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sSTT-+([^-]+)-+SynId\s=\s(\d*).*/i

let lastNotCompleteMsg = null
let lastSearchPriceId = null

function parseTorchlightData(textData) {
  const root = {}
  const lines = textData
    .trim()
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('+errCode'))
    .map((l) => l.trim())

  const lastKeys = []
  for (const line of lines) {
    let copyLine = line
    lastKeys.forEach((key) => { copyLine = copyLine.replace('|', '+' + key) })
    const keys = copyLine.split('+').map((s) => s.trim()).filter(Boolean)
    lastKeys.length = 0
    lastKeys.push(...keys.filter((a) => !a.match(/(\S+).*\[([^\]]*)\]/)))
    let ctx = root
    for (let i = 0; i < keys.length; i++) {
      const vm = keys[i].match(/(\S+).*\[([^\]]*)\]/)
      if (vm) { ctx[vm[1]] = vm[2] }
      else { if (!ctx[keys[i]]) ctx[keys[i]] = {}; ctx = ctx[keys[i]] }
    }
  }
  return root
}

function processLine(line) {
  const isMsgEnd = line.match(/.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sEnd.*/i)

  if (isMsgEnd) {
    if (!lastNotCompleteMsg) return
    const msg = lastNotCompleteMsg
    lastNotCompleteMsg = null
    handleMessage(msg)
  } else {
    const msgStart = line.match(msgStartReg)
    if (msgStart) {
      lastNotCompleteMsg = {
        type: msgStart[2],
        action: msgStart[3].trim(),
        synId: msgStart[4],
        data: [],
      }
    } else if (lastNotCompleteMsg && !line.match(/errCode/) && !line.match(/^\[[^\]]+\].*GameLog.*/)) {
      lastNotCompleteMsg.data.push(line)
    }
  }
}

function handleMessage(msg) {
  const rawData = msg.data.join('\n')

  if (msg.action === 'PickItem' || msg.action === 'PickItems') {
    const parsed = parseTorchlightData(rawData)
    addPickup(parsed, msg.action)

  } else if (msg.action === 'ResetItemsLayout') {
    const parsed = parseTorchlightData(rawData)
    state.inventorySnapshot = parsed

  } else if (msg.action === 'EnterArea' && msg.type === 'RecvMessage') {
    const parsed = parseTorchlightData(rawData)
    if (parsed.areaId) startNewMap(parsed.areaId, parsed.mapId)

  } else if (msg.action === 'XchgSyncSearchPrice' && msg.type === 'SendMessage') {
    const parsed = parseTorchlightData(rawData)
    if (parsed.itemBaseId > 0) lastSearchPriceId = parsed.itemBaseId

  } else if (msg.action === 'XchgSearchPrice' && msg.type === 'SendMessage') {
    const parsed = parseTorchlightData(rawData)
    lastSearchPriceId = parsed?.filters?.['1']?.refer

  } else if (msg.action === 'XchgSearchPrice' && msg.type === 'RecvMessage') {
    const parsed = parseTorchlightData(rawData)
    updatePrice(parsed, lastSearchPriceId)
  }
}

// ── State ──────────────────────────────────────────────────────────────────
const state = reactive({
  status: 'idle',        // idle | connecting | watching | error
  logPath: '',
  currentMap: null,      // { areaId, mapId, startTime, pickups: [] }
  mapHistory: [],        // array of completed maps
  prices: {},            // baseId → price
  inventorySnapshot: null,
  errorMsg: '',
})

const sessionPickups = computed(() => {
  const all = state.mapHistory.flatMap((m) => m.pickups)
  if (state.currentMap) all.push(...state.currentMap.pickups)
  return all
})

const sessionMapCount = computed(() => state.mapHistory.length + (state.currentMap ? 1 : 0))

function startNewMap(areaId, mapId) {
  if (state.currentMap) {
    state.mapHistory.push({ ...state.currentMap })
  }
  state.currentMap = { areaId, mapId, startTime: Date.now(), pickups: [] }
}

function addPickup(data, action) {
  const target = state.currentMap ?? (state.currentMap = { areaId: 'unknown', mapId: null, startTime: Date.now(), pickups: [] })
  if (action === 'PickItem') {
    target.pickups.push({ baseId: data.baseId, count: Number(data.count) || 1 })
  } else {
    // PickItems — iterate items object
    Object.values(data.items ?? {}).forEach((item) => {
      if (item.baseId) target.pickups.push({ baseId: item.baseId, count: Number(item.count) || 1 })
    })
  }
}

function updatePrice(data, itemId) {
  if (!itemId) return
  const unitPrices = []
  Object.values(data.prices ?? {}).forEach((p) => {
    if (p.currency === '100300') {
      Object.values(p.unitPrices ?? {}).forEach((v) => unitPrices.push(Number(v)))
    }
  })
  if (unitPrices.length) {
    const sorted = [...unitPrices].sort((a, b) => a - b)
    state.prices[itemId] = sorted[Math.floor(sorted.length / 2)] // median
  }
}

// ── Electron connection ────────────────────────────────────────────────────
let ws = null

async function connectWebSocket() {
  if (!window.electronAPI) return
  const port = await window.electronAPI.getWssPort()
  if (!port) return

  ws = new WebSocket(`ws://127.0.0.1:${port}`)

  ws.onopen = () => {
    state.status = 'watching'
    ws.send(JSON.stringify({ type: 'READY' }))
  }

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data)
      if (payload.type === 'BATCH') {
        payload.messages.forEach((line) => processLine(line))
        ws.send(JSON.stringify({ type: 'BATCH_PROCESSED', batchId: payload.batchId }))
      }
    } catch (_) {}
  }

  ws.onclose = () => {
    ws = null
    if (state.status === 'watching') state.status = 'idle'
    // Fall back to IPC
    window.electronAPI?.onLogBatch((payload) => {
      payload.messages?.forEach((line) => processLine(line))
      window.electronAPI.sendIpcBatchProcessed(payload.batchId)
    })
  }
}

async function pickLogFile() {
  if (!window.electronAPI) return
  const filePath = await window.electronAPI.openFileDialog()
  if (!filePath) return
  state.logPath = filePath
  state.status = 'connecting'
  await window.electronAPI.startTorLog(filePath)
  await connectWebSocket()
}

async function stopTracking() {
  if (!window.electronAPI) return
  await window.electronAPI.stopTorLog()
  if (ws) { ws.close(); ws = null }
  state.status = 'idle'
}

function resetSession() {
  state.currentMap = null
  state.mapHistory = []
}

// Window controls
const closeWindow = () => window.electronAPI?.closeWindow()
const minimizeWindow = () => window.electronAPI?.minimizeWindow()

onMounted(() => {
  // If already in watching state (e.g. page reload), reconnect
  window.electronAPI?.getTorStatus().then((s) => {
    if (s?.isLoggingActive) {
      state.logPath = s.currentLogPath
      state.status = 'connecting'
      connectWebSocket()
    }
  })
})

onUnmounted(() => {
  if (ws) ws.close()
})
</script>

<template>
  <div class="app">
    <!-- Title bar -->
    <div class="titlebar" style="-webkit-app-region: drag">
      <span class="titlebar-title">TLI Tracker</span>
      <div class="titlebar-controls" style="-webkit-app-region: no-drag">
        <button class="tb-btn" @click="minimizeWindow">─</button>
        <button class="tb-btn tb-btn--close" @click="closeWindow">✕</button>
      </div>
    </div>

    <!-- Main content -->
    <div class="content">

      <!-- Setup panel -->
      <div v-if="state.status === 'idle'" class="setup-panel">
        <h2>TLI Tracker</h2>
        <p class="hint">
          Make sure <strong>Logging</strong> is enabled in TLI settings,<br>
          then select your <code>UE_game.log</code> file.
        </p>
        <button class="btn btn--primary" @click="pickLogFile">Select Log File</button>
        <p v-if="state.logPath" class="log-path">{{ state.logPath }}</p>
      </div>

      <!-- Connecting -->
      <div v-else-if="state.status === 'connecting'" class="setup-panel">
        <p>Connecting…</p>
      </div>

      <!-- Tracker dashboard -->
      <div v-else class="dashboard">

        <!-- Status bar -->
        <div class="status-bar">
          <span class="status-dot" :class="{ active: state.status === 'watching' }"></span>
          <span class="status-text">{{ state.status === 'watching' ? 'Watching' : 'Idle' }}</span>
          <span class="log-path-small">{{ state.logPath }}</span>
          <div class="status-actions">
            <button class="btn btn--small" @click="resetSession">Reset</button>
            <button class="btn btn--small btn--danger" @click="stopTracking">Stop</button>
          </div>
        </div>

        <!-- Stats row -->
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-value">{{ sessionMapCount }}</div>
            <div class="stat-label">Maps Run</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ sessionPickups.length }}</div>
            <div class="stat-label">Items Picked Up</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ state.currentMap?.areaId ?? '—' }}</div>
            <div class="stat-label">Current Area</div>
          </div>
        </div>

        <!-- Current map pickups -->
        <div class="section">
          <h3>Current Map</h3>
          <div v-if="!state.currentMap" class="empty">No active map — enter a map in game.</div>
          <div v-else>
            <div class="pickup-list">
              <div
                v-for="(pickup, i) in state.currentMap.pickups"
                :key="i"
                class="pickup-row"
              >
                <span class="pickup-id">{{ pickup.baseId }}</span>
                <span class="pickup-count">×{{ pickup.count }}</span>
                <span v-if="state.prices[pickup.baseId]" class="pickup-price">
                  {{ state.prices[pickup.baseId] }} 🔥
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Map history -->
        <div class="section">
          <h3>Map History ({{ state.mapHistory.length }})</h3>
          <div v-if="!state.mapHistory.length" class="empty">No completed maps yet.</div>
          <div v-else class="history-list">
            <div
              v-for="(map, i) in [...state.mapHistory].reverse()"
              :key="i"
              class="history-row"
            >
              <span class="history-area">{{ map.areaId }}</span>
              <span class="history-count">{{ map.pickups.length }} items</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: radial-gradient(1200px 600px at 20% 10%, #1f2937 0%, #0f172a 50%, #05070a 100%);
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
}

/* Title bar */
.titlebar {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  background: rgba(0,0,0,0.3);
  flex-shrink: 0;
}
.titlebar-title {
  font-size: 13px;
  font-weight: 600;
  color: #9ca3af;
  flex: 1;
}
.titlebar-controls { display: flex; gap: 4px; }
.tb-btn {
  width: 28px;
  height: 22px;
  background: rgba(255,255,255,0.06);
  border-radius: 4px;
  color: #9ca3af;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.tb-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
.tb-btn--close:hover { background: #dc2626; color: #fff; }

/* Content */
.content { flex: 1; overflow-y: auto; padding: 20px; }

/* Setup */
.setup-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  text-align: center;
}
.setup-panel h2 { font-size: 24px; color: #f9fafb; }
.hint { color: #9ca3af; line-height: 1.6; }
.hint strong { color: #e5e7eb; }
.hint code { background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 3px; }
.log-path { font-size: 11px; color: #6b7280; word-break: break-all; max-width: 400px; }

/* Buttons */
.btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s;
}
.btn--primary { background: #3b82f6; color: #fff; }
.btn--primary:hover { background: #2563eb; }
.btn--small { padding: 4px 10px; font-size: 12px; background: rgba(255,255,255,0.08); color: #d1d5db; }
.btn--small:hover { background: rgba(255,255,255,0.14); }
.btn--danger { color: #fca5a5; }
.btn--danger:hover { background: rgba(220,38,38,0.3); }

/* Dashboard */
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 8px 12px;
  background: rgba(0,0,0,0.2);
  border-radius: 6px;
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #4b5563;
  flex-shrink: 0;
}
.status-dot.active { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
.status-text { font-size: 12px; color: #9ca3af; }
.log-path-small { font-size: 11px; color: #4b5563; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-actions { display: flex; gap: 6px; }

.stats-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  padding: 14px;
  text-align: center;
}
.stat-value { font-size: 22px; font-weight: 600; color: #f9fafb; }
.stat-label { font-size: 11px; color: #6b7280; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }

.section { margin-bottom: 20px; }
.section h3 { font-size: 13px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
.empty { color: #4b5563; font-size: 13px; padding: 12px 0; }

.pickup-list, .history-list { display: flex; flex-direction: column; gap: 2px; }
.pickup-row, .history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 4px;
  font-size: 13px;
}
.pickup-id, .history-area { flex: 1; color: #e5e7eb; font-family: monospace; }
.pickup-count, .history-count { color: #6b7280; }
.pickup-price { color: #fbbf24; font-weight: 600; }
</style>
