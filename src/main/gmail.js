'use strict';

/**
 * Gmail operations: scanning for cleanup candidates, backing up message content
 * to local .eml files, and deleting (trash or permanent) to reclaim storage.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./auth');
const Analyze = require('../shared/analyze');

function gmailClient() {
  const auth = getAuthorizedClient();
  if (!auth) throw new Error('Not signed in.');
  return google.gmail({ version: 'v1', auth });
}

/** Build a Gmail search query string from structured filters. */
function buildQuery(filters = {}) {
  const parts = [];
  if (filters.olderThan) parts.push(`older_than:${filters.olderThan}`); // e.g. 1y, 6m, 90d
  if (filters.newerThan) parts.push(`newer_than:${filters.newerThan}`);
  if (filters.largerThanMB) parts.push(`larger:${filters.largerThanMB}M`);
  if (filters.hasAttachment) parts.push('has:attachment');
  if (filters.unreadOnly) parts.push('is:unread');

  if (Array.isArray(filters.categories) && filters.categories.length) {
    const cats = filters.categories.map((c) => `category:${c}`);
    parts.push(cats.length === 1 ? cats[0] : `{${cats.join(' ')}}`);
  }
  // By default we never touch starred or important mail unless explicitly allowed.
  if (!filters.includeStarred) parts.push('-is:starred');
  if (!filters.includeImportant) parts.push('-is:important');

  if (filters.customQuery && filters.customQuery.trim()) {
    parts.push(`(${filters.customQuery.trim()})`);
  }
  return parts.join(' ').trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run an async fn with retry/backoff on rate-limit (429) / 5xx errors. */
async function withRetry(fn, { tries = 5 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || (err.response && err.response.status);
      const retryable = code === 429 || code === 403 || (code >= 500 && code < 600);
      lastErr = err;
      if (!retryable || i === tries - 1) throw err;
      await sleep(Math.min(16000, 1000 * 2 ** i) + Math.random() * 250);
    }
  }
  throw lastErr;
}

/** Header lookup helper. */
function header(payload, name) {
  if (!payload || !payload.headers) return '';
  const h = payload.headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** List every message ID matching a query, paginating with no cap. */
async function listAllIds(gmail, q, { cap = Infinity, onProgress } = {}) {
  const ids = [];
  let pageToken;
  do {
    const res = await withRetry(() =>
      gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken })
    );
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
    if (onProgress) onProgress({ phase: 'listing', found: ids.length });
    if (ids.length >= cap) break;
  } while (pageToken);
  return ids;
}

/**
 * Scan for candidate messages. Returns a capped list of enriched message
 * summaries (with classification tags) plus an estimate of total reclaimable
 * size. `onProgress` reports progress.
 */
async function scan(filters, { maxResults = 1000, onProgress } = {}) {
  const gmail = gmailClient();
  const q = buildQuery(filters);

  // 1) Collect message IDs (paginated).
  const ids = await listAllIds(gmail, q, { cap: maxResults, onProgress });
  const limited = ids.slice(0, maxResults);

  // 2) Fetch lightweight metadata (incl. sizeEstimate) for each, then classify.
  const messages = [];
  let totalBytes = 0;
  let processed = 0;
  const concurrency = 10;

  async function worker(queue) {
    while (queue.length) {
      const id = queue.pop();
      const res = await withRetry(() =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID', 'List-Unsubscribe', 'Content-Type'],
        })
      );
      const d = res.data;
      const size = d.sizeEstimate || 0;
      totalBytes += size;
      const contentType = header(d.payload, 'Content-Type');
      const msg = {
        id: d.id,
        threadId: d.threadId,
        sizeEstimate: size,
        snippet: d.snippet || '',
        from: header(d.payload, 'From'),
        subject: header(d.payload, 'Subject') || '(no subject)',
        date: header(d.payload, 'Date'),
        internalDate: d.internalDate || null,
        messageId: header(d.payload, 'Message-ID'),
        listUnsubscribe: !!header(d.payload, 'List-Unsubscribe'),
        hasAttachment: /multipart\/mixed/i.test(contentType),
        labelIds: d.labelIds || [],
      };
      msg.tags = Analyze.classify(msg);
      messages.push(msg);
      processed++;
      if (onProgress && processed % 25 === 0) {
        onProgress({ phase: 'metadata', processed, total: limited.length });
      }
    }
  }

  const queue = limited.slice();
  await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));

  messages.sort((a, b) => b.sizeEstimate - a.sizeEstimate);

  // Duplicate analysis over the scanned set.
  const dup = Analyze.findDuplicates(messages, { keep: 'newest' });

  return {
    query: q,
    count: messages.length,
    totalMatched: ids.length,
    truncated: ids.length > limited.length,
    totalBytes,
    duplicateCount: dup.totalDuplicates,
    duplicateBytes: dup.reclaimBytes,
    messages,
  };
}

function safeName(s, max = 80) {
  return (s || '')
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'message';
}

/**
 * Download a single message as a raw .eml file (includes headers, body, and all
 * attachments — a complete, re-importable backup of the message content).
 */
