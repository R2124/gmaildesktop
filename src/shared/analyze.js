'use strict';

/**
 * Shared, dependency-free analysis logic used by BOTH the Electron main process
 * (via require) and the sandboxed renderer (via <script> -> window.Analyze).
 *
 * Responsibilities:
 *   - email identification / classification (tags)
 *   - sender parsing & grouping (for bulk-by-sender actions)
 *   - duplicate detection via content fingerprinting
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Analyze = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HEAVY_BYTES = 5 * 1024 * 1024; // 5 MB
  const OLD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

  /** Parse a raw "From" header into { name, email, domain }. */
  function parseFrom(from) {
    const raw = String(from || '');
    let email = '';
    const angle = raw.match(/<([^<>]+@[^<>]+)>/);
    if (angle) {
      email = angle[1].trim();
    } else {
      const bare = raw.match(/[^\s<>"]+@[^\s<>"]+/);
      if (bare) email = bare[0].trim();
    }
    email = email.toLowerCase();
    let name = raw.replace(/<[^<>]*>/, '').replace(/["']/g, '').trim();
    if (!name) name = email;
    const domain = email.includes('@') ? email.split('@')[1] : '';
    return { name, email, domain };
  }

  /** Normalize a subject for grouping (strip Re:/Fwd:, collapse whitespace). */
  function normSubject(subject) {
    return String(subject || '')
      .replace(/^\s*(re|fwd?|fw)\s*:\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Content fingerprint for duplicate detection. Two messages with the same
   * sender, the same normalized subject, and the same byte size are treated as
   * duplicates. This catches both exact resends and copies stored under
   * multiple labels, without flagging unrelated mail.
   */
  function fingerprint(msg) {
    const { email } = parseFrom(msg.from);
    return [email, normSubject(msg.subject), msg.sizeEstimate || 0].join('|');
  }

  /** Classify a message into human-meaningful tags. */
  function classify(msg) {
    const tags = [];
    const size = msg.sizeEstimate || 0;
    const labels = msg.labelIds || [];

    if (size >= HEAVY_BYTES) tags.push('heavy');
    if (msg.hasAttachment) tags.push('attachment');
    if (msg.listUnsubscribe) tags.push('newsletter');
    if (labels.includes('UNREAD')) tags.push('unread');
    if (labels.includes('CATEGORY_PROMOTIONS')) tags.push('promotions');
    if (labels.includes('CATEGORY_SOCIAL')) tags.push('social');
    if (labels.includes('CATEGORY_UPDATES')) tags.push('updates');
    if (labels.includes('CATEGORY_FORUMS')) tags.push('forums');
    if (labels.includes('STARRED')) tags.push('starred');
    if (labels.includes('IMPORTANT')) tags.push('important');

    const ts = Number(msg.internalDate) || 0;
    if (ts && Date.now() - ts > OLD_MS) tags.push('old');

    return tags;
  }

  /**
   * Find duplicate groups within a set of messages.
   * @param {Array} messages
   * @param {Object} opts { keep: 'newest'|'oldest' }
   * @returns {{ groups, duplicateIds, reclaimBytes, totalDuplicates }}
   */
  function findDuplicates(messages, opts) {
    const keep = (opts && opts.keep) || 'newest';
    const buckets = new Map();
    for (const m of messages) {
      const key = fingerprint(m);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    }

    const groups = [];
    const duplicateIds = [];
    let reclaimBytes = 0;

    for (const [key, items] of buckets) {
      if (items.length < 2) continue;
      const sorted = items
        .slice()
        .sort((a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0));
      const keeper = keep === 'oldest' ? sorted[0] : sorted[sorted.length - 1];
      const dups = sorted.filter((m) => m.id !== keeper.id);
      for (const d of dups) {
        duplicateIds.push(d.id);
        reclaimBytes += d.sizeEstimate || 0;
      }
      const { email, name } = parseFrom(keeper.from);
      groups.push({
        key,
        sender: name || email,
        subject: keeper.subject,
        size: keeper.sizeEstimate || 0,
        count: items.length,
        keepId: keeper.id,
        duplicateIds: dups.map((d) => d.id),
        messages: sorted,
      });
    }

    groups.sort((a, b) => b.count - a.count);
    return { groups, duplicateIds, reclaimBytes, totalDuplicates: duplicateIds.length };
  }

  /** Aggregate messages by sender for bulk-by-sender actions. */
  function groupBySender(messages) {
    const map = new Map();
    for (const m of messages) {
      const { email, name, domain } = parseFrom(m.from);
      const key = email || name || '(unknown)';
      if (!map.has(key)) {
        map.set(key, { sender: name || email, email, domain, count: 0, bytes: 0, ids: [] });
      }
      const g = map.get(key);
      g.count++;
      g.bytes += m.sizeEstimate || 0;
      g.ids.push(m.id);
    }
    return Array.from(map.values()).sort((a, b) => b.bytes - a.bytes);
  }

  return { parseFrom, normSubject, fingerprint, classify, findDuplicates, groupBySender, HEAVY_BYTES };
});
