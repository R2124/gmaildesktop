'use strict';

/* global window, document */
const api = window.api;
const $ = (id) => document.getElementById(id);

const state = {
  messages: [],
  byId: new Map(),
  selected: new Set(),
  duplicates: { groups: [], duplicateIds: [], reclaimBytes: 0, totalDuplicates: 0 },
  dupSet: new Set(),
  senderGroups: [],
  view: 'messages',
  dupKeep: 'newest',
  settings: {},
};

/* ----------------------------- helpers ----------------------------- */
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4000);
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ----------------------------- filters ----------------------------- */
function readFilters() {
  const cats = Array.from(document.querySelectorAll('.cat:checked')).map((c) => c.value);
  return {
    olderThan: $('f-olderThan').value || null,
    largerThanMB: $('f-largerThan').value ? Number($('f-largerThan').value) : null,
    categories: cats,
    unreadOnly: $('f-unread').checked,
    hasAttachment: $('f-attach').checked,
    includeStarred: $('f-incStarred').checked,
    includeImportant: $('f-incImportant').checked,
    customQuery: $('f-custom').value || null,
  };
}

function deleteOptions() {
  return {
    backup: $('opt-backup').checked,
    deleteMode: $('opt-deleteMode').value,
    backupDir: $('backup-dir').value,
  };
}

/* ----------------------------- tags ----------------------------- */
function tagsHtml(m) {
  const tags = (m.tags || []).slice();
  if (state.dupSet.has(m.id)) tags.unshift('duplicate');
  if (!tags.length) return '';
  return `<div class="tags">${tags.map((t) => `<span class="tag ${t}">${t}</span>`).join('')}</div>`;
}

/* ----------------------------- rendering ----------------------------- */
function itemRow(m, { keeper = false } = {}) {
  const checkbox = keeper
    ? `<span class="tag" title="kept">KEEP</span>`
    : `<input type="checkbox" data-id="${m.id}" ${state.selected.has(m.id) ? 'checked' : ''} />`;
  return `
    <label class="item">
      ${checkbox}
      <div class="meta">
        <div class="subject">${escapeHtml(m.subject)}</div>
        <div class="from">${escapeHtml(m.from)} · ${escapeHtml(m.date)}</div>
        ${tagsHtml(m)}
      </div>
      <div class="size">${fmtBytes(m.sizeEstimate)}</div>
    </label>`;
}

function renderMessageList() {
  const list = $('results-list');
  if (!state.messages.length) {
    list.innerHTML = '<div class="empty">No matching emails found. Adjust the filters and scan again.</div>';
    return;
  }
  list.innerHTML = state.messages.map((m) => itemRow(m)).join('');
}

function renderDuplicateView() {
  const list = $('results-list');
  const groups = state.duplicates.groups;
  if (!groups.length) {
    list.innerHTML = '<div class="empty">No duplicates found in the scanned set.</div>';
    return;
  }
  list.innerHTML = groups.map((g) => {
    const allSel = g.duplicateIds.every((id) => state.selected.has(id));
    const rows = g.messages.map((m) => itemRow(m, { keeper: m.id === g.keepId })).join('');
    return `
      <div class="group-head">
        <input type="checkbox" data-group='${JSON.stringify(g.duplicateIds)}' ${allSel ? 'checked' : ''} />
        <span>${escapeHtml(g.sender)} — ${escapeHtml(g.subject)} <span class="count">(${g.count} copies, ${g.duplicateIds.length} removable)</span></span>
        <span class="size">${fmtBytes(g.size)}</span>
      </div>
      ${rows}`;
  }).join('');
}

function renderSenderView() {
  const list = $('results-list');
  if (!state.senderGroups.length) {
    list.innerHTML = '<div class="empty">No senders to group.</div>';
    return;
  }
  list.innerHTML = state.senderGroups.map((g) => {
    const allSel = g.ids.every((id) => state.selected.has(id));
    const rows = g.ids.map((id) => itemRow(state.byId.get(id))).join('');
    return `
      <div class="group-head">
        <input type="checkbox" data-group='${JSON.stringify(g.ids)}' ${allSel ? 'checked' : ''} />
        <span>${escapeHtml(g.sender)} <span class="count">(${g.count} emails)</span></span>
        <span class="size">${fmtBytes(g.bytes)}</span>
      </div>
      ${rows}`;
  }).join('');
}

