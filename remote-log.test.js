const test = require("node:test");
const assert = require("node:assert");
const { RemoteLog, compactRun } = require("./remote-log.js");

function setup(sendResult = true) {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => [...store.keys()][i],
  };
  const sent = [];
  const send = async (body, keepalive) => {
    sent.push({ body, keepalive });
    return sendResult;
  };
  const options = { send, storage, now: () => 1000, session: "s1", version: "1", device: "test" };
  return { log: new RemoteLog(options), sent, store, options };
}

test("nothing is recorded or sent without consent", async () => {
  const { log, sent, store } = setup();
  log.log("start");
  assert.strictEqual(await log.flush(), "empty");
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(store.size, 0);
});

test("a flush sends the Netlify form fields and clears the queue", async () => {
  const { log, sent } = setup();
  log.setEnabled(true);
  log.log("start", { a: 1 });
  assert.strictEqual(await log.flush(), "sent");
  const fields = new URLSearchParams(sent[0].body);
  assert.strictEqual(fields.get("form-name"), "raceps-logs");
  assert.strictEqual(fields.get("session"), "s1");
  assert.deepStrictEqual(JSON.parse(fields.get("payload")), [{ at: 1000, type: "start", data: { a: 1 } }]);
  assert.strictEqual(log.entries.length, 0);
});

test("failed sends stay queued and survive a reload", async () => {
  const { log, options } = setup(false);
  log.setEnabled(true);
  log.log("run");
  assert.strictEqual(await log.flush(), "failed");
  const reloaded = new RemoteLog(options);
  reloaded.setEnabled(true);
  assert.strictEqual(reloaded.entries.length, 1);
});

test("withdrawing consent discards unsent logs", () => {
  const { log, store } = setup(false);
  log.setEnabled(true);
  log.log("run");
  log.setEnabled(false);
  assert.strictEqual(store.size, 0);
  log.log("after");
  assert.strictEqual(log.entries.length, 0);
});

test("large batches wait instead of using a keepalive request", async () => {
  const { log, sent } = setup();
  log.setEnabled(true);
  log.log("run", { blob: "x".repeat(70000) });
  assert.strictEqual(await log.flush({ pageClosing: true }), "deferred");
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(await log.flush(), "sent");
});

test("run records cannot contain GPS position", () => {
  const run = compactRun({
    launchMs: 1000,
    motion: [{ t: 1020, x: 1, y: 2, z: 3 }],
    gps: [{ t: 2000, kmh: 50, accuracy: 5, latitude: -33.9249, longitude: 18.4241, lat: -33.9249, lon: 18.4241 }],
  });
  assert.strictEqual(run.motion, "20,1.000,2.000,3.000");
  assert.strictEqual(run.gps, "1000,50.00,5.0");
  assert.ok(!JSON.stringify(run).includes("33.9"));
  assert.ok(!JSON.stringify(run).includes("18.4"));
});

// --- Several tabs on one phone ---
function twoTabs() {
  const { store, options } = setup();
  const sent = [];
  let time = 1000;
  const tab = (session) => new RemoteLog({
    ...options,
    session,
    now: () => time,
    send: async (body) => {
      sent.push(new URLSearchParams(body));
      return true;
    },
  });
  return { tab, sent, store, advance: (ms) => (time += ms) };
}

const sentTypes = (sent) => sent.flatMap((s) => JSON.parse(s.get("payload")).map((e) => e.type));

test("two open tabs never send each other's entries", async () => {
  const { tab, sent } = twoTabs();
  const a = tab("a");
  const b = tab("b");
  a.setEnabled(true);
  a.log("from_a");
  b.setEnabled(true);
  b.log("from_b");
  await a.flush();
  await b.flush();
  assert.deepStrictEqual(sentTypes(sent), ["from_a", "from_b"]);
});

test("a closed tab's unsent logs are sent once by a later tab", async () => {
  const { tab, sent, advance } = twoTabs();
  const closed = tab("closed");
  closed.setEnabled(true);
  closed.log("left_behind");
  advance(600000);
  const later = tab("later");
  later.setEnabled(true);
  await later.flush();
  await later.flush();
  assert.deepStrictEqual(sentTypes(sent), ["left_behind"]);
  assert.strictEqual(sent[0].get("session"), "later");
});

test("a suspended tab that wakes after being adopted does not resend", async () => {
  const { tab, sent, advance } = twoTabs();
  const suspended = tab("suspended");
  suspended.setEnabled(true);
  suspended.log("entry");
  advance(600000);
  const other = tab("other");
  other.setEnabled(true);
  await other.flush();
  await suspended.flush();
  assert.deepStrictEqual(sentTypes(sent), ["entry"]);
});

test("logs in the old shared queue format are still delivered", async () => {
  const { tab, sent, store } = twoTabs();
  store.set("raceps-log-queue", JSON.stringify([{ at: 5, type: "old", data: {} }]));
  const a = tab("a");
  a.setEnabled(true);
  await a.flush();
  assert.deepStrictEqual(sentTypes(sent), ["old"]);
  assert.ok(!store.has("raceps-log-queue"));
});

test("withdrawing consent clears every tab's stored queue", () => {
  const { tab, store } = twoTabs();
  const a = tab("a");
  const b = tab("b");
  a.setEnabled(true);
  a.log("one");
  b.setEnabled(true);
  b.log("two");
  a.setEnabled(false);
  assert.strictEqual(store.size, 0);
});
