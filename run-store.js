// How saved runs are kept on the phone. No browser dependencies: storage is passed in.
// Runs stay a plain array under the existing key, so older saved data loads without a separate
// migration step and is upgraded the next time a run is saved.
const RUN_SCHEMA = 2;
const RUN_STORE_MAX = 200;
const RUN_SESSION_GAP_MS = 2 * 60 * 60 * 1000; // Allows for a long cool-down between runs.
const TRACE_MAX_POINTS = 300; // Enough to draw a run, and bounds its share of localStorage.
const BACKUP_FORMAT = "raceps-backup";
const storeMedian = typeof module !== "undefined" ? require("./phone-core.js").median : median;

const RUN_TYPES = ["standing", "roll", "rolling", "from"];
const isTimed = (t) => Boolean(t) && typeof t.label === "string" && Number.isFinite(t.seconds);
const isSpeedTime = (t) => isTimed(t) && Number.isFinite(t.plusMinus);
const isDistanceTime = (t) => isTimed(t) && Number.isFinite(t.trapKmh);

// Checks every field the screens format, because one bad run from storage or a restored file
// would otherwise throw on every load and leave the app unusable.
function isRun(run) {
  return Boolean(run) && Number.isFinite(run.at) && RUN_TYPES.includes(run.type)
    && typeof run.quality === "string" && Number.isFinite(run.peakKmh) && Array.isArray(run.notes)
    && (run.type !== "roll" || (Boolean(run.roll) && typeof run.roll.name === "string" && Number.isFinite(run.roll.heldKmh)))
    && (run.type !== "rolling" || run.fromKmh === null || Number.isFinite(run.fromKmh))
    && (run.type !== "from" || Number.isFinite(run.fromKmh))
    && Array.isArray(run.speeds) && run.speeds.every(isSpeedTime)
    && Array.isArray(run.splits) && run.splits.every(isSpeedTime)
    && Array.isArray(run.distances) && run.distances.every(isDistanceTime);
}