function renderResults() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  $('dup-keep-wrap').hidden = state.view !== 'duplicates';
  if (state.view === 'duplicates') renderDuplicateView();
  else if (state.view === 'senders') renderSenderView();
  else renderMessageList();
  updateSelectionStats();
}

function updateSelectionStats() {
  const sel = state.messages.filter((m) => state.selected.has(m.id));
  const bytes = sel.reduce((a, m) => a + m.sizeEstimate, 0);
  $('stat-selected').textContent = sel.length;
  $('stat-reclaim').textContent = fmtBytes(bytes);
  $('stat-duplicates').textContent = state.duplicates.totalDuplicates;
  $('tab-dup-count').textContent = state.duplicates.totalDuplicates;
  $('btn-run').disabled = sel.length === 0;
  $('select-all').checked = state.messages.length > 0 && sel.length === state.messages.length;
}

function recomputeAnalysis() {
  state.byId = new Map(state.messages.map((m) => [m.id, m]));
  state.duplicates = api.analyze.findDuplicates(state.messages, { keep: state.dupKeep });
  state.dupSet = new Set(state.duplicates.duplicateIds);
  state.senderGroups = api.analyze.groupBySender(state.messages);
}

/* ----------------------------- overlay ----------------------------- */
function showOverlay(title) {
  $('overlay-title').textContent = title;
  $('overlay-status').textContent = '';
  $('overlay-log').textContent = '';
  $('overlay-bar').style.width = '0%';
  $('overlay-close').hidden = true;
  $('overlay').hidden = false;
}
function setOverlayProgress(pct, status) {
  $('overlay-bar').style.width = `${Math.min(100, pct)}%`;
  if (status) $('overlay-status').textContent = status;
}
function logOverlay(line) {
  const el = $('overlay-log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
function finishOverlay() {
  $('overlay-close').hidden = false;
  setOverlayProgress(100);
}

/* ----------------------------- actions ----------------------------- */
async function scan() {
  const filters = readFilters();
  showOverlay('Scanning mailbox…');
  try {
    const res = await api.scan(filters, { maxResults: 1000 });
    if (!res.ok) throw new Error(res.error);
    state.messages = res.data.messages;
    state.selected = new Set(state.messages.map((m) => m.id)); // pre-select all matches
    recomputeAnalysis();
    $('query-preview').textContent = res.data.query ? `q: ${res.data.query}` : '';
    $('results-summary').textContent =
      `${res.data.count} shown · ${fmtBytes(res.data.totalBytes)}` +
      (res.data.truncated ? ` (of ${res.data.totalMatched}, capped at 1000 — use Bulk delete for the rest)` : '') +
      ` · ${res.data.duplicateCount} duplicates`;
    renderResults();
    $('overlay').hidden = true;
    toast(`Found ${res.data.count} emails, ${res.data.duplicateCount} duplicates`, 'success');
  } catch (err) {
    logOverlay('Error: ' + err.message);
    finishOverlay();
    toast(err.message, 'error');
  }
}

function confirmDelete(count, scope) {
  const { backup, deleteMode, backupDir } = deleteOptions();
  if (backup && !backupDir) { toast('Choose a backup folder first (or turn off backup).', 'error'); return null; }
  const verb = deleteMode === 'permanent' ? 'PERMANENTLY DELETE' : 'move to Trash';
  const ok = window.confirm(
    `About to ${verb} ${count} email(s)${scope}.` +
    (backup ? `\nThey will be downloaded to:\n${backupDir}\nfirst.` : '\n\nBackup is OFF — content cannot be recovered if permanent.') +
    '\n\nContinue?'
  );
  return ok ? { backup, deleteMode, backupDir } : null;
}

async function runDelete(dryRun) {
  const ids = state.messages.filter((m) => state.selected.has(m.id)).map((m) => m.id);
  if (!ids.length) return;
  let opts;
  if (dryRun) {
    opts = deleteOptions();
  } else {
    opts = confirmDelete(ids.length, ' (selected)');
    if (!opts) return;
  }

  showOverlay(dryRun ? 'Dry run (no changes)…' : 'Downloading & deleting…');
  try {
    const res = await api.process(ids, { ...opts, dryRun });
    if (!res.ok) throw new Error(res.error);
    reportResult(res.data, dryRun, opts);
    if (!dryRun) {
      state.messages = state.messages.filter((m) => !state.selected.has(m.id));
      state.selected.clear();
      recomputeAnalysis();
      renderResults();
      await refreshProfile();
    }
    finishOverlay();
  } catch (err) {
    logOverlay('Error: ' + err.message);
    finishOverlay();
    toast(err.message, 'error');
  }
}

async function bulkDeleteAll() {
  const filters = readFilters();
  const opts = confirmDelete('ALL', ' matching the current filters (this can be thousands and is not limited to the list shown)');
  if (!opts) return;
  showOverlay('Bulk: listing every match…');
  try {
    const res = await api.bulkProcess(filters, opts);
    if (!res.ok) throw new Error(res.error);
    logOverlay(`Matched ${res.data.matched} messages.`);
    reportResult(res.data, false, opts);
    finishOverlay();
    // Refresh the on-screen scan to reflect deletions.
    await refreshProfile();
    state.messages = [];
    state.selected.clear();
    recomputeAnalysis();
    renderResults();
    toast(`Bulk done — deleted ${res.data.deleted}`, 'success');
  } catch (err) {
    logOverlay('Error: ' + err.message);
    finishOverlay();
    toast(err.message, 'error');
  }
}

function reportResult(r, dryRun, opts) {
  if (dryRun) {
    logOverlay(`Dry run: ${r.total} emails would be processed.`);
    logOverlay(`Backup: ${opts.backup ? 'yes → ' + opts.backupDir : 'no'}`);
    logOverlay(`Delete mode: ${opts.deleteMode}`);
    return;
  }
  logOverlay(`Backed up: ${r.backedUp} (${fmtBytes(r.backedUpBytes)})`);
  logOverlay(`Deleted:   ${r.deleted}`);
  if (r.failed) logOverlay(`Failed:    ${r.failed}`);
  (r.errors || []).slice(0, 10).forEach((e) => logOverlay(`  ! ${e.stage}: ${e.message}`));
  if (!dryRun) toast(`Done — deleted ${r.deleted}, backed up ${r.backedUp}`, 'success');
}

async function emptyTrash() {
  if (!window.confirm('Permanently delete EVERYTHING in Trash? This frees space immediately and cannot be undone.')) return;
  showOverlay('Emptying Trash…');
  try {
    const res = await api.emptyTrash();
    if (!res.ok) throw new Error(res.error);
    logOverlay(`Permanently removed ${res.data.deleted} messages from Trash.`);
    finishOverlay();
    await refreshProfile();
    toast(`Trash emptied (${res.data.deleted} messages)`, 'success');
  } catch (err) {
    logOverlay('Error: ' + err.message);
    finishOverlay();
    toast(err.message, 'error');
  }
}

/* ----------------------------- account / boot ----------------------------- */
async function refreshProfile() {
  const res = await api.profile();
  if (res.ok) {
    $('stat-messages').textContent = (res.data.messagesTotal ?? 0).toLocaleString();
    $('stat-threads').textContent = (res.data.threadsTotal ?? 0).toLocaleString();
  }
}

async function boot() {
  const res = await api.status();
  if (!res.ok) { toast(res.error, 'error'); return; }
  const s = res.data;
  state.settings = s.settings;

  $('enc-warning').hidden = s.encryptionAvailable;
  $('backup-dir').value = s.settings.backupDir || '';
  $('opt-deleteMode').value = s.settings.deleteMode || 'trash';
  $('opt-backup').checked = s.settings.backupBeforeDelete !== false;

  if (s.signedIn) {
    $('account-email').textContent = s.email || 'Signed in';
    $('btn-signout').hidden = false;
    $('setup').hidden = true;
    $('workspace').hidden = false;
    await refreshProfile();
  } else {
    $('setup').hidden = false;
    $('workspace').hidden = true;
    if (s.clientConfigured) {
      $('btn-signin').disabled = false;
      $('client-id').placeholder = '•••• already saved ••••';
    }
  }
}

/* ----------------------------- wiring ----------------------------- */
function wire() {
  $('btn-save-client').addEventListener('click', async () => {
    const clientId = $('client-id').value.trim();
    const clientSecret = $('client-secret').value.trim();
    if (!clientId || !clientSecret) { toast('Enter both Client ID and Secret', 'error'); return; }
    const res = await api.setClient({ clientId, clientSecret });
    if (res.ok) { $('btn-signin').disabled = false; toast('Credentials saved (encrypted)', 'success'); }
    else toast(res.error, 'error');
  });

  $('btn-signin').addEventListener('click', async () => {
    toast('Opening your browser to sign in…');
    const res = await api.signIn();
    if (res.ok) { toast('Signed in as ' + res.data.email, 'success'); await boot(); }
    else toast(res.error, 'error');
  });

  $('btn-signout').addEventListener('click', async () => {
    await api.signOut();
    location.reload();
  });

  $('btn-scan').addEventListener('click', scan);
  $('btn-bulk').addEventListener('click', bulkDeleteAll);
  $('btn-run').addEventListener('click', () => runDelete(false));
  $('btn-dryrun').addEventListener('click', () => runDelete(true));
  $('btn-empty-trash').addEventListener('click', emptyTrash);

  // View tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => { state.view = tab.dataset.view; renderResults(); });
  });

  // Duplicate keep mode
  $('dup-keep').addEventListener('change', () => {
    state.dupKeep = $('dup-keep').value;
    recomputeAnalysis();
    renderResults();
  });

  $('btn-select-dups').addEventListener('click', () => {
    state.duplicates.duplicateIds.forEach((id) => state.selected.add(id));
    renderResults();
    toast(`Selected ${state.duplicates.duplicateIds.length} duplicates`, 'success');
  });

  $('select-all').addEventListener('change', (e) => {
    if (e.target.checked) state.selected = new Set(state.messages.map((m) => m.id));
    else state.selected.clear();
    renderResults();
  });

  // Delegated selection handling for items and group headers.
  $('results-list').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.id) {
      if (t.checked) state.selected.add(t.dataset.id);
      else state.selected.delete(t.dataset.id);
      updateSelectionStats();
    } else if (t.dataset && t.dataset.group) {
      const ids = JSON.parse(t.dataset.group);
      if (t.checked) ids.forEach((id) => state.selected.add(id));
      else ids.forEach((id) => state.selected.delete(id));
      renderResults();
    }
  });

  $('btn-choose-dir').addEventListener('click', async () => {
    const res = await api.chooseBackupDir();
    if (res.ok && res.data) { $('backup-dir').value = res.data; toast('Backup folder set', 'success'); }
  });

  $('opt-deleteMode').addEventListener('change', () => api.setSettings({ deleteMode: $('opt-deleteMode').value }));
  $('opt-backup').addEventListener('change', () => api.setSettings({ backupBeforeDelete: $('opt-backup').checked }));

  // Progress events
  api.onScanProgress((p) => {
    if (p.phase === 'listing') setOverlayProgress(20, `Listing… found ${p.found}`);
    else if (p.phase === 'metadata') setOverlayProgress(20 + (p.processed / p.total) * 80, `Reading details ${p.processed}/${p.total}`);
  });
  api.onProcessProgress((p) => {
    if (p.phase === 'listing') setOverlayProgress(10, `Listing matches… ${p.found}`);
    else if (p.phase === 'backup') { setOverlayProgress((p.processed / p.total) * 50, `Backing up ${p.processed}/${p.total}`); if (p.processed % 20 === 0) logOverlay(`backed up ${p.processed}/${p.total}`); }
    else if (p.phase === 'delete') setOverlayProgress(50 + (p.processed / p.total) * 50, `Deleting ${p.processed}/${p.total}`);
    else if (p.phase === 'empty-trash') setOverlayProgress(50, `Removed ${p.deleted}`);
  });

  $('overlay-close').addEventListener('click', () => { $('overlay').hidden = true; });
}

window.addEventListener('DOMContentLoaded', () => {
  wire();
  boot();
});
