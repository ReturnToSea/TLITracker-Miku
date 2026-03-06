<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'

// ── Log parsing ────────────────────────────────────────────────────────────
const msgStartReg =
  /\[([^\]]+)\]\[[^\]]+\]GameLog:\sDisplay:\s\[Game\]\s-+.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sSTT-+([^-]+)-+SynId\s=\s(\d*).*/i

let lastNotCompleteMsg = null
let lastSearchPriceId = null

// BagMgr@ inventory snapshot tracking
// Format: BagMgr@:InitBagData PageId = X SlotId = Y ConfigBaseId = Z Num = W
let inBagInit = false
let pendingBagInventory = {}

function handleItemChange(content) {
  // Individual item pickup during gameplay
  const addMatch = content.match(/^Add Id=(\d+)_\S+ BagNum=(\d+)/)
  if (addMatch) {
    addPickup([{ baseId: addMatch[1], count: parseInt(addMatch[2]) }])
  }
}

function parseTorchlightData(textData) {
  const root = {}
  const lines = textData.trim().split('\n')
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
  state.isLogging = true

  // BagMgr@:InitBagData — full inventory snapshot sent on login / area enter
  // Format: ...BagMgr@:InitBagData PageId = X SlotId = Y ConfigBaseId = BASEID Num = COUNT
  const bagMatch = line.match(/BagMgr@:InitBagData.*ConfigBaseId\s*=\s*(\d+)\s+Num\s*=\s*(\d+)/)
  if (bagMatch) {
    if (!inBagInit) {
      inBagInit = true
      pendingBagInventory = {}
    }
    const baseId = bagMatch[1]
    const count = parseInt(bagMatch[2])
    if (pendingBagInventory[baseId]) {
      pendingBagInventory[baseId].count += count
    } else {
      pendingBagInventory[baseId] = { baseId, count }
    }
    return
  }

  // Finalize inventory snapshot when BagMgr lines stop
  if (inBagInit) {
    state.inventory = Object.values(pendingBagInventory)
    state.hasInventory = true
    inBagInit = false
    pendingBagInventory = {}
  }

  // ItemChange@ — individual item changes during gameplay (pickups)
  const itemChangeMatch = line.match(/\]GameLog:\sDisplay:\s\[Game\]\sItemChange@\s(.+)/)
  if (itemChangeMatch) {
    handleItemChange(itemChangeMatch[1].trim())
    return
  }

  // Socket message format (price checking)
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

  if (msg.action === 'PickItem') {
    const p = parseTorchlightData(rawData)
    addPickup([{ baseId: p.baseId, count: Number(p.count) || 1 }])

  } else if (msg.action === 'PickItems') {
    const p = parseTorchlightData(rawData)
    const items = Object.values(p.items ?? {})
      .filter((i) => i.baseId)
      .map((i) => ({ baseId: i.baseId, count: Number(i.count) || 1 }))
    addPickup(items)

  } else if (msg.action === 'ResetItemsLayout') {
    const p = parseTorchlightData(rawData)
    // Flatten items object into array
    state.inventory = Object.values(p.items ?? {})
      .filter((i) => i.baseId)
      .map((i) => ({ baseId: i.baseId, count: Number(i.count) || 1 }))
    state.hasInventory = true

  } else if (msg.action === 'EnterArea' && msg.type === 'RecvMessage') {
    const p = parseTorchlightData(rawData)
    if (p.areaId) startNewMap(p.areaId, p.mapId, p.checkType)

  } else if (msg.action === 'XchgSyncSearchPrice' && msg.type === 'SendMessage') {
    const p = parseTorchlightData(rawData)
    if (p.itemBaseId > 0) lastSearchPriceId = p.itemBaseId

  } else if (msg.action === 'XchgSearchPrice' && msg.type === 'SendMessage') {
    const p = parseTorchlightData(rawData)
    lastSearchPriceId = p?.filters?.['1']?.refer

  } else if (msg.action === 'XchgSearchPrice' && msg.type === 'RecvMessage') {
    updatePrice(parseTorchlightData(rawData), lastSearchPriceId)
  }
}

