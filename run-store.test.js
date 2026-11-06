const test = require("node:test");
const assert = require("node:assert");
const { RUN_STORE_MAX, RUN_SESSION_GAP_MS, TRACE_MAX_POINTS, normalizeRuns, loadStoredRuns, sessionIdFor, nameLatestSession, storeRuns, encodeTrace, decodeTrace, medianByLabel, runsInSession, setRunExcluded, removeSession, speedInUnit, headlineOf, comparedToSession, sessionSummaries, carsIn, speedChart, diagnosticsRecord, backupText, mergeBackup } = require("./run-store.js");

const HOUR = 60 * 60 * 1000;
const timed = (label, seconds, extra = {}) => ({ label, seconds, plusMinus: 0.1, trapKmh: 150, ...extra });

function legacyRun(at, overrides = {}) {
  return { at, version: "0.10.0", type: "standing", quality: "good", roll: null, notes: [], fromKmh: 0, peakKmh: 120, speeds: [], splits: [], distances: [], ...overrides };
}

function memoryStorage({ limit = Infinity, value = null } = {}) {
  return {
    value,
    getItem() { return this.value; },
    setItem(_key, next) {
      if (next.length > limit) throw new Error("QuotaExceededError");
      this.value = next;
    },
  };
}

test("older runs load with sessions from their time gaps and no guessed car", () => {
  const runs = normalizeRuns([legacyRun(0), legacyRun(HOUR), legacyRun(HOUR + RUN_SESSION_GAP_MS + 1)]);
  assert.strictEqual(runs[0].sessionId, runs[1].sessionId);
  assert.notStrictEqual(runs[1].sessionId, runs[2].sessionId);
  assert.strictEqual(runs[0].car, null);
  assert.strictEqual(runs[0].driver, null);
  assert.strictEqual(runs[0].trace, null);
});

test("inferred sessions stay the same each time older runs load", () => {
  const raw = [legacyRun(5000), legacyRun(9000)];
  assert.deepStrictEqual(normalizeRuns(raw), normalizeRuns(raw));
});

test("a saved session id is kept, and older runs don't join it", () => {
  const runs = normalizeRuns([legacyRun(0, { sessionId: "track-day" }), legacyRun(1000)]);
  assert.strictEqual(runs[0].sessionId, "track-day");
  assert.notStrictEqual(runs[1].sessionId, "track-day");
});

test("damaged entries are skipped without losing the good ones", () => {
  const runs = normalizeRuns([null, { at: 1 }, legacyRun(2), "x", legacyRun(2)]);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].at, 2);
});

test("runs the screens couldn't format are skipped, so they can't break every load", () => {
  const bad = [
    legacyRun(1, { speeds: [{ label: "0-100 km/h" }] }),
    legacyRun(2, { splits: [{ label: "60-100 km/h", seconds: 3 }] }),
    legacyRun(3, { distances: [{ label: "400 m", seconds: 13 }] }),
    legacyRun(4, { type: "roll", roll: null }),
    legacyRun(5, { peakKmh: "fast" }),
    legacyRun(6, { notes: "none" }),
    legacyRun(7, { type: "other" }),
  ];
  assert.deepStrictEqual(normalizeRuns(bad), []);
});

test("every kind of real run passes the checks", () => {
  const runs = normalizeRuns([
    legacyRun(1, { speeds: [timed("0-100 km/h", 6)], distances: [timed("400 m", 13)] }),
    legacyRun(2, { type: "roll", quality: "good", roll: { name: "40 roll", heldKmh: 40 }, speeds: [timed("40-100", 4)] }),
    legacyRun(3, { type: "rolling", quality: "rolling", fromKmh: null, splits: [timed("60-100 km/h", 3)] }),
  ]);
  assert.strictEqual(runs.length, 3);
});

test("a name typed after a run fills that session's blanks only", () => {
  const runs = normalizeRuns([
    legacyRun(1, { sessionId: "old", car: "M3" }),
    legacyRun(2, { sessionId: "now" }),
    legacyRun(3, { sessionId: "now", car: "GTI" }),
  ]);
  const named = nameLatestSession(runs, "Sam", "Polo", 3);
  assert.deepStrictEqual(named.map((r) => [r.driver, r.car]), [[null, "M3"], ["Sam", "Polo"], ["Sam", "GTI"]]);
});

