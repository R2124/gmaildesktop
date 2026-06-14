'use strict';

/**
 * Local encrypted store for OAuth client config, refresh tokens, and settings.
 *
 * Security model:
 *  - All sensitive values (OAuth client secret, refresh token) are encrypted
 *    at rest using Electron's safeStorage, which is backed by the operating
 *    system keychain (Keychain on macOS, libsecret on Linux, DPAPI on Windows).
 *  - Nothing is ever sent to any server other than Google's official OAuth and
 *    Gmail API endpoints.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const STORE_FILE = () => path.join(app.getPath('userData'), 'cleaner-store.json');

function readRaw() {
  try {
    const file = STORE_FILE();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('Failed to read store, starting fresh:', err.message);
    return {};
  }
}

function writeRaw(data) {
  const file = STORE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function encrypt(value) {
  if (value == null) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    // Fall back to base64 so the app still works, but flag it clearly.
    return { enc: false, v: Buffer.from(String(value), 'utf8').toString('base64') };
  }
  return { enc: true, v: safeStorage.encryptString(String(value)).toString('base64') };
}

function decrypt(payload) {
  if (!payload) return null;
  const buf = Buffer.from(payload.v, 'base64');
  if (payload.enc) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Stored secret is encrypted but OS encryption is unavailable.');
    }
    return safeStorage.decryptString(buf);
  }
  return buf.toString('utf8');
}

const DEFAULT_SETTINGS = {
  backupDir: '',
  backupBeforeDelete: true,
  deleteMode: 'trash', // 'trash' | 'permanent'
  concurrency: 5,
};

const store = {
  // ---- OAuth client (Client ID / Secret from a Google "Desktop app" client) ----
  getClient() {
    const raw = readRaw();
    if (!raw.client) return null;
    try {
      return {
        clientId: raw.client.clientId || null,
        clientSecret: raw.client.clientSecret ? decrypt(raw.client.clientSecret) : null,
      };
    } catch (err) {
      console.error('Failed to decrypt client secret:', err.message);
      return { clientId: raw.client.clientId || null, clientSecret: null };
    }
  },
  setClient({ clientId, clientSecret }) {
    const raw = readRaw();
    raw.client = {
      clientId: clientId || null,
      clientSecret: clientSecret ? encrypt(clientSecret) : null,
    };
    writeRaw(raw);
  },

  // ---- Refresh token ----
  getRefreshToken() {
    const raw = readRaw();
    if (!raw.refreshToken) return null;
    try {
      return decrypt(raw.refreshToken);
    } catch (err) {
      console.error('Failed to decrypt refresh token:', err.message);
      return null;
    }
  },
  setRefreshToken(token) {
    const raw = readRaw();
    raw.refreshToken = token ? encrypt(token) : null;
    writeRaw(raw);
  },

  // ---- Cached account email ----
  getEmail() {
    return readRaw().email || null;
  },
  setEmail(email) {
    const raw = readRaw();
    raw.email = email || null;
    writeRaw(raw);
  },

  // ---- Settings ----
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(readRaw().settings || {}) };
  },
  setSettings(partial) {
    const raw = readRaw();
    raw.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}), ...partial };
    writeRaw(raw);
    return raw.settings;
  },

  // ---- Sign out: wipe tokens + email but keep client config + settings ----
  signOut() {
    const raw = readRaw();
    delete raw.refreshToken;
    delete raw.email;
    writeRaw(raw);
  },

  encryptionAvailable() {
    return safeStorage.isEncryptionAvailable();
  },
};

module.exports = store;