// ── State ──────────────────────────────────────────────────────────────────
const state = reactive({
  status: 'idle',
  logPath: '',
  isLogging: false,      // true once first log line received
  hasInventory: false,   // true once ResetItemsLayout received
  inventory: [],         // [{ baseId, count }]
  prices: {},            // baseId → price
  basePriceIds: new Set(), // IDs from prices.json — only these get log price updates
  priceNames: {},        // baseId → name (from titrack.ninja)
  priceLastUpdated: null,
  currentMap: null,      // { areaId, mapId, checkType, startTime, pickups: [] }
  mapHistory: [],
  sessionStart: null,
})

// ── Computed stats ─────────────────────────────────────────────────────────
function itemValue(baseId, count) {
  return (state.prices[baseId] ?? 0) * count
}

function mapProfit(map) {
  return map.pickups.reduce((s, p) => s + itemValue(p.baseId, p.count), 0)
}

const networth = computed(() =>
  state.inventory.reduce((s, i) => s + itemValue(i.baseId, i.count), 0)
)

const sessionProfit = computed(() => {
  const maps = [...state.mapHistory, ...(state.currentMap ? [state.currentMap] : [])]
  return maps.reduce((s, m) => s + mapProfit(m), 0)
})

const profitPerMin = computed(() => {
  if (!state.sessionStart) return 0
  const mins = (now.value - state.sessionStart) / 60000
  return mins < 0.1 ? 0 : sessionProfit.value / mins
})

const profitPerHour = computed(() => {
  if (!state.sessionStart) return 0
  const hours = (now.value - state.sessionStart) / 3600000
  return hours < (0.1 / 60) ? 0 : sessionProfit.value / hours
})

const logStatus = computed(() => {
  if (state.status !== 'watching') return 'disconnected'
  if (!state.isLogging) return 'waiting'
  if (!state.hasInventory) return 'need-inventory'
  return 'ok'
})

const allMaps = computed(() => {
  const maps = []
  if (state.currentMap) maps.push({ ...state.currentMap, live: true })
  return maps.concat([...state.mapHistory].reverse())
})

// ── Helpers ────────────────────────────────────────────────────────────────
function startNewMap(areaId, mapId, checkType) {
  if (state.currentMap) state.mapHistory.push({ ...state.currentMap, endTime: Date.now() })
  if (!state.sessionStart) state.sessionStart = Date.now()
  state.currentMap = { areaId, mapId, checkType, startTime: Date.now(), pickups: [] }
}

function addPickup(items) {
  if (!state.currentMap) {
    state.currentMap = { areaId: 'unknown', mapId: null, checkType: null, startTime: Date.now(), pickups: [] }
    if (!state.sessionStart) state.sessionStart = Date.now()
  }
  state.currentMap.pickups.push(...items)
}

function updatePrice(data, itemId) {
  if (!itemId) return
  // Only update price if this item is a known tradeable item from titrack.ninja
  if (state.basePriceIds.size > 0 && !state.basePriceIds.has(String(itemId))) return
  const unitPrices = []
  Object.values(data.prices ?? {}).forEach((p) => {
    if (p.currency == '100300')
      Object.values(p.unitPrices ?? {}).forEach((v) => unitPrices.push(v))
  })
  if (!unitPrices.length) return

  // Group by rounded value, count occurrences — pick the mode (same as example)
  const mergedPrices = unitPrices.reduce((acc, price) => {
    const a = String(price).match(/(0\.0*).*/)
    const fixNum = a ? a[1].length : 1
    const key = `${Number(Number(price).toFixed(fixNum))}`
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})

  const sortedPrices = Object.keys(mergedPrices).sort((a, b) => mergedPrices[b] - mergedPrices[a])
  if (sortedPrices.length > 0) state.prices[itemId] = Number(sortedPrices[0])
}

function formatVal(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return n.toFixed(1)
}

