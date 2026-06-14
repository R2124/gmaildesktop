# Gmail Desktop Cleaner

A **secure, local desktop application** (Electron) that finds old, unused, and
heavy Gmail messages, **downloads/backs up their full content** as `.eml` files,
and then deletes them — **trash** (recoverable) or **permanent** — to free up
storage in your Google account.

Everything runs on your own machine. There is **no server and no third party**.
Your OAuth credentials and tokens are encrypted at rest using your operating
system's keychain (macOS Keychain, Windows DPAPI, Linux libsecret) via Electron
`safeStorage`. The app talks only to Google's official OAuth and Gmail API
endpoints.

---

## Features

- 🔐 **Local & encrypted** — secrets stored only on your device, OS-keychain encrypted.
- 🔎 **Smart scanning** by age (`older_than`), size (`larger:`), category
  (Promotions/Social/Updates/Forums), read/unread, attachments, plus any custom
  Gmail search query.
- 🏷️ **Email identification** — every message is auto-classified with tags
  (`heavy`, `newsletter`, `unread`, `old`, `attachment`, category) and can be
  viewed grouped **by sender** for fast bulk decisions.
- 🧬 **Duplicate detection** — content fingerprinting (sender + normalized
  subject + size) finds duplicate/resent copies, keeps the newest (or oldest),
  and selects the rest for removal in one click.
- ☑️ **Bulk deletion** — select all, select per-sender, select all duplicates,
  or **Bulk delete ALL matches** to process the entire query result (thousands
  of messages) beyond the on-screen list.
- 💾 **Download before delete** — each message is saved as a complete `.eml`
  (headers + body + attachments), so nothing is lost.
- 🗑️ **Two delete modes** — *Move to Trash* (recoverable 30 days) or
  *Permanently delete* (frees space immediately via `messages.batchDelete`).
- 🧹 **Empty Trash** to reclaim space right away.
- 👀 **Dry run** and per-action confirmations; starred/important mail excluded by default.
- 📊 Live mailbox stats, duplicate count, and reclaimable-size estimate.

---

## 1. Prerequisites

- Node.js 18+ and npm.
- A Google account.

```bash
npm install
```

## 2. Create your own Google OAuth client (one time)

The app uses *your* OAuth client so you stay in full control.

1. Open the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create (or select) a project.
3. **APIs & Services → Library →** enable the **Gmail API**.
4. **APIs & Services → OAuth consent screen:**
   - User type: **External**.
   - Add your own Gmail address under **Test users**.
   - Scope used by this app: `https://mail.google.com/` (full mailbox — required
     to read raw content for backup and to permanently delete).
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID:**
   - Application type: **Desktop app**.
   - Copy the **Client ID** and **Client Secret**.

> No redirect URI configuration is needed — desktop clients use the
> loopback (`http://127.0.0.1:<random-port>`) flow automatically.

## 3. Run

```bash
npm start
```

1. Paste your **Client ID** and **Client Secret** in the Setup screen → *Save credentials*.
2. Click **Sign in with Google** — your browser opens; approve access.
   (On the "unverified app" screen, choose **Continue** since you are the developer/test user.)
3. Choose a **backup folder**.
4. Set filters → **Scan** → review candidates → **Download & Delete selected**.

## 4. Package a standalone app (optional)

```bash
npm run dist     # builds an installer for your OS into release/
```

Produces a `.dmg` (macOS), `.exe`/NSIS (Windows), or `.AppImage` (Linux).

---

## How it works

```
src/
├── main/
│   ├── main.js     Electron entry, window, IPC routing
│   ├── auth.js     OAuth2 loopback sign-in + token refresh
│   ├── gmail.js    scan / backup (.eml) / trash / batchDelete / bulk / empty trash
│   └── store.js    safeStorage-encrypted local store (client, token, settings)
├── shared/
│   └── analyze.js  dependency-free identification / dedup / grouping logic
│                   (used by both main process and UI — single source of truth)
├── preload/
│   └── preload.js  contextBridge: the only API surface exposed to the UI
└── renderer/       sandboxed UI (no Node access)
    ├── index.html  (strict CSP)
    ├── styles.css
    └── renderer.js
```

Deletion is two-phase and safe by construction:
1. **Back up** every selected message to a `.eml` file. Only messages that were
   successfully downloaded proceed to step 2 (if backup is enabled).
2. **Delete** — `messages.trash` per message, or `messages.batchDelete` in
   chunks of 1000 for permanent removal.

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP.
- The renderer can only invoke the explicit channels in `preload.js`.
- Client secret and refresh token are encrypted with the OS keychain. If the
  keychain is unavailable, the app warns you and falls back to weak obfuscation.
- Tokens never leave your machine except in direct TLS calls to Google.
- Sign out revokes the refresh token with Google and wipes it locally.
- `.gitignore` prevents committing any local secrets, tokens, or backups.

## Safety / caveats

- **Permanent delete cannot be undone.** Keep backup enabled and verify the
  `.eml` files before emptying Trash. Start with *Dry run* and *Move to Trash*.
- Gmail storage usage can take a few minutes to update after deletion.
- Scans are capped at 1000 messages per run for responsiveness; run repeatedly
  to clear large mailboxes.
- Starred and Important mail are excluded unless you opt in.

## License

MIT
