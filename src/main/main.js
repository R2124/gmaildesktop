'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const store = require('./store');
const auth = require('./auth');
const gmail = require('./gmail');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0b0f14',
    title: 'Gmail Desktop Cleaner',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open any external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ----------------------------- IPC handlers ----------------------------- */

function wrap(handler) {
  return async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      console.error('IPC error:', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

ipcMain.handle('app:status', wrap(async () => {
  const client = store.getClient();
  return {
    encryptionAvailable: store.encryptionAvailable(),
    clientConfigured: !!(client && client.clientId && client.clientSecret),
    signedIn: !!store.getRefreshToken(),
    email: store.getEmail(),
    settings: store.getSettings(),
  };
}));

ipcMain.handle('client:set', wrap(async ({ clientId, clientSecret }) => {
  if (!clientId || !clientSecret) throw new Error('Both Client ID and Client Secret are required.');
  store.setClient({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  return true;
}));

ipcMain.handle('auth:signIn', wrap(async () => {
  return auth.signIn();
}));

ipcMain.handle('auth:signOut', wrap(async () => {
  await auth.signOut();
  return true;
}));

ipcMain.handle('settings:get', wrap(async () => store.getSettings()));
ipcMain.handle('settings:set', wrap(async (partial) => store.setSettings(partial)));

ipcMain.handle('dialog:chooseBackupDir', wrap(async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose backup folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  store.setSettings({ backupDir: res.filePaths[0] });
  return res.filePaths[0];
}));

ipcMain.handle('gmail:profile', wrap(async () => gmail.getProfile()));

ipcMain.handle('gmail:scan', wrap(async (filters, opts) => {
  return gmail.scan(filters, {
    maxResults: (opts && opts.maxResults) || 1000,
    onProgress: (p) => send('progress:scan', p),
  });
}));

ipcMain.handle('gmail:process', wrap(async (messageIds, options) => {
  const settings = store.getSettings();
  const merged = {
    backup: options.backup ?? settings.backupBeforeDelete,
    backupDir: options.backupDir || settings.backupDir,
    deleteMode: options.deleteMode || settings.deleteMode,
    concurrency: settings.concurrency,
    dryRun: !!options.dryRun,
  };
  return gmail.processMessages(messageIds, merged, (p) => send('progress:process', p));
}));

ipcMain.handle('gmail:bulkProcess', wrap(async (filters, options) => {
  const settings = store.getSettings();
  const merged = {
    backup: options.backup ?? settings.backupBeforeDelete,
    backupDir: options.backupDir || settings.backupDir,
    deleteMode: options.deleteMode || settings.deleteMode,
    concurrency: settings.concurrency,
    dryRun: !!options.dryRun,
  };
  return gmail.bulkProcessByQuery(filters, merged, (p) => send('progress:process', p));
}));

ipcMain.handle('gmail:emptyTrash', wrap(async () => {
  return gmail.emptyTrash((p) => send('progress:process', p));
}));

ipcMain.handle('shell:openPath', wrap(async (p) => {
  if (p) await shell.openPath(p);
  return true;
}));