test("names are never guessed onto runs from before cars were recorded", () => {
  const runs = normalizeRuns([legacyRun(1)]);
  assert.strictEqual(nameLatestSession(runs, "Sam", "GTI", 2)[0].car, null);
  assert.deepStrictEqual(nameLatestSession([], "Sam", "GTI", 2), []);
});

test("a name typed long after a session doesn't relabel it", () => {
  const runs = normalizeRuns([legacyRun(1, { sessionId: "old" })]);
  assert.strictEqual(nameLatestSession(runs, "Sam", "GTI", 1 + RUN_SESSION_GAP_MS + 1)[0].car, null);
});

test("unreadable or missing storage gives no runs", () => {
  assert.deepStrictEqual(loadStoredRuns(memoryStorage({ value: "{not json" }), "k"), []);
  assert.deepStrictEqual(loadStoredRuns(memoryStorage(), "k"), []);
  assert.deepStrictEqual(loadStoredRuns(memoryStorage({ value: '{"a":1}' }), "k"), []);
});

test("a session continues within the gap for the same car", () => {
  const runs = normalizeRuns([legacyRun(0, { sessionId: "s1", car: "GTI" })]);
  assert.strictEqual(sessionIdFor(runs, HOUR, " gti ", () => "new"), "s1");
});

test("a long gap, a different car or no earlier run starts a new session", () => {
  const runs = normalizeRuns([legacyRun(0, { sessionId: "s1", car: "GTI" })]);
  assert.strictEqual(sessionIdFor(runs, RUN_SESSION_GAP_MS + 1, "GTI", () => "new"), "new");
  assert.strictEqual(sessionIdFor(runs, HOUR, "M3", () => "new"), "new");
  assert.strictEqual(sessionIdFor([], 0, "GTI", () => "new"), "new");
});

test("only the newest runs are kept past the limit", () => {
  const runs = normalizeRuns(Array.from({ length: RUN_STORE_MAX + 5 }, (_, i) => legacyRun(i)));
  const outcome = storeRuns(memoryStorage(), "k", runs);
  assert.strictEqual(outcome.runs.length, RUN_STORE_MAX);
  assert.strictEqual(outcome.droppedRuns, 5);
  assert.strictEqual(outcome.runs[0].at, 5);
});

test("when storage is full, oldest traces go before any run is lost", () => {
  const trace = "x".repeat(1000);
  const runs = normalizeRuns([legacyRun(1, { trace }), legacyRun(2, { trace }), legacyRun(3, { trace })]);
  const size = JSON.stringify(runs).length;
  const outcome = storeRuns(memoryStorage({ limit: size - 500 }), "k", runs);
  assert.ok(outcome.saved);
  assert.strictEqual(outcome.droppedRuns, 0);
  assert.strictEqual(outcome.droppedTraces, 1);
  assert.strictEqual(outcome.runs[0].trace, null);
  assert.strictEqual(outcome.runs[2].trace, trace);
});

test("when traces aren't enough, oldest runs go and the newest survives", () => {
  const runs = normalizeRuns([legacyRun(1), legacyRun(2), legacyRun(3)]);
  const oneRun = JSON.stringify(runs.slice(-1)).length;
  const outcome = storeRuns(memoryStorage({ limit: oneRun }), "k", runs);
  assert.ok(outcome.saved);
  assert.deepStrictEqual(outcome.runs.map((r) => r.at), [3]);
});

test("reports failure, rather than throwing, when nothing fits", () => {
  const outcome = storeRuns(memoryStorage({ limit: 0 }), "k", normalizeRuns([legacyRun(1)]));
  assert.strictEqual(outcome.saved, false);
  assert.strictEqual(outcome.runs.length, 1);
});

test("a failed save keeps traces in memory, so a backup can still include them", () => {
  const runs = normalizeRuns([legacyRun(1, { trace: "0,0.0" }), legacyRun(2, { trace: "0,0.0" })]);
  const outcome = storeRuns(memoryStorage({ limit: 0 }), "k", runs);
  assert.strictEqual(outcome.runs.length, 2);
  assert.ok(outcome.runs.every((run) => run.trace));
});

