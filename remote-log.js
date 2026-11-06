// Opt-in diagnostics, delivered as Netlify Forms submissions. GPS position is left out
// deliberately: run records are built from an allowlist of fields, so it can't slip in.
const LOG_FORM_NAME = "raceps-logs";
const LOG_STORAGE_KEY = "raceps-log-queue"; // The bare key is the older, shared queue format.
const MAX_STORED_CHARS = 1000000;
const KEEPALIVE_LIMIT_CHARS = 60000; // Browsers cap keepalive requests at 64 KB.
const ORPHAN_AFTER_MS = 600000; // A queue this quiet is assumed to belong to a closed tab.

function compactRun({ motion, gps, launchMs }) {
  const relative = (t) => Math.round(t - launchMs);
  return {
    motion: motion.map((m) => [relative(m.t), m.x.toFixed(3), m.y.toFixed(3), m.z.toFixed(3)].join(",")).join(";"),
    gps: gps.map((g) => [relative(g.t), g.kmh.toFixed(2), g.accuracy == null ? "" : g.accuracy.toFixed(1)].join(",")).join(";"),
  };
}

// Each tab keeps its own queue, because a shared one made every open tab send the same
// entries. Queues left by closed tabs are adopted, and removing the stored copy is what
// transfers ownership: a tab that finds its copy gone knows another tab took over.
class RemoteLog {
  constructor({ send, storage, now, session, version, device }) {
    Object.assign(this, { send, storage, now, session, version, device });
    this.enabled = false;
    this.sending = false;
    this.persisted = false;
    this.entries = [];
    this.key = `${LOG_STORAGE_KEY}:${session}`;
  }

  queueKeys() {
    const keys = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key === LOG_STORAGE_KEY || key.startsWith(`${LOG_STORAGE_KEY}:`)) keys.push(key);
    }
    return keys;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.entries = [];
      this.adoptQueues();
    } else {
      // Withdrawing consent also discards anything not yet sent, in every tab.
      this.entries = [];
      this.persisted = false;
      this.queueKeys().forEach((key) => this.storage.removeItem(key));
    }
  }

  readQueue(key) {
    try {
      const value = JSON.parse(this.storage.getItem(key));
      if (Array.isArray(value)) return { updatedAt: -Infinity, entries: value };
      return value && Array.isArray(value.entries) ? value : null;
    } catch {
      return null;
    }
  }

  adoptQueues() {
    let adopted = [];
    for (const key of this.queueKeys()) {
      const queue = this.readQueue(key);
      const own = key === this.key;
      if (queue && !own && this.now() - queue.updatedAt < ORPHAN_AFTER_MS) continue;
      if (queue && (!own || !this.persisted)) adopted = adopted.concat(queue.entries);
      if (!own) this.storage.removeItem(key);
    }
    if (!adopted.length) return;
    this.entries = [...adopted, ...this.entries].sort((a, b) => a.at - b.at);
    this.persist();
  }

  // Another tab adopted this queue, so sending it here would create duplicates.
  dropIfAdopted() {
    if (this.persisted && this.storage.getItem(this.key) === null) {
      this.entries = [];
      this.persisted = false;
    }
  }

  persist() {
    if (!this.entries.length) {
      this.storage.removeItem(this.key);
      this.persisted = false;
      return;
    }
    let text = JSON.stringify({ updatedAt: this.now(), entries: this.entries });
    while (text.length > MAX_STORED_CHARS && this.entries.length > 1) {
      this.entries.shift();
      text = JSON.stringify({ updatedAt: this.now(), entries: this.entries });
    }
    try {
      if (text.length <= MAX_STORED_CHARS) {
        this.storage.setItem(this.key, text);
        this.persisted = true;
      }
    } catch {
      // Storage is full or blocked. The queue still lives in memory for this session.
      this.persisted = false;
    }
  }

  log(type, data = {}) {
    if (!this.enabled) return;
    this.dropIfAdopted();
    this.entries.push({ at: this.now(), type, data });
    this.persist();
  }

  encode(entries) {
    return new URLSearchParams({
      "form-name": LOG_FORM_NAME,
      session: this.session,
      version: this.version,
      device: this.device,
      payload: JSON.stringify(entries),
    }).toString();
  }

  // Returns "empty", "sent", "deferred" or "failed". Unsent entries stay queued for later.
  async flush({ pageClosing = false } = {}) {
    if (!this.enabled || this.sending) return "empty";
    this.dropIfAdopted();
    this.adoptQueues();
    if (!this.entries.length) return "empty";
    const batch = [...this.entries];
    const body = this.encode(batch);
    if (pageClosing && body.length > KEEPALIVE_LIMIT_CHARS) return "deferred";
    this.sending = true;
    try {
      const ok = await this.send(body, pageClosing);
      if (!ok) return "failed";
      this.entries = this.entries.slice(batch.length);
      this.persist();
      return "sent";
    } catch {
      return "failed";
    } finally {
      this.sending = false;
    }
  }
}

if (typeof module !== "undefined") module.exports = { RemoteLog, compactRun, LOG_FORM_NAME };