async function backupMessage(gmail, id, backupDir) {
  const res = await withRetry(() =>
    gmail.users.messages.get({ userId: 'me', id, format: 'raw' })
  );
  const raw = res.data.raw;
  if (!raw) throw new Error('No raw content returned for message ' + id);
  const buf = Buffer.from(raw, 'base64url');

  // Derive a friendly filename from metadata we can parse cheaply.
  const subjMatch = buf.toString('latin1').match(/^subject:\s*(.*)$/im);
  const subject = subjMatch ? subjMatch[1] : '';
  const fileName = `${id}__${safeName(subject)}.eml`;
  const full = path.join(backupDir, fileName);
  await fs.promises.writeFile(full, buf);
  return { path: full, bytes: buf.length };
}

/**
 * Process a set of message IDs: optionally back them up, then delete.
 *
 * options: { backup: bool, backupDir: string, deleteMode: 'trash'|'permanent',
 *            concurrency: number, dryRun: bool }
 * onProgress({ phase, processed, total, lastSubject, error })
 */
async function processMessages(messageIds, options, onProgress = () => {}) {
  const gmail = gmailClient();
  const {
    backup = true,
    backupDir,
    deleteMode = 'trash',
    concurrency = 5,
    dryRun = false,
  } = options;

  const total = messageIds.length;
  const result = {
    total,
    backedUp: 0,
    backedUpBytes: 0,
    deleted: 0,
    failed: 0,
    errors: [],
    dryRun,
  };

  if (dryRun) {
    onProgress({ phase: 'dry-run', processed: total, total });
    return result;
  }

  if (backup) {
    if (!backupDir) throw new Error('Backup is enabled but no backup folder is set.');
    await fs.promises.mkdir(backupDir, { recursive: true });
  }

  // --- Phase 1: back up (download) content, so nothing is lost. ---
  const deletable = [];
  if (backup) {
    let processed = 0;
    const queue = messageIds.slice();
    async function backupWorker() {
      while (queue.length) {
        const id = queue.shift();
        try {
          const { bytes } = await backupMessage(gmail, id, backupDir);
          result.backedUp++;
          result.backedUpBytes += bytes;
          deletable.push(id);
        } catch (err) {
          result.failed++;
          result.errors.push({ id, stage: 'backup', message: err.message });
        }
        processed++;
        onProgress({ phase: 'backup', processed, total });
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, backupWorker));
  } else {
    deletable.push(...messageIds);
  }

  // --- Phase 2: delete (only messages that were safely handled). ---
  if (!deletable.length) return result;

  if (deleteMode === 'permanent') {
    // batchDelete is the most efficient way to permanently remove + free space.
    for (let i = 0; i < deletable.length; i += 1000) {
      const chunk = deletable.slice(i, i + 1000);
      try {
        await withRetry(() =>
          gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: chunk } })
        );
        result.deleted += chunk.length;
      } catch (err) {
        result.failed += chunk.length;
        result.errors.push({ stage: 'delete', message: err.message });
      }
      onProgress({ phase: 'delete', processed: Math.min(i + 1000, deletable.length), total: deletable.length });
    }
  } else {
    // Move to Trash (reclaimed automatically after 30 days, or empty trash later).
    let processed = 0;
    const queue = deletable.slice();
    async function trashWorker() {
      while (queue.length) {
        const id = queue.shift();
        try {
          await withRetry(() => gmail.users.messages.trash({ userId: 'me', id }));
          result.deleted++;
        } catch (err) {
          result.failed++;
          result.errors.push({ id, stage: 'trash', message: err.message });
        }
        processed++;
        onProgress({ phase: 'delete', processed, total: deletable.length });
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, trashWorker));
  }

  return result;
}

/**
 * Bulk path: process EVERY message matching a query, beyond the on-screen cap.
 * Lists all matching IDs first, reports the count, then backs up + deletes.
 */
async function bulkProcessByQuery(filters, options, onProgress = () => {}) {
  const gmail = gmailClient();
  const q = buildQuery(filters);
  const ids = await listAllIds(gmail, q, { onProgress });
  onProgress({ phase: 'listing', found: ids.length, done: true });
  const result = await processMessages(ids, options, onProgress);
  result.matched = ids.length;
  result.query = q;
  return result;
}

/** Permanently empty the Trash to immediately free the space it occupies. */
async function emptyTrash(onProgress = () => {}) {
  const gmail = gmailClient();
  let deleted = 0;
  let pageToken;
  do {
    const res = await withRetry(() =>
      gmail.users.messages.list({ userId: 'me', q: 'in:trash', maxResults: 500, pageToken })
    );
    const ids = (res.data.messages || []).map((m) => m.id);
    pageToken = res.data.nextPageToken;
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      await withRetry(() =>
        gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: chunk } })
      );
      deleted += chunk.length;
      onProgress({ phase: 'empty-trash', deleted });
    }
  } while (pageToken);
  return { deleted };
}

/** Mailbox storage / message stats for the dashboard. */
async function getProfile() {
  const gmail = gmailClient();
  const res = await withRetry(() => gmail.users.getProfile({ userId: 'me' }));
  return {
    email: res.data.emailAddress,
    messagesTotal: res.data.messagesTotal,
    threadsTotal: res.data.threadsTotal,
  };
}

module.exports = {
  buildQuery,
  scan,
  processMessages,
  bulkProcessByQuery,
  emptyTrash,
  getProfile,
};