test("a trace round-trips speed against time from the run's start", () => {
  const trace = encodeTrace([{ t: 1000, kmh: 0 }, { t: 1500, kmh: 12.34, latitude: -33.9, longitude: 18.4 }], 1000);
  assert.strictEqual(trace, "0,0.0;500,12.3");
  assert.deepStrictEqual(decodeTrace(trace), [{ t: 0, kmh: 0 }, { t: 500, kmh: 12.3 }]);
});

test("a long trace is thinned, keeping both ends", () => {
  const gps = Array.from({ length: 2000 }, (_, i) => ({ t: i * 40, kmh: i / 10 }));
  const points = decodeTrace(encodeTrace(gps, 0));
  assert.strictEqual(points.length, TRACE_MAX_POINTS);
  assert.strictEqual(points[0].t, 0);
  assert.strictEqual(points[points.length - 1].t, 1999 * 40);
});

test("an empty trace is stored as none", () => {
  assert.strictEqual(encodeTrace([], 0), null);
  assert.deepStrictEqual(decodeTrace(null), []);
});

test("a full store of the largest runs fits well inside localStorage", () => {
  const gps = Array.from({ length: TRACE_MAX_POINTS }, (_, i) => ({ t: i * 200, kmh: 150 + i / 10 }));
  const speeds = Array.from({ length: 5 }, () => timed("0-100 km/h", 12.34));
  const runs = normalizeRuns(Array.from({ length: RUN_STORE_MAX }, (_, i) => legacyRun(i, {
    sessionId: "00000000-0000-0000-0000-000000000000", driver: "D".repeat(30), car: "C".repeat(30),
    trace: encodeTrace(gps, 0), speeds, splits: speeds.slice(0, 3), distances: speeds,
  })));
  // localStorage commonly allows about 5 MB, and diagnostics queues share it.
  assert.ok(JSON.stringify(runs).length < 2.5 * 1024 * 1024);
});

test("medians survive a reload, because they come from saved runs", () => {
  const storage = memoryStorage();
  const runs = normalizeRuns([
    legacyRun(1, { speeds: [timed("0-100 km/h", 6)] }),
    legacyRun(2, { speeds: [timed("0-100 km/h", 8)] }),
    legacyRun(3, { speeds: [timed("0-100 km/h", 7)] }),
  ]);
  storeRuns(storage, "k", runs);
  const [result] = medianByLabel(loadStoredRuns(storage, "k"), ["0-100 km/h"]);
  assert.deepStrictEqual(result, { label: "0-100 km/h", seconds: 7, best: 6, runs: 3 });
});

test("medians ignore lifted distances and launch times from rolls, but use their splits", () => {
  const runs = normalizeRuns([
    legacyRun(1, { distances: [timed("400 m", 13)], splits: [timed("60-100 km/h", 3)] }),
    legacyRun(2, { distances: [timed("400 m", 20, { liftedOff: true })] }),
    legacyRun(3, { type: "roll", roll: { name: "40 roll", heldKmh: 40 }, speeds: [timed("400 m", 99)], splits: [timed("60-100 km/h", 5)] }),
  ]);
  assert.deepStrictEqual(medianByLabel(runs, ["400 m", "60-100 km/h", "0-200 km/h"]), [
    { label: "400 m", seconds: 13, best: 13, runs: 1 },
    { label: "60-100 km/h", seconds: 4, best: 3, runs: 2 },
  ]);
});

test("runs can be picked out by session", () => {
  const runs = normalizeRuns([legacyRun(1, { sessionId: "a" }), legacyRun(2, { sessionId: "b" })]);
  assert.deepStrictEqual(runsInSession(runs, "b").map((r) => r.at), [2]);
});

test("names and the lasting session id never reach diagnostics", () => {
  const [run] = normalizeRuns([legacyRun(1, { sessionId: "s1", driver: "Sam", car: "GTI", trace: "0,0.0" })]);
  const shared = diagnosticsRecord(run);
  for (const field of ["driver", "car", "sessionId", "trace"]) assert.ok(!(field in shared));
  assert.strictEqual(shared.peakKmh, 120);
});

