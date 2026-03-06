const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const tor = require('../src/tor/main');
const wss = require('ws');
const net = require('net');

const isDev = process.env.NODE_ENV === 'development';

if (!isDev) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}

let mainWindow;
let mainWindowRestoreBounds = null;
let isLoggingActive = false;
let currentLogPath = '';

let wssServer = null;
let wssPort = null;

// IPC message batching
let ipcMessageQueue = [];
const ipcBatchSize = isDev ? 3000 : 1000;
const ipcBatchInterval = 100;
let isProcessingIpc = false;

// WebSocket message queue
let wssMessageQueue = [];
let isWaitingForBatchConfirm = false;
let pendingBatchId = null;
let pendingBatchCount = 0;
const wssBatchSize = isDev ? 3000 : 1000;
let wssFallbackTimer = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    backgroundColor: '#05070a',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    dialog.showErrorBox(
      'Failed to load',
      `Could not load the app UI.\n\nURL: ${validatedURL}\nError: ${errorDescription} (${errorCode})\n\nExpected file: ${path.join(__dirname, '../frontend/dist/index.html')}`
    );
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
  }

  mainWindowRestoreBounds = mainWindow.getBounds();

  mainWindow.on('maximize', () => {
    mainWindowRestoreBounds = mainWindow.getNormalBounds?.() ?? mainWindow.getBounds();
    mainWindow.webContents.send('window-maximize');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-unmaximize');
  });

  mainWindow.on('minimize', () => {
    mainWindow.webContents.send('window-minimize');
  });

  mainWindow.on('restore', () => {
    mainWindow.webContents.send('window-restore');
  });

  mainWindow.on('close', async (event) => {
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      title: 'Exit',
      type: 'question',
      message: 'Are you sure you want to exit TLI Tracker?',
      buttons: ['Exit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (result.response === 0) {
      try {
        mainWindow.webContents.send('window-close');
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        mainWindow.destroy();
      }
    }
  });

  // Block navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, newURL) => {
    const allowedHosts = ['localhost', '127.0.0.1'];
    try {
      const hostname = new URL(newURL).hostname;
      if (!allowedHosts.includes(hostname)) {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  });

  ipcMain.on('set-window-options', (event, options) => {
    const currentBounds = mainWindow.getBounds();
    mainWindow.setBounds({
      x: options.x ?? currentBounds.x,
      y: options.y ?? currentBounds.y,
      width: options.width,
      height: options.height,
    });
    if (options.autoHideMenuBar !== undefined) mainWindow.setAutoHideMenuBar(options.autoHideMenuBar);
    if (options.resizable !== undefined) mainWindow.setResizable(options.resizable);
    if (options.maximizable !== undefined) mainWindow.setMaximizable(options.maximizable);
    if (options.alwaysOnTop !== undefined) mainWindow.setAlwaysOnTop(options.alwaysOnTop, 'screen-saver');
  });

  ipcMain.on('set-mouse-ignore', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setIgnoreMouseEvents(ignore, options);
  });

  ipcMain.handle('get-window-bounds', () => mainWindow.getBounds());

  ipcMain.handle('get-back-version', () => ({ version: require('../package.json').version }));

  ipcMain.handle('force-reload', () => {
    mainWindow.webContents.reloadIgnoringCache();
    return { success: true };
  });

  ipcMain.handle('toggle-fullscreen', () => {
    const isFullscreen = mainWindow.isFullScreen();
    mainWindow.setFullScreen(!isFullscreen);
    return { isFullscreen: !isFullscreen };
  });

  ipcMain.handle('get-window-maximized', () => mainWindow.isMaximized());

  ipcMain.on('close-current-window', () => mainWindow.close());
  ipcMain.on('close-window', () => mainWindow.close());
  ipcMain.on('minimize-window', () => mainWindow.minimize());
  ipcMain.on('maximize-window', () => mainWindow.maximize());
  ipcMain.on('unmaximize-window', () => mainWindow.unmaximize());
  ipcMain.on('set-always-on-top', (event, flag) => mainWindow.setAlwaysOnTop(flag));

  ipcMain.handle('get-window-id', (event) => BrowserWindow.fromWebContents(event.sender)?.id);

  ipcMain.handle('get-os-info', () => ({
    platform: os.platform(),
    release: os.release(),
    hostname: os.hostname(),
  }));

  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select UE_game.log',
      filters: [{ name: 'Log Files', extensions: ['log'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('open-directory-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Torchlight Infinite folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('find-log-in-dir', async (event, dirPath) => {
    const fsSync = require('fs');
    const TARGET = 'UE_game.log';

    function search(dir, depth) {
      if (depth > 6) return null;
      let entries;
      try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return null; }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === TARGET) {
          return path.join(dir, entry.name);
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = search(path.join(dir, entry.name), depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    return search(dirPath, 0);
  });

  ipcMain.handle('run-shell-command', (event, cmd) => {
    return new Promise((resolve) => {
      exec(cmd, (err, stdout, stderr) => resolve({ err: err?.message, stdout, stderr }));
    });
  });

  ipcMain.handle('save-to-temp', async (event, data, filename) => {
    const tmpPath = path.join(os.tmpdir(), filename);
    await fs.writeFile(tmpPath, data, 'utf-8');
    return tmpPath;
  });

  app.on('browser-window-focus', () => mainWindow.webContents.send('app-focus'));
  app.on('browser-window-blur', () => mainWindow.webContents.send('app-blur'));
}

// ── WebSocket server ────────────────────────────────────────────────────────

function findAvailablePort(startPort, callback) {
  const server = net.createServer();
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') findAvailablePort(startPort + 1, callback);
    else callback(err);
  });
  server.once('listening', () => server.close(() => callback(null, startPort)));
  server.listen(startPort);
}