function fmtDuration(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function mapTime(map) {
  return fmtDuration((map.endTime ?? now.value) - map.startTime)
}

const totalMapsTime = computed(() => {
  const maps = [...state.mapHistory, ...(state.currentMap ? [state.currentMap] : [])]
  const ms = maps.reduce((s, m) => s + ((m.endTime ?? now.value) - m.startTime), 0)
  return fmtDuration(ms)
})

const realTime = computed(() => {
  if (!state.sessionStart) return '0:00'
  return fmtDuration(now.value - state.sessionStart)
})

const lootPanelItems = computed(() => {
  let pickups = []
  if (lootPanelMode.value === 'map' && state.currentMap) {
    pickups = state.currentMap.pickups
  } else {
    const maps = [...state.mapHistory, ...(state.currentMap ? [state.currentMap] : [])]
    maps.forEach(m => pickups.push(...m.pickups))
  }
  const grouped = {}
  pickups.forEach(p => {
    if (!grouped[p.baseId]) grouped[p.baseId] = { baseId: p.baseId, count: 0 }
    grouped[p.baseId].count += p.count
  })
  return Object.values(grouped)
    .map(p => ({ ...p, value: itemValue(p.baseId, p.count), name: state.priceNames[p.baseId] ?? `#${p.baseId}` }))
    .sort((a, b) => b.value - a.value)
})

const inventorySorted = computed(() => {
  return [...state.inventory]
    .map(i => ({ ...i, value: itemValue(i.baseId, i.count), name: state.priceNames[i.baseId] ?? `#${i.baseId}` }))
    .sort((a, b) => b.value - a.value)
})

function mapLabel(map) {
  if (map.mapId) return `Map ${map.mapId}`
  const prefix = map.areaId?.split('_')[0]
  return prefix ? `Area ${prefix}` : 'Unknown'
}

// ── Settings ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'tli-log-path'
const activeTab = ref('overview')
const logFilePath = ref(localStorage.getItem(STORAGE_KEY) ?? '')
const now = ref(Date.now())
const lootPanelMode = ref('map')

async function pickLogFile() {
  if (!window.electronAPI) return
  const file = await window.electronAPI.openFileDialog()
  if (!file) return
  logFilePath.value = file
  localStorage.setItem(STORAGE_KEY, file)
  if (state.status !== 'idle') await stopTracking()
  await startWatching(file)
  activeTab.value = 'overview'
}

// ── Electron connection ────────────────────────────────────────────────────
let ws = null
let profitTimer = null

async function startWatching(logPath) {
  state.logPath = logPath
  state.status = 'connecting'
  await window.electronAPI.startTorLog(logPath)
  await connectWebSocket()
  profitTimer = setInterval(() => { now.value = Date.now() }, 1000)
}

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
    // IPC fallback — main process sends individual tor-log-msg events
    window.electronAPI?.onLogMsg((line) => processLine(line))
  }

  ws.onerror = () => {
    // Will trigger onclose which sets up IPC fallback
  }
}

async function stopTracking() {
  await window.electronAPI?.stopTorLog()
  if (ws) { ws.close(); ws = null }
  if (profitTimer) { clearInterval(profitTimer); profitTimer = null }
  state.status = 'idle'
  state.isLogging = false
}

function resetSession() {
  state.currentMap = null
  state.mapHistory = []
  state.sessionStart = null
  state.isLogging = false
  state.hasInventory = false
  state.inventory = []
}

const closeWindow = () => window.electronAPI?.closeWindow()
const minimizeWindow = () => window.electronAPI?.minimizeWindow()

// ── Pricing ────────────────────────────────────────────────────────────────
const pricingLoading = ref(false)
const pricingError = ref('')

const pricingTableItems = computed(() => {
  return Object.entries(state.priceNames)
    .map(([id, name]) => ({ id, name, price: state.prices[id] ?? 0 }))
    .sort((a, b) => b.price - a.price)
})

async function refreshPrices() {
  if (pricingLoading.value) return
  pricingLoading.value = true
  pricingError.value = ''
  try {
    const result = await window.electronAPI.fetchPrices()
    // Refresh wins — overwrite everything including any log-derived prices
    state.prices = { ...result.prices }
    state.basePriceIds = new Set(Object.keys(result.prices))
    state.priceNames = result.names ?? {}
    state.priceLastUpdated = result.lastUpdated
  } catch (e) {
    pricingError.value = e.message ?? 'Failed to fetch prices'
  } finally {
    pricingLoading.value = false
  }
}