test("a backup restores lost runs, keeps the phone's copy on a clash and adds no duplicates", () => {
  const backup = backupText(normalizeRuns([legacyRun(1, { peakKmh: 111 }), legacyRun(2)]), 10, "0.11.0");
  const merged = mergeBackup(backup, normalizeRuns([legacyRun(2), legacyRun(1, { peakKmh: 222 })]));
  assert.deepStrictEqual(merged.map((r) => [r.at, r.peakKmh]), [[1, 222], [2, 120]]);
  assert.deepStrictEqual(mergeBackup(backup, []).map((r) => r.at), [1, 2]);
});

test("a file that isn't a backup is refused", () => {
  assert.strictEqual(mergeBackup("not json", []), null);
  assert.strictEqual(mergeBackup('{"runs":[]}', []), null);
  assert.strictEqual(mergeBackup("null", []), null);
});

test("odd names, traces and flags from a restored file can't reach the screens", () => {
  const [run] = normalizeRuns([legacyRun(1, { car: 42, driver: {}, trace: 7, excluded: "yes" })]);
  assert.deepStrictEqual([run.car, run.driver, run.trace, run.excluded], [null, null, null, false]);
  assert.strictEqual(sessionIdFor([run], 2, "GTI", () => "new"), "new");
});

test("an excluded run leaves the medians, and including it again restores them", () => {
  const runs = normalizeRuns([
    legacyRun(1, { speeds: [timed("0-100 km/h", 5)] }),
    legacyRun(2, { speeds: [timed("0-100 km/h", 9)] }),
  ]);
  const without = setRunExcluded(runs, 2, true);
  assert.strictEqual(medianByLabel(without, ["0-100 km/h"])[0].seconds, 5);
  assert.strictEqual(medianByLabel(setRunExcluded(without, 2, false), ["0-100 km/h"])[0].seconds, 7);
});

test("the excluded choice survives saving and loading", () => {
  const storage = memoryStorage();
  storeRuns(storage, "k", setRunExcluded(normalizeRuns([legacyRun(1)]), 1, true));
  assert.strictEqual(loadStoredRuns(storage, "k")[0].excluded, true);
});

test("deleting a session removes only its runs", () => {
  const runs = normalizeRuns([legacyRun(1, { sessionId: "a" }), legacyRun(2, { sessionId: "b" })]);
  assert.deepStrictEqual(removeSession(runs, "a").map((r) => r.at), [2]);
});

test("speeds convert to mph, and km/h stays as it is", () => {
  assert.ok(Math.abs(speedInUnit(100, "mph") - 62.137) < 0.001);
  assert.strictEqual(speedInUnit(100, "km/h"), 100);
});

test("a run from a stop is headlined by 0-100 km/h, then the furthest speed, then distance", () => {
  const both = legacyRun(1, { speeds: [timed("0-60 km/h", 3), timed("0-100 km/h", 6), timed("0-150 km/h", 12)] });
  assert.strictEqual(headlineOf(both).label, "0-100 km/h");
  assert.strictEqual(headlineOf(legacyRun(1, { speeds: [timed("0-60 km/h", 3), timed("0-60 mph", 5)] })).label, "0-60 mph");
  assert.strictEqual(headlineOf(legacyRun(1, { distances: [timed("100 m", 7)] })).label, "100 m");
  assert.strictEqual(headlineOf(legacyRun(1)), null);
});

test("a run with no launch time is headlined by its roll or split", () => {
  assert.strictEqual(headlineOf(legacyRun(1, { type: "roll", speeds: [timed("40-100", 4)], splits: [timed("60-100 km/h", 3)] })).label, "40-100");
  assert.strictEqual(headlineOf(legacyRun(1, { type: "rolling", splits: [timed("60-100 km/h", 3)] })).label, "60-100 km/h");
});

test("comparing to the session needs another counted run", () => {
  const runs = normalizeRuns([
    legacyRun(1, { sessionId: "s", speeds: [timed("0-100 km/h", 5)] }),
    legacyRun(2, { sessionId: "s", speeds: [timed("0-100 km/h", 7)] }),
  ]);
  assert.deepStrictEqual(comparedToSession(runs[0], runs), { label: "0-100 km/h", median: 6, difference: -1 });
  assert.strictEqual(comparedToSession(runs[0], runsInSession(runs, "s").slice(0, 1)), null);
  const excluded = setRunExcluded(runs, 2, true);
  assert.strictEqual(comparedToSession(excluded[1], excluded), null);
  assert.strictEqual(comparedToSession(excluded[0], excluded), null);
});