let wsClient = null;

function maybeNotifyCanReadMore() {
  try {
    if (typeof tor.notifyCanReadMore === 'function') tor.notifyCanReadMore();
  } catch (_) {}
}

function createWebSocketServer() {
  findAvailablePort(31099, (err, port) => {
    if (err) { console.error('No available port:', err); return; }
    wssPort = port;
    wssServer = new wss.Server({ port });

    wssServer.on('connection', (ws) => {
      wsClient = ws;

      if (ipcMessageQueue.length > 0) {
        wssMessageQueue = wssMessageQueue.concat(ipcMessageQueue);
        ipcMessageQueue = [];
      }

      isWaitingForBatchConfirm = false;
      pendingBatchId = null;
      pendingBatchCount = 0;
      processWssMessageQueue();

      if (isLoggingActive && tor.resetFlowControl) tor.resetFlowControl();

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'BATCH_PROCESSED' && isWaitingForBatchConfirm && message.batchId === pendingBatchId) {
            isWaitingForBatchConfirm = false;
            pendingBatchId = null;
            pendingBatchCount = 0;
            if (wssFallbackTimer) { clearTimeout(wssFallbackTimer); wssFallbackTimer = null; }
            if (wssMessageQueue.length < 1000) maybeNotifyCanReadMore();
            processWssMessageQueue();
          } else if (message.type === 'READY') {
            processWssMessageQueue();
          }
        } catch (_) {}
      });

      const handleDisconnect = () => {
        wsClient = null;
        isWaitingForBatchConfirm = false;
        if (wssMessageQueue.length > 0) {
          ipcMessageQueue = ipcMessageQueue.concat(wssMessageQueue);
          wssMessageQueue = [];
          processIpcMessageQueue();
        }
      };

      ws.on('close', handleDisconnect);
      ws.on('error', handleDisconnect);
    });
  });

  ipcMain.handle('get-wss-port', () => wssPort);
}

function processWssMessageQueue() {
  if (isWaitingForBatchConfirm || wssMessageQueue.length === 0 || !wsClient || wsClient.readyState !== wss.OPEN) return;

  isWaitingForBatchConfirm = true;
  const batch = wssMessageQueue.splice(0, wssBatchSize);
  if (batch.length === 0) { isWaitingForBatchConfirm = false; return; }

  const batchId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  pendingBatchId = batchId;
  pendingBatchCount = batch.length;

  wsClient.send(JSON.stringify({ type: 'BATCH', batchId, messages: batch, count: batch.length }));

  if (wssFallbackTimer) clearTimeout(wssFallbackTimer);
  wssFallbackTimer = setTimeout(() => {
    if (isWaitingForBatchConfirm && pendingBatchId === batchId) {
      isWaitingForBatchConfirm = false;
      pendingBatchId = null;
      pendingBatchCount = 0;
      if (wssMessageQueue.length < 1000) maybeNotifyCanReadMore();
      processWssMessageQueue();
    }
  }, 1000);
}

function processIpcMessageQueue() {
  if (isProcessingIpc || ipcMessageQueue.length === 0) return;
  isProcessingIpc = true;

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      ipcMessageQueue = [];
      isProcessingIpc = false;
      return;
    }
    try {
      const batch = ipcMessageQueue.splice(0, ipcBatchSize);
      if (batch.length > 0) {
        batch.forEach((msg) => mainWindow.webContents.send('tor-log-msg', msg));
      }
    } finally {
      isProcessingIpc = false;
      if (ipcMessageQueue.length > 0) processIpcMessageQueue();
      else maybeNotifyCanReadMore();
    }
  }, ipcBatchInterval);
}

function routeLogMessage(msg) {
  if (wsClient && wsClient.readyState === wss.OPEN) {
    wssMessageQueue.push(msg);
    processWssMessageQueue();
  } else {
    ipcMessageQueue.push(msg);
    if (!isProcessingIpc) processIpcMessageQueue();
  }
}

// ── App startup ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWebSocketServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  ipcMain.handle('start-tor-log', (event, options) => {
    const { logPath } = options;
    if (isLoggingActive && currentLogPath === logPath) return;
    if (isLoggingActive) tor.stopTorLog();
    currentLogPath = logPath;
    tor.mainWatch(logPath, routeLogMessage);
    isLoggingActive = true;
  });

  ipcMain.handle('stop-tor-log', () => {
    tor.stopTorLog();
    isLoggingActive = false;
    currentLogPath = '';
  });

  ipcMain.handle('get-tor-status', () => ({
    ...tor.getStatus(),
    isLoggingActive,
    currentLogPath,
  }));

  ipcMain.handle('open-window', async (event, options) => {
    const { url, ...winOpts } = options;
    const win = new BrowserWindow({
      ...winOpts,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    if (url) await win.loadURL(url);
    return win.id;
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