function formatDate(ts) {
  if (!ts) return 'Never'
  return new Date(ts).toLocaleString()
}

onMounted(async () => {
  // Load saved prices from file (gives baseline without hitting the site)
  const saved = await window.electronAPI?.loadPrices()
  if (saved?.prices) {
    Object.assign(state.prices, saved.prices)
    state.basePriceIds = new Set(Object.keys(saved.prices))
    state.priceNames = saved.names ?? {}
    state.priceLastUpdated = saved.lastUpdated
  }

  const s = await window.electronAPI?.getTorStatus()
  if (s?.isLoggingActive) {
    state.logPath = s.currentLogPath
    state.status = 'connecting'
    await connectWebSocket()
    return
  }
  const savedPath = localStorage.getItem(STORAGE_KEY)
  if (savedPath && window.electronAPI) {
    await startWatching(savedPath)
  } else {
    activeTab.value = 'settings'
  }
})

onUnmounted(() => {
  if (ws) ws.close()
  if (profitTimer) clearInterval(profitTimer)
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

    <!-- Body -->
    <div class="body">

      <!-- Sidebar tabs -->
      <div class="sidebar">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'overview' }"
          @click="activeTab = 'overview'"
        >Overview</button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'pricing' }"
          @click="activeTab = 'pricing'"
        >Pricing</button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'loot' }"
          @click="activeTab = 'loot'"
        >Loot</button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'settings' }"
          @click="activeTab = 'settings'"
        >Settings</button>
      </div>

      <!-- Main content -->
      <div class="main">

        <!-- Overview tab -->
        <div v-if="activeTab === 'overview'" class="panel">

          <!-- Top stats + reset -->
          <div class="stats-top-row">
            <div class="stats-row">
              <div class="stat-card">
                <div class="stat-label">Networth</div>
                <div class="stat-value">{{ formatVal(networth) }} 🔥</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Profit</div>
                <div class="stat-value">{{ formatVal(sessionProfit) }} 🔥</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">FE/min</div>
                <div class="stat-value">{{ formatVal(profitPerMin) }} 🔥</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">FE/hr</div>
                <div class="stat-value">{{ formatVal(profitPerHour) }} 🔥</div>
              </div>
            </div>
            <button class="btn btn--small reset-btn" @click="resetSession">Reset Session</button>
          </div>

          <!-- Log status notice -->
          <div class="status-notice" :class="'status-notice--' + logStatus">
            <span class="status-dot" :class="'dot--' + logStatus"></span>
            <span v-if="logStatus === 'ok'">Tracking active</span>
            <span v-else-if="logStatus === 'need-inventory'">
              Sort your inventory or relog to get initial snapshot
            </span>
            <span v-else-if="logStatus === 'waiting'">
              Waiting for log data — make sure <strong>Logging</strong> is enabled in TLI settings
            </span>
            <span v-else>Not connected —
              <button class="link-btn" @click="activeTab = 'settings'">select log file</button>
            </span>
          </div>

          <!-- Timers -->
          <div class="timers-row">
            <div class="timer-item">
              <span class="timer-label">Time in Maps</span>
              <span class="timer-val">{{ totalMapsTime }}</span>
            </div>
            <div class="timer-item">
              <span class="timer-label">Real Time</span>
              <span class="timer-val">{{ realTime }}</span>
            </div>
          </div>

          <!-- Map list + Loot panel -->
          <div class="map-loot-area">
            <div class="map-list-section">
              <div class="map-list-header">
                <span class="col-area">Area</span>
                <span class="col-made">FE Made</span>
                <span class="col-profit">Profit</span>
                <span class="col-time">Time</span>
              </div>
              <div class="map-list">
                <div v-if="!allMaps.length" class="empty">No maps yet — enter a map in game.</div>
                <div
                  v-for="(map, i) in allMaps"
                  :key="i"
                  class="map-row"
                  :class="{ 'map-row--live': map.live }"
                >
                  <span class="col-area">
                    <span v-if="map.live" class="live-badge">LIVE</span>
                    {{ mapLabel(map) }}
                  </span>
                  <span class="col-made">{{ formatVal(mapProfit(map)) }} 🔥</span>
                  <span class="col-profit" :class="mapProfit(map) > 0 ? 'positive' : ''">
                    {{ formatVal(mapProfit(map)) }} 🔥
                  </span>
                  <span class="col-time muted">{{ mapTime(map) }}</span>
                </div>
              </div>
            </div>

            <!-- Loot panel -->
            <div class="loot-panel">
              <div class="loot-panel-header">
                <span class="loot-panel-title">Loot</span>
                <div class="loot-toggle">
                  <button
                    class="loot-toggle-btn"
                    :class="{ active: lootPanelMode === 'map' }"
                    @click="lootPanelMode = 'map'"
                  >Map</button>
                  <button
                    class="loot-toggle-btn"
                    :class="{ active: lootPanelMode === 'session' }"
                    @click="lootPanelMode = 'session'"
                  >Session</button>
                </div>
              </div>
              <div class="loot-list">
                <div v-if="!lootPanelItems.length" class="empty loot-empty">No loot yet.</div>
                <div v-for="item in lootPanelItems" :key="item.baseId" class="loot-row">
                  <span class="loot-name">{{ item.name }}</span>
                  <span class="loot-count muted">×{{ item.count }}</span>
                  <span class="loot-val">{{ formatVal(item.value) }} 🔥</span>
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- Loot tab -->
        <div v-else-if="activeTab === 'loot'" class="panel">
          <div class="pricing-header">
            <div class="pricing-title">Inventory by Value</div>
            <div class="pricing-meta">{{ inventorySorted.length }} items · {{ formatVal(networth) }} 🔥 total</div>
          </div>
          <div class="price-list-header inv-grid">
            <span class="col-name">Item</span>
            <span style="text-align:right">Qty</span>
            <span style="text-align:right">Unit FE</span>
            <span style="text-align:right">Total FE</span>
          </div>
          <div class="price-list">
            <div v-if="!inventorySorted.length" class="empty">
              No inventory data — sort your inventory or relog in game.
            </div>
            <div
              v-for="item in inventorySorted"
              :key="item.baseId"
              class="price-row inv-grid"
            >
              <span class="col-name">{{ item.name }}</span>
              <span style="text-align:right;color:#6b7280">×{{ item.count }}</span>
              <span style="text-align:right;color:#9ca3af">{{ state.prices[item.baseId] != null ? state.prices[item.baseId] : '—' }}</span>
              <span class="col-price price-val">{{ formatVal(item.value) }} 🔥</span>
            </div>
          </div>
        </div>

        <!-- Settings tab -->
        <div v-else-if="activeTab === 'settings'" class="panel center-panel">
          <h2>Settings</h2>
          <p class="hint">
            Select your <strong>UE_game.log</strong> file directly.<br>
            Make sure <strong>Logging</strong> is enabled in TLI settings first.
          </p>
          <button class="btn btn--primary" @click="pickLogFile">
            {{ logFilePath ? 'Change Log File' : 'Select Log File' }}
          </button>
          <p v-if="logFilePath" class="small-path">{{ logFilePath }}</p>
          <button
            v-if="state.logPath"
            class="btn btn--small"
            style="margin-top: 8px"
            @click="activeTab = 'overview'"
          >Back</button>
        </div>

        <!-- Pricing tab -->
        <div v-else-if="activeTab === 'pricing'" class="panel">
          <div class="pricing-header">
            <div>
              <div class="pricing-title">Market Prices</div>
              <div class="pricing-meta">
                Last updated: {{ formatDate(state.priceLastUpdated) }}
                <span v-if="pricingTableItems.length"> &middot; {{ pricingTableItems.length }} items</span>
              </div>
            </div>
            <button
              class="btn btn--primary"
              :disabled="pricingLoading"
              @click="refreshPrices"
            >{{ pricingLoading ? 'Fetching…' : 'Refresh Prices' }}</button>
          </div>

          <div v-if="pricingError" class="pricing-error">{{ pricingError }}</div>

          <div v-if="pricingLoading" class="pricing-loading">
            Fetching prices from titrack.ninja…
          </div>

          <template v-else>
            <div class="price-list-header">
              <span class="col-name">Item</span>
              <span class="col-price">Price (FE)</span>
            </div>
            <div class="price-list">
              <div v-if="!pricingTableItems.length" class="empty">
                No prices loaded — click Refresh Prices to fetch from titrack.ninja.
              </div>
              <div
                v-for="item in pricingTableItems"
                :key="item.id"
                class="price-row"
              >
                <span class="col-name">{{ item.name }}</span>
                <span class="col-price price-val">{{ item.price }} FE</span>
              </div>
            </div>
          </template>
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
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.06);
}