test("sessions list newest first, with their car, counts and headline median", () => {
  const runs = normalizeRuns([
    legacyRun(1, { sessionId: "old", car: "M3", speeds: [timed("0-100 km/h", 5)] }),
    legacyRun(2, { sessionId: "new", car: "GTI", speeds: [timed("0-100 km/h", 6)], excluded: true }),
    legacyRun(3, { sessionId: "new", car: "GTI", speeds: [timed("0-100 km/h", 7)] }),
    legacyRun(4, { sessionId: "none", speeds: [] }),
  ]);
  const [none, latest, oldest] = sessionSummaries(runs, ["0-100 km/h"]);
  assert.strictEqual(none.headline, null);
  assert.strictEqual(none.car, null);
  assert.deepStrictEqual([latest.sessionId, latest.car, latest.startAt, latest.endAt, latest.runCount, latest.countedCount], ["new", "GTI", 2, 3, 2, 1]);
  assert.strictEqual(latest.headline.seconds, 7);
  assert.strictEqual(oldest.sessionId, "old");
  assert.deepStrictEqual(carsIn(runs), ["M3", "GTI"]);
});

test("a speed chart starts at the run's start, with round axes that contain every point", () => {
  const run = normalizeRuns([legacyRun(1, { trace: "-3000,0.0;0,0.0;7000,100.0;14500,162.0" })])[0];
  const chart = speedChart(run, "km/h");
  assert.deepStrictEqual(chart.points[0], { t: 0, v: 0 });
  assert.strictEqual(chart.points.length, 3);
  assert.deepStrictEqual(chart.vTicks, [0, 50, 100, 150, 200]);
  assert.strictEqual(chart.vMax, 200);
  assert.deepStrictEqual(chart.tTicks, [0, 5, 10, 15]);
  assert.ok(Math.abs(speedChart(run, "mph").points[1].v - 62.137) < 0.001);
});

test("runs with no usable trace have no chart", () => {
  for (const trace of [null, "", "0,0.0", "junk;more,junk", "-500,0.0;-100,5.0"]) {
    assert.strictEqual(speedChart(normalizeRuns([legacyRun(1, { trace })])[0], "km/h"), null);
  }
});

test("every element the page's script looks up by id exists, or features break silently", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(used.size > 20);
  assert.deepStrictEqual([...used].filter((id) => !ids.has(id)), []);
});

test("the Netlify log form and every script stay available offline", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const worker = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
  assert.match(html, /<form name="raceps-logs" data-netlify="true"/);
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(worker.includes(`"${src}"`), src);
});

test("a roll's headline is its time to 100 km/h when it has one", () => {
  const speeds = [timed("40-60 km/h", 1.4), timed("40-80 km/h", 2.9), timed("40-100 km/h", 4.3)];
  assert.strictEqual(headlineOf(legacyRun(1, { type: "roll", speeds })).label, "40-100 km/h");
  assert.strictEqual(headlineOf(legacyRun(1, { type: "roll", speeds: speeds.slice(0, 2) })).label, "40-60 km/h");
});

test("a from-speed run is kept, counted in medians and headlined by its 100 time", () => {
  const { normalizeRuns: keep, medianByLabel: medians, headlineOf: headline } = require("./run-store.js");
  const run = { at: 1, version: "0.13.0", type: "from", quality: "rolling", roll: null, notes: [], launchIssue: null, fromKmh: 60, peakKmh: 140,
    speeds: [{ label: "60-80 km/h", seconds: 3, plusMinus: 0.2 }, { label: "60-100 km/h", seconds: 6, plusMinus: 0.2 }], splits: [], distances: [] };
  const [kept] = keep([run]);
  assert.ok(kept, "run should survive loading");
  assert.strictEqual(headline(kept).label, "60-100 km/h");
  assert.strictEqual(medians([kept], ["60-100 km/h"])[0].seconds, 6);
});
