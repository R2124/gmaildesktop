'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const Analyze = require('../shared/analyze');

/**
 * Minimal, explicit bridge. The renderer can only call these named channels —
 * it has no direct access to Node, the filesystem, or ipcRenderer internals.
 */
contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('app:status'),
  setClient: (cfg) => ipcRenderer.invoke('client:set', cfg),
  signIn: () => ipcRenderer.invoke('auth:signIn'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  chooseBackupDir: () => ipcRenderer.invoke('dialog:chooseBackupDir'),
  profile: () => ipcRenderer.invoke('gmail:profile'),
  scan: (filters, opts) => ipcRenderer.invoke('gmail:scan', filters, opts),
  process: (ids, options) => ipcRenderer.invoke('gmail:process', ids, options),
  bulkProcess: (filters, options) => ipcRenderer.invoke('gmail:bulkProcess', filters, options),
  deepDupScan: (options) => ipcRenderer.invoke('gmail:deepDupScan', options),
  emptyTrash: () => ipcRenderer.invoke('gmail:emptyTrash'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // Pure, in-process analysis helpers (no network) shared with the main process.
  analyze: {
    findDuplicates: (messages, opts) => Analyze.findDuplicates(messages, opts),
    groupBySender: (messages) => Analyze.groupBySender(messages),
    parseFrom: (from) => Analyze.parseFrom(from),
  },

  onScanProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('progress:scan', h);
    return () => ipcRenderer.removeListener('progress:scan', h);
  },
  onProcessProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('progress:process', h);
    return () => ipcRenderer.removeListener('progress:process', h);
  },
});