const sameCar = (a, b) => (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();

// Older runs never recorded a car, and today's name may not be the car they were run in, so it
// stays null rather than guessed. Their sessions are inferred from the gaps between them.
function normalizeRuns(raw) {
  if (!Array.isArray(raw)) return [];
  const byTime = new Map();
  for (const run of raw) if (isRun(run) && !byTime.has(run.at)) byTime.set(run.at, run);
  const runs = [...byTime.values()].sort((a, b) => a.at - b.at);
  let previous = null;
  return runs.map((run) => {
    const continues = previous && !previous.fromRecord && run.at - previous.at <= RUN_SESSION_GAP_MS;
    const sessionId = run.sessionId || (continues ? previous.sessionId : `legacy-${run.at}`);
    previous = { at: run.at, sessionId, fromRecord: Boolean(run.sessionId) };
    const text = (value) => (typeof value === "string" && value ? value : null);
    return { ...run, driver: text(run.driver), car: text(run.car), trace: text(run.trace), excluded: run.excluded === true, schema: RUN_SCHEMA, sessionId };
  });
}

function loadStoredRuns(storage, key) {
  try {
    return normalizeRuns(JSON.parse(storage.getItem(key)));
  } catch {
    return [];
  }
}

// A session continues until a long gap or a change of car.
function sessionIdFor(runs, nowMs, car, makeId) {
  const last = runs[runs.length - 1];
  return last && nowMs - last.at <= RUN_SESSION_GAP_MS && sameCar(last.car, car) ? last.sessionId : makeId();
}

// The card opens straight after a first run, so a name is often typed once that run is saved.
// Fills only blanks in a session still under way. Older runs stay unnamed, and set names never change.
function nameLatestSession(runs, driver, car, nowMs) {
  const latest = runs[runs.length - 1];
  if (!latest || latest.sessionId.startsWith("legacy-") || nowMs - latest.at > RUN_SESSION_GAP_MS) return runs;
  return runs.map((run) => (run.sessionId === latest.sessionId
    ? { ...run, driver: run.driver || driver || null, car: run.car || car || null }
    : run));
}

function storeRuns(storage, key, runs) {
  let kept = runs.slice(-RUN_STORE_MAX);
  const outcome = { saved: false, droppedRuns: runs.length - kept.length, droppedTraces: 0 };
  // Times matter more than graphs, so when space runs out traces go first, oldest first.
  for (;;) {
    try {
      storage.setItem(key, JSON.stringify(kept));
      return { ...outcome, saved: true, runs: kept };
    } catch {
      const oldestTrace = kept.findIndex((run) => run.trace);
      if (oldestTrace >= 0) {
        kept = kept.map((run, i) => (i === oldestTrace ? { ...run, trace: null } : run));
        outcome.droppedTraces++;
      } else if (kept.length > 1) {
        kept = kept.slice(1);
        outcome.droppedRuns++;
      } else {
        // Nothing was written, so keep every run in memory for a backup.
        return { saved: false, droppedRuns: 0, droppedTraces: 0, runs: runs.slice(-RUN_STORE_MAX) };
      }
    }
  }
}

// Speed only, relative to the run's start, so a saved run holds no position.
// "ms,kmh;ms,kmh", the same shape as compactRun in remote-log.js.
function encodeTrace(gps, originMs) {
  if (!gps.length) return null;
  const step = (gps.length - 1) / Math.max(TRACE_MAX_POINTS - 1, 1);
  const points = gps.length <= TRACE_MAX_POINTS
    ? gps
    : Array.from({ length: TRACE_MAX_POINTS }, (_, i) => gps[Math.round(i * step)]);
  return points.map((p) => `${Math.round(p.t - originMs)},${p.kmh.toFixed(1)}`).join(";");
}

function decodeTrace(trace) {
  if (!trace) return [];
  return trace.split(";").map((point) => {
    const [t, kmh] = point.split(",").map(Number);
    return { t, kmh };
  });
}

// Median per label. Launch-timed results only count from a stop. Splits need no launch point, so
// they count from any run. Lifted distances are excluded, as their trap speeds aren't comparable.
// So is any run the driver chose to exclude.
function medianByLabel(runs, labels) {
  const values = new Map();
  const add = (timed) => {
    if (timed.liftedOff) return;
    if (!values.has(timed.label)) values.set(timed.label, []);
    values.get(timed.label).push(timed.seconds);
  };
  for (const run of runs) {
    if (run.excluded) continue;
    if (run.type === "standing") [...run.speeds, ...run.distances].forEach(add);
    if (run.type === "from") run.speeds.forEach(add);
    run.splits.forEach(add);
  }
  return labels
    .filter((label) => values.has(label))
    .map((label) => ({
      label,
      seconds: storeMedian(values.get(label)),
      best: Math.min(...values.get(label)),
      runs: values.get(label).length,
    }));
}

const runsInSession = (runs, sessionId) => runs.filter((run) => run.sessionId === sessionId);

const setRunExcluded = (runs, at, excluded) => runs.map((run) => (run.at === at ? { ...run, excluded } : run));
const removeSession = (runs, sessionId) => runs.filter((run) => run.sessionId !== sessionId);

// --- What the screens show ---
const KMH_PER_MPH = 1.609344;
const speedInUnit = (kmh, unit) => (unit === "mph" ? kmh / KMH_PER_MPH : kmh);

// The one time a run is best known by. From a stop that's 0-100 km/h where it was reached.
function headlineOf(run) {
  // For a roll, the time to 100 km/h compares better than the shortest time on the card.
  if (run.type === "roll") {
    return run.speeds.find((t) => /-100( km\/h)?$/.test(t.label)) || run.speeds[0] || run.splits[0] || null;
  }
  // From 60, people compare 60-100; from 100, they compare 100-200.
  if (run.type === "from") {
    const goal = run.fromKmh < 100 ? 100 : 200;
    return run.speeds.find((t) => t.label === `${run.fromKmh}-${goal} km/h`) || run.speeds[0] || null;
  }
  if (run.type !== "standing") return run.speeds[0] || run.splits[0] || null;
  return run.speeds.find((t) => t.label === "0-100 km/h") || run.speeds[run.speeds.length - 1] || run.distances[0] || null;
}

// Null unless there's a real comparison to make: this run counted, and at least one other did too.
function comparedToSession(run, runs) {
  const headline = headlineOf(run);
  if (!headline || run.excluded) return null;
  const [median] = medianByLabel(runsInSession(runs, run.sessionId), [headline.label]);
  if (!median || median.runs < 2) return null;
  return { label: headline.label, median: median.seconds, difference: headline.seconds - median.seconds };
}

// Newest first. labels sets which median headlines each session, the first one it has.
function sessionSummaries(runs, labels) {
  const groups = new Map();
  for (const run of runs) {
    if (!groups.has(run.sessionId)) groups.set(run.sessionId, []);
    groups.get(run.sessionId).push(run);
  }
  return [...groups].map(([sessionId, group]) => ({
    sessionId,
    car: group.map((run) => run.car).filter(Boolean).pop() || null,
    startAt: group[0].at,
    endAt: group[group.length - 1].at,
    runCount: group.length,
    countedCount: group.filter((run) => !run.excluded).length,
    headline: medianByLabel(group, labels)[0] || null,
  })).sort((a, b) => b.endAt - a.endAt);
}

const carsIn = (runs) => [...new Set(runs.map((run) => run.car).filter(Boolean))];

function roundedUp(value, step) {
  return Math.max(Math.ceil(value / step), 1) * step;
}

// Picks the first step that gives a few labels, so axis labels stay round and readable.
function axisTicks(max, steps) {
  const step = steps.find((s) => roundedUp(max, s) / s <= 4) || steps[steps.length - 1];
  const top = roundedUp(max, step);
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

// Numbers for drawing a run's speed graph, in seconds from its start. Null when there's too
// little to draw, as with runs saved before traces were kept.
function speedChart(run, unit) {
  const points = decodeTrace(run.trace)
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.kmh) && p.t >= 0)
    .map((p) => ({ t: p.t / 1000, v: speedInUnit(p.kmh, unit) }));
  if (points.length < 2) return null;
  const time = axisTicks(points[points.length - 1].t, [1, 2, 5, 10, 20, 30, 60]);
  const speed = axisTicks(Math.max(...points.map((p) => p.v)), [10, 20, 50, 100]);
  return { points, tMax: time.top, tTicks: time.ticks, vMax: speed.top, vTicks: speed.ticks };
}

// The app promises names stay on the phone, and diagnostics are random per visit. A session id
// lasts across visits, so it would link them. Raw speed is already logged separately.
function diagnosticsRecord(run) {
  const { driver, car, sessionId, trace, ...shared } = run;
  return shared;
}

function backupText(runs, nowMs, version) {
  return JSON.stringify({ format: BACKUP_FORMAT, schema: RUN_SCHEMA, exportedAt: nowMs, version, runs });
}

// Returns the merged runs, or null if this isn't a backup. On a clash the phone's copy wins.
function mergeBackup(text, existing) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    return null;
  }
  if (!backup || backup.format !== BACKUP_FORMAT || !Array.isArray(backup.runs)) return null;
  return normalizeRuns([...existing, ...backup.runs]);
}

if (typeof module !== "undefined") module.exports = { RUN_STORE_MAX, RUN_SESSION_GAP_MS, TRACE_MAX_POINTS, normalizeRuns, loadStoredRuns, sessionIdFor, nameLatestSession, storeRuns, encodeTrace, decodeTrace, medianByLabel, runsInSession, setRunExcluded, removeSession, speedInUnit, headlineOf, comparedToSession, sessionSummaries, carsIn, speedChart, diagnosticsRecord, backupText, mergeBackup };