/* Title bar */
.titlebar {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  background: rgba(0,0,0,0.35);
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.titlebar-title { font-size: 13px; font-weight: 600; color: #6b7280; flex: 1; }
.titlebar-controls { display: flex; gap: 4px; }
.tb-btn {
  width: 28px; height: 22px;
  background: rgba(255,255,255,0.05);
  border-radius: 4px; color: #6b7280; font-size: 11px;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s;
}
.tb-btn:hover { background: rgba(255,255,255,0.12); color: #e5e7eb; }
.tb-btn--close:hover { background: #dc2626; color: #fff; }

/* Body layout */
.body { display: flex; flex: 1; overflow: hidden; }

/* Sidebar */
.sidebar {
  width: 110px;
  flex-shrink: 0;
  background: rgba(0,0,0,0.2);
  border-right: 1px solid rgba(255,255,255,0.05);
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tab-btn {
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  background: transparent;
  border-radius: 6px;
  color: #6b7280;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}
.tab-btn:hover { background: rgba(255,255,255,0.06); color: #d1d5db; }
.tab-btn.active { background: rgba(59,130,246,0.15); color: #93c5fd; }

/* Main */
.main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.panel { display: flex; flex-direction: column; height: 100%; padding: 16px; gap: 12px; overflow: hidden; }
.center-panel { align-items: center; justify-content: center; text-align: center; }

/* Settings panel */
.center-panel h2 { font-size: 20px; color: #f9fafb; }
.hint { color: #9ca3af; line-height: 1.6; font-size: 13px; }
.hint strong { color: #e5e7eb; }
.hint code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
.small-path { font-size: 11px; color: #4b5563; word-break: break-all; max-width: 380px; }
.find-msg { font-size: 12px; color: #9ca3af; }
.find-msg--error { color: #f87171; line-height: 1.6; }
.find-msg--error code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; }

/* Buttons */
.btn { padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; transition: background 0.15s; font-family: inherit; cursor: pointer; border: none; }
.btn--primary { background: #3b82f6; color: #fff; }
.btn--primary:hover { background: #2563eb; }
.btn--small { padding: 4px 10px; font-size: 12px; background: rgba(255,255,255,0.08); color: #d1d5db; }
.btn--small:hover { background: rgba(255,255,255,0.14); }
.link-btn { background: none; border: none; color: #60a5fa; cursor: pointer; font-size: inherit; padding: 0; text-decoration: underline; font-family: inherit; }

/* Stats row */
.stats-top-row { display: flex; align-items: flex-start; gap: 10px; flex-shrink: 0; }
.stats-top-row .stats-row { flex: 1; }
.reset-btn { flex-shrink: 0; align-self: flex-start; white-space: nowrap; }
.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.stat-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px; padding: 12px;
}
.stat-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.stat-value { font-size: 18px; font-weight: 600; color: #f9fafb; }

/* Status notice */
.status-notice {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 6px; font-size: 12px;
  flex-shrink: 0;
}
.status-notice--ok { background: rgba(34,197,94,0.1); color: #86efac; }
.status-notice--waiting { background: rgba(234,179,8,0.1); color: #fde047; }
.status-notice--need-inventory { background: rgba(251,191,36,0.1); color: #fcd34d; }
.status-notice--disconnected { background: rgba(239,68,68,0.08); color: #fca5a5; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot--ok { background: #22c55e; box-shadow: 0 0 5px #22c55e88; }
.dot--waiting { background: #eab308; }
.dot--need-inventory { background: #f59e0b; }
.dot--disconnected { background: #ef4444; }

/* Timers */
.timers-row { display: flex; gap: 20px; flex-shrink: 0; }
.timer-item { display: flex; flex-direction: column; }
.timer-label { font-size: 10px; color: #4b5563; text-transform: uppercase; letter-spacing: 0.05em; }
.timer-val { font-size: 15px; font-weight: 600; color: #d1d5db; font-variant-numeric: tabular-nums; }

/* Map + loot area */
.map-loot-area { display: flex; gap: 10px; flex: 1; overflow: hidden; }
.map-list-section { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

/* Map list */
.map-list-header {
  display: grid;
  grid-template-columns: 1fr 80px 80px 60px;
  padding: 4px 10px;
  font-size: 11px; color: #4b5563;
  text-transform: uppercase; letter-spacing: 0.04em;
  flex-shrink: 0;
}
.map-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.map-row {
  display: grid;
  grid-template-columns: 1fr 80px 80px 60px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 5px; font-size: 13px; color: #d1d5db;
  border: 1px solid transparent;
}
.map-row--live { border-color: rgba(59,130,246,0.25); background: rgba(59,130,246,0.06); }
.live-badge {
  display: inline-block; font-size: 9px; font-weight: 700;
  background: #3b82f6; color: #fff;
  padding: 1px 4px; border-radius: 3px; margin-right: 5px; vertical-align: middle;
}
.col-area { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-made, .col-profit, .col-time { text-align: right; }
.muted { color: #4b5563; }
.positive { color: #86efac; }
.empty { color: #374151; font-size: 13px; padding: 16px 0; text-align: center; }

/* Loot panel (in overview) */
.loot-panel {
  width: 240px; flex-shrink: 0;
  display: flex; flex-direction: column;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 8px; overflow: hidden;
}
.loot-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.05);
  flex-shrink: 0;
}
.loot-panel-title { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
.loot-toggle { display: flex; gap: 2px; }
.loot-toggle-btn {
  padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
  background: transparent; color: #4b5563; font-family: inherit; cursor: pointer; border: none;
  transition: background 0.12s, color 0.12s;
}
.loot-toggle-btn:hover { background: rgba(255,255,255,0.06); color: #9ca3af; }
.loot-toggle-btn.active { background: rgba(59,130,246,0.2); color: #93c5fd; }
.loot-list { flex: 1; overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; }
.loot-row {
  display: grid; grid-template-columns: 1fr 32px 70px;
  padding: 5px 6px; border-radius: 4px; font-size: 12px; color: #d1d5db;
  background: rgba(255,255,255,0.02);
}
.loot-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loot-count { text-align: right; }
.loot-val { text-align: right; color: #fbbf24; font-weight: 500; }
.loot-empty { padding: 12px 0; font-size: 12px; }

/* Inventory grid (loot tab) */
.inv-grid { grid-template-columns: 1fr 50px 70px 80px !important; }

/* Pricing tab */
.pricing-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  flex-shrink: 0; gap: 12px;
}
.pricing-title { font-size: 15px; font-weight: 600; color: #f9fafb; }
.pricing-meta { font-size: 11px; color: #4b5563; margin-top: 2px; }
.pricing-error {
  background: rgba(239,68,68,0.08); color: #f87171;
  padding: 8px 12px; border-radius: 6px; font-size: 12px; flex-shrink: 0;
}
.pricing-loading { color: #6b7280; font-size: 13px; padding: 16px 0; text-align: center; flex-shrink: 0; }
.price-list-header {
  display: grid; grid-template-columns: 1fr 100px;
  padding: 4px 10px;
  font-size: 11px; color: #4b5563;
  text-transform: uppercase; letter-spacing: 0.04em;
  flex-shrink: 0;
}
.price-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.price-row {
  display: grid; grid-template-columns: 1fr 100px;
  padding: 6px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 5px; font-size: 13px; color: #d1d5db;
}
.col-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-price { text-align: right; }
.price-val { color: #fbbf24; font-weight: 500; }
</style>
