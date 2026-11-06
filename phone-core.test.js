const test = require("node:test");
const assert = require("node:assert");
const { LaunchTimer, analyzeRun, median, resolveSpeed, motionIsQuiet, GpsHealth, SpeedCallouts, rateHz, isNewerVersion, findGentleLaunch, gpsRestartDelayMs, hasRecentMotion, PullTracker, findSplits, findRoll, rollName, RollReadyWatch, chooseRunType, spokenNumber, pickVoice } = require("./phone-core.js");

const targets = [{ label: "0-100", kmh: 100 }];

// 20 km/h per second from launchMs, with GPS at 1 Hz.
function run(timer, launchMs, { motion = true } = {}) {
  for (let t = 0; t <= launchMs; t += 1000) timer.onSpeed(t, 0);
  if (motion) for (let t = launchMs; t <= launchMs + 300; t += 20) timer.onMotion(t, 5);
  for (let t = launchMs + 1000 - (launchMs % 1000); t <= launchMs + 7000; t += 1000) {
    timer.onSpeed(t, (t - launchMs) * 0.02);
  }
}

test("motion launch plus interpolated GPS gives the true time at 1 Hz", () => {
  const timer = new LaunchTimer(targets);
  run(timer, 3000);
  assert.strictEqual(timer.results[0].source, "motion");
  assert.ok(Math.abs(timer.results[0].seconds - 5) < 0.001);
});

test("falls back to GPS for launch when motion is unavailable", () => {
  const timer = new LaunchTimer(targets);
  run(timer, 3000, { motion: false });
  assert.strictEqual(timer.results[0].source, "gps");
  assert.ok(Math.abs(timer.results[0].seconds - 4.85) < 0.001);
});

test("a brief bump does not start a run", () => {
  const timer = new LaunchTimer(targets);
  timer.onSpeed(0, 0);
  timer.onMotion(100, 5);
  timer.onMotion(120, 0);
  timer.onMotion(400, 5);
  assert.strictEqual(timer.startMs, null);
});

test("a false start re-arms once the car stays still", () => {
  const timer = new LaunchTimer(targets);
  timer.onSpeed(0, 0);
  timer.onMotion(100, 5);
  timer.onMotion(300, 5);
  assert.strictEqual(timer.startMs, 100);
  timer.onSpeed(1000, 0);
  assert.strictEqual(timer.startMs, 100);
  timer.onSpeed(4000, 0);
  assert.strictEqual(timer.startMs, null);
});

test("rolling starts and GPS dropouts produce no result", () => {
  const rolling = new LaunchTimer(targets);
  rolling.onSpeed(0, 50);
  rolling.onSpeed(1000, 110);
  assert.strictEqual(rolling.results.length, 0);

  const dropout = new LaunchTimer(targets);
  dropout.onSpeed(0, 0);
  dropout.onSpeed(1000, 20);
  dropout.onSpeed(6000, 120);
  assert.strictEqual(dropout.results.length, 0);
});

test("the last result stays visible after stopping, until a new run produces one", () => {
  const timer = new LaunchTimer(targets);
  run(timer, 3000);
  timer.onSpeed(11000, 60);
  timer.onSpeed(12000, 0);
  assert.strictEqual(timer.results.length, 1);
  timer.onSpeed(13000, 0);
  timer.onMotion(13100, 5);
  timer.onMotion(13300, 5);
  timer.onSpeed(14000, 18);
  assert.strictEqual(timer.results[0].seconds, 5);
  timer.onSpeed(15000, 60);
  timer.onSpeed(16000, 110);
  assert.strictEqual(timer.results.length, 1);
  assert.notStrictEqual(timer.results[0].seconds, 5);
});

// --- Simulated runs for the after-run analysis ---
const LAUNCH = 6000;
const END = LAUNCH + 15000;
const TARGET = [{ label: "0-100", kmh: 100 }];

function randomSource(seed) {
  let state = seed;
  const uniform = () => (state = (state * 16807) % 2147483647) / 2147483647;
  return (size) => size * (uniform() + uniform() + uniform() - 1.5);
}

// Falling acceleration with two gear-shift dips.
function trueAccel(t) {
  const tau = (t - LAUNCH) / 1000;
  if (tau < 0) return 0;
  if ((tau > 3 && tau < 3.3) || (tau > 7 && tau < 7.4)) return 0.5;
  return 7 * Math.exp(-tau / 12);
}

function simulate({ delay = 0, lagS = 0, seed = 7, motionHz = 60, gpsNoise = 0.1, dropEvery = 0, bumpy = false } = {}) {
  const noise = randomSource(seed);
  // A phone tilted about two axes, with sensor bias and slow drift during the run.
  const forward = [0.8, 0.1, -0.59];
  const up = [0.58, 0.14, 0.8];
  const bias = [0.05, -0.08, 0.04];
  const truth = [];
  const motion = [];
  let v = 0;
  const step = 1000 / motionHz;
  for (let t = 0; t <= END; t += step) {
    const a = trueAccel(t);
    v += (a * step) / 1000;
    truth.push({ t, v });
    const drift = t > LAUNCH ? 0.03 : 0;
    const shake = bumpy && t < LAUNCH ? 2 : 0.1;
    motion.push({
      t,
      x: a * forward[0] + 9.81 * up[0] + bias[0] + drift + noise(shake),
      y: a * forward[1] + 9.81 * up[1] + bias[1] + noise(shake),
      z: a * forward[2] + 9.81 * up[2] + bias[2] + noise(shake),
    });
  }
  const speedAt = (t) => (t <= 0 ? 0 : truth[Math.min(truth.length - 1, Math.floor(t / step))].v);
  const gps = [];
  let lagged = 0;
  for (let t = 0, i = 0; t <= END; t += 1000, i++) {
    const real = speedAt(t - delay);
    lagged = lagS ? lagged + (real - lagged) * (1 - Math.exp(-1 / lagS)) : real;
    if (dropEvery && i % dropEvery === dropEvery - 1) continue;
    const reading = t <= LAUNCH + delay ? 0 : Math.max(0, lagged + noise(gpsNoise));
    gps.push({ t, kmh: reading * 3.6, accuracy: 5 });
  }
  const crossing = truth.find((p) => p.v >= 100 / 3.6);
  return { motion, gps, trueSeconds: (crossing.t - LAUNCH) / 1000 };
}

// The method the app used before this analysis: motion launch, then GPS speed alone.
function currentMethod(run) {
  const timer = new LaunchTimer(TARGET);
  const events = [
    ...run.motion.map((s) => ({ t: s.t, motion: s })),
    ...run.gps.map((g) => ({ t: g.t, gps: g })),
  ].sort((a, b) => a.t - b.t);
  for (const e of events) {
    if (e.gps) timer.onSpeed(e.t, e.gps.kmh);
    else timer.onMotion(e.t, e.t >= LAUNCH ? trueAccel(e.t) : 0);
  }
  return timer.results[0].seconds;
}

const analyze = (run) => analyzeRun({ motion: run.motion, gps: run.gps, approxLaunchMs: LAUNCH + 20, targets: TARGET });

for (const delay of [0, 500, 1000, 1500]) {
  test(`recovers the true time with ${delay} ms of GPS delay on a tilted phone`, () => {
    const run = simulate({ delay });
    const result = analyze(run);
    const error = Math.abs(result.targets[0].seconds - run.trueSeconds);
    assert.notStrictEqual(result.quality, "rejected");
    assert.ok(error < 0.15, `error ${error.toFixed(3)} s`);
    assert.ok(Math.abs(result.delayMs - delay) < 200, `found ${result.delayMs} ms`);
    if (delay >= 500) assert.ok(error < Math.abs(currentMethod(run) - run.trueSeconds));
  });
}

test("accuracy holds across noise seeds, smoothing, dropped fixes and a slow sensor", () => {
  const cases = [
    ...[1, 2, 3, 4, 5, 6].map((seed) => ({ seed, delay: 700, gpsNoise: 0.3 })),
    { delay: 300, lagS: 0.7 },
    { delay: 600, dropEvery: 7 },
    { delay: 600, motionHz: 20 },
  ];
  for (const options of cases) {
    const run = simulate(options);
    const result = analyze(run);
    const error = Math.abs(result.targets[0].seconds - run.trueSeconds);
    assert.notStrictEqual(result.quality, "rejected", JSON.stringify(options));
    assert.ok(error < 0.25, `${JSON.stringify(options)} error ${error.toFixed(3)} s`);
  }
});

test("reported range covers the actual error in simulated runs", () => {
  for (const seed of [11, 12, 13, 14, 15]) {
    const run = simulate({ seed, delay: 800, gpsNoise: 0.3 });
    const { seconds, plusMinus } = analyze(run).targets[0];
    assert.ok(Math.abs(seconds - run.trueSeconds) <= plusMinus, `seed ${seed}`);
  }
});

test("bad motion data still gives a time from GPS, at a lower grade", () => {
  const options = (motion) => ({ motion, gps: base.gps, approxLaunchMs: LAUNCH + 20, targets: TARGET });
  const base = simulate({ delay: 500 });
  const cases = {
    bumpy: analyzeRun({ ...options(simulate({ delay: 500, bumpy: true }).motion) }),
    noWait: analyzeRun(options(base.motion.filter((s) => s.t > LAUNCH - 1000))),
    noMotion: analyzeRun(options([])),
  };
  for (const [name, result] of Object.entries(cases)) {
    assert.strictEqual(result.quality, "fair", name);
    assert.strictEqual(result.delaySource, "typical", name);
    const error = Math.abs(result.targets[0].seconds - base.trueSeconds);
    assert.ok(error < 0.5, `${name} off by ${error.toFixed(2)} s`);
    assert.ok(result.targets[0].plusMinus >= 0.4, name);
  }
});

test("no motion launch at all still times the run from GPS", () => {
  const run = simulate({ delay: 500 });
  const start = run.gps.find((g) => g.kmh >= 3).t;
  const result = analyzeRun({ motion: [], gps: run.gps, approxLaunchMs: null, gpsStartMs: start, targets: TARGET });
  assert.strictEqual(result.launchSource, "gps");
  assert.ok(Math.abs(result.targets[0].seconds - run.trueSeconds) < 0.5, `${result.targets[0].seconds} vs ${run.trueSeconds}`);
});

test("a GPS dropout leaves out later times instead of rejecting the run", () => {
  const run = simulate({ delay: 500 });
  const gap = run.gps.filter((g) => g.t < LAUNCH + 5000 || g.t > LAUNCH + 10000);
  const result = analyzeRun({
    motion: run.motion,
    gps: gap,
    approxLaunchMs: LAUNCH + 20,
    targets: [{ label: "0-30", kmh: 30 }, { label: "0-100", kmh: 100 }],
  });
  assert.notStrictEqual(result.quality, "rejected");
  assert.deepStrictEqual(result.targets.map((t) => t.label), ["0-30"]);
  assert.ok(result.reasons.some((r) => /dropped out/.test(r)));
});

test("stop-and-go speed from the real 40 s crawl gives no misleading 0-60", () => {
  const speeds = [0, 0, 0, 0, 0, 0, 0, 0, 3, 7, 9, 10, 10, 9, 9, 8, 8, 12, 18, 22, 25, 27, 28, 28, 27, 25, 23, 20, 17, 19, 23, 28, 33, 38, 42, 46, 49, 51, 53, 55, 57, 58, 58, 59, 59, 60, 61, 62, 64, 65, 69];
  const gps = speeds.map((kmh, i) => ({ t: i * 1000, kmh, accuracy: 4 }));
  const result = analyzeRun({ motion: [], gps, approxLaunchMs: null, gpsStartMs: 8000, targets: [{ label: "0-60", kmh: 60 }] });
  assert.deepStrictEqual(result.targets, []);
  assert.ok(result.reasons.some((r) => /Speed dropped/.test(r)), result.reasons.join());
});

test("gear-change dips don't count as a slowdown", () => {
  const gps = [0, 0, 0, 0, 5, 20, 40, 60, 58, 70, 90, 100, 110, 80, 60].map((kmh, i) => ({ t: i * 1000, kmh, accuracy: 4 }));
  const result = analyzeRun({ motion: [], gps, approxLaunchMs: null, gpsStartMs: 4000, targets: [{ label: "0-100", kmh: 100 }] });
  assert.strictEqual(result.targets.length, 1);
});

test("never reports a target GPS did not reach", () => {
  const run = simulate();
  const result = analyzeRun({ motion: run.motion, gps: run.gps, approxLaunchMs: LAUNCH + 20, targets: [{ label: "0-300", kmh: 300 }] });
  assert.strictEqual(result.targets.length, 0);
});

test("median handles odd and even counts", () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 2, 3]), 2.5);
});

// --- GPS hardening ---
const fixAt = (t, lat, speedMs = null, accuracy = 5) => ({ t, lat, lon: 18.5, accuracy, speedMs });

test("a reported speed is always used first", () => {
  assert.deepStrictEqual(resolveSpeed(fixAt(1000, -33.9, 10), null, false), { kmh: 36, source: "gps" });
});

test("no speed, no movement and a quiet phone counts as stopped", () => {
  assert.deepStrictEqual(resolveSpeed(fixAt(2000, -33.9), fixAt(1000, -33.9), true), { kmh: 0, source: "still" });
});

test("no speed and a moving phone stays unknown rather than claiming zero", () => {
  assert.strictEqual(resolveSpeed(fixAt(2000, -33.9), fixAt(1000, -33.9), false).source, "none");
});

test("speed is derived from position only when movement beats GPS noise", () => {
  // 0.00025 degrees of latitude is about 27.8 m, so about 100 km/h over one second.
  const derived = resolveSpeed(fixAt(2000, -33.90025), fixAt(1000, -33.9), false);
  assert.strictEqual(derived.source, "position");
  assert.ok(Math.abs(derived.kmh - 100) < 1);
  // A quiet phone must not hide real movement during a smooth cruise.
  assert.strictEqual(resolveSpeed(fixAt(2000, -33.90025), fixAt(1000, -33.9), true).source, "position");
  // The same movement with poor accuracy can't be trusted.
  const poor = resolveSpeed(fixAt(2000, -33.90025, null, 20), fixAt(1000, -33.9, null, 20), false);
  assert.strictEqual(poor.source, "none");
});

test("stale or repeated fixes give no derived speed", () => {
  assert.strictEqual(resolveSpeed(fixAt(9000, -33.90025), fixAt(1000, -33.9), false).source, "none");
  assert.strictEqual(resolveSpeed(fixAt(1000, -33.90025), fixAt(1000, -33.9), false).source, "none");
});

test("speedless fixes while parked keep the timer armed, unlike before", () => {
  const timer = new LaunchTimer(TARGET);
  let previous = null;
  for (let t = 0; t <= 8000; t += 1000) {
    const fix = fixAt(t, -33.9, t < 1000 ? 0 : null);
    const speed = resolveSpeed(fix, previous, true);
    previous = fix;
    timer.onSpeed(t, speed.kmh);
  }
  assert.strictEqual(timer.armed, true);
});

test("motion quiet needs enough recent, calm samples", () => {
  const calm = Array.from({ length: 60 }, (_, i) => ({ t: 1000 + i * 16, x: 0, y: 0.01 * (i % 2), z: 9.8 }));
  assert.strictEqual(motionIsQuiet(calm, 1960), true);
  assert.strictEqual(motionIsQuiet(calm, 9000), false);
  const shaken = calm.map((s, i) => ({ ...s, x: i % 2 ? 3 : -3 }));
  assert.strictEqual(motionIsQuiet(shaken, 1960), false);
});

test("GPS health reports rate, gaps and missing speed, and ignores repeats", () => {
  const health = new GpsHealth();
  assert.strictEqual(health.record({ t: 1000, now: 1100, speedMissing: false }), true);
  assert.strictEqual(health.record({ t: 2000, now: 2100, speedMissing: true }), true);
  assert.strictEqual(health.record({ t: 2000, now: 2150, speedMissing: true }), false);
  assert.strictEqual(health.record({ t: 5000, now: 5100, speedMissing: false }), true);
  const summary = health.summary();
  assert.strictEqual(summary.fixes, 3);
  assert.strictEqual(summary.missingSpeedPct, 33);
  assert.strictEqual(summary.duplicates, 1);
  assert.strictEqual(summary.maxGapMs, 3000);
  assert.strictEqual(summary.hz, 0.5);
  assert.strictEqual(summary.medianAgeMs, 100);
});

// --- Voice callouts ---
test("each speed is announced once per run, in order", () => {
  const callouts = new SpeedCallouts([60, 100, 200]);
  const heard = [10, 59, 61, 80, 99, 101, 150, 201, 210].map((kmh) => callouts.update(kmh, 1000));
  assert.deepStrictEqual(heard.filter(Boolean), [60, 100, 200]);
});

test("normal driving with no run stays silent", () => {
  const callouts = new SpeedCallouts([60, 100]);
  assert.deepStrictEqual([50, 70, 120].map((kmh) => callouts.update(kmh, null)), [null, null, null]);
});

test("dipping below a speed and returning does not repeat it", () => {
  const callouts = new SpeedCallouts([60]);
  assert.deepStrictEqual([65, 50, 65].map((kmh) => callouts.update(kmh, 1000)), [60, null, null]);
});

test("a new run announces again", () => {
  const callouts = new SpeedCallouts([60]);
  assert.strictEqual(callouts.update(65, 1000), 60);
  callouts.update(0, null);
  assert.strictEqual(callouts.update(65, 9000), 60);
});

test("a GPS jump past several speeds only announces the highest", () => {
  const callouts = new SpeedCallouts([60, 100]);
  assert.strictEqual(callouts.update(105, 1000), 100);
  assert.strictEqual(callouts.update(110, 1000), null);
});

// --- Lessons from the first real run ---
test("a phone still settling early in the window can still calibrate", () => {
  const run = simulate({ delay: 500 });
  const motion = run.motion.map((s) => (s.t > LAUNCH - 5000 && s.t < LAUNCH - 3200
    ? { ...s, x: s.x + 2 * Math.sin(s.t / 90), y: s.y + 2 * Math.cos(s.t / 70) }
    : s));
  const result = analyzeRun({ motion, gps: run.gps, approxLaunchMs: LAUNCH + 20, targets: TARGET });
  assert.notStrictEqual(result.quality, "rejected", result.reasons.join());
  assert.ok(Math.abs(result.targets[0].seconds - run.trueSeconds) < 0.2);
});

test("a phone rotated during the run is rejected instead of giving a false time", () => {
  const run = simulate({ delay: 500 });
  // Numbers shaped like the real run: gravity swings about 70 degrees, 2.5 s after launch.
  const motion = run.motion.map((s) => (s.t > LAUNCH + 2500
    ? { ...s, x: s.x + 9.81 * (-0.2 - 0.58), y: s.y + 9.81 * (0.9 - 0.14), z: s.z + 9.81 * (0.38 - 0.8) }
    : s));
  const result = analyzeRun({ motion, gps: run.gps, approxLaunchMs: LAUNCH + 20, targets: TARGET });
  assert.strictEqual(result.quality, "fair");
  assert.ok(result.reasons.some((r) => /moved during the run/.test(r)), result.reasons.join());
  assert.strictEqual(result.delaySource, "typical");
  assert.ok(Math.abs(result.targets[0].seconds - run.trueSeconds) < 0.4, `${result.targets[0].seconds}`);
});

test("a hard launch on a tilted phone is not mistaken for phone rotation", () => {
  const run = simulate({ delay: 0 });
  // Adds about 1 g of forward acceleration on the simulated phone's forward axis for 3 s.
  const forward = [0.8, 0.1, -0.59];
  const motion = run.motion.map((s) => (s.t > LAUNCH && s.t < LAUNCH + 3000
    ? { ...s, x: s.x + 9.81 * forward[0], y: s.y + 9.81 * forward[1], z: s.z + 9.81 * forward[2] }
    : s));
  const result = analyzeRun({ motion, gps: run.gps, approxLaunchMs: LAUNCH + 20, targets: TARGET });
  assert.ok(!/moved during the run/.test(result.reasons.join()), result.reasons.join());
});

test("motion rate uses the real elapsed time, not a fixed minute", () => {
  // The logged 2.4 Hz came from about 2.4 s of 60 Hz data divided by a full 60 s.
  assert.strictEqual(rateHz(144, 2400), 60);
  assert.strictEqual(rateHz(3600, 60000), 60);
  assert.strictEqual(rateHz(5, 100), null);
});

// --- Update prompt ---
test("only a genuinely newer version counts as an update", () => {
  assert.strictEqual(isNewerVersion("0.6.2", "0.6.3"), true);
  assert.strictEqual(isNewerVersion("0.6.2", "0.10.0"), true);
  assert.strictEqual(isNewerVersion("0.6.2", "1.0.0"), true);
  assert.strictEqual(isNewerVersion("0.6.2", "0.6.2"), false);
  assert.strictEqual(isNewerVersion("0.6.2", "0.6.1"), false);
  assert.strictEqual(isNewerVersion("0.6.2", "garbage"), false);
  assert.strictEqual(isNewerVersion("0.6.2", undefined), false);
});

test("version.json matches the page, or users would be prompted forever", () => {
  const fs = require("fs");
  const path = require("path");
  const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8"));
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.strictEqual(html.match(/APP_VERSION = "([^"]+)"/)[1], version);
});

// --- Gentle launches, from a real 0-61 km/h pull-away taking about 11 s ---
function gentleRun({ accel = 1.5, delay = 800, launch = 10000, end = 24000, seed = 3 } = {}) {
  const noise = randomSource(seed);
  const forward = [0.8, 0.1, -0.59];
  const up = [0.58, 0.14, 0.8];
  const motion = [];
  for (let t = 0; t <= end; t += 1000 / 60) {
    const a = t >= launch ? accel : 0;
    motion.push({
      t,
      x: a * forward[0] + 9.81 * up[0] + noise(0.15),
      y: a * forward[1] + 9.81 * up[1] + noise(0.15),
      z: a * forward[2] + 9.81 * up[2] + noise(0.15),
    });
  }
  const gps = [];
  for (let t = 0; t <= end; t += 1000) {
    const moving = Math.max(0, (t - delay - launch) / 1000);
    gps.push({ t, kmh: moving * accel * 3.6, accuracy: 3 });
  }
  const timer = new LaunchTimer([{ label: "0-60", kmh: 60 }]);
  gps.forEach((g) => timer.onSpeed(g.t, g.kmh));
  return { motion, gps, launch, accel, gpsStart: timer.startMs };
}

test("a gentle pull-away the live trigger missed is still found and timed", () => {
  const run = gentleRun();
  assert.ok(run.gpsStart > run.launch + 1000, "GPS start should lag the real launch");
  const found = findGentleLaunch(run.motion, run.gps, run.gpsStart).launchMs;
  assert.ok(Math.abs(found - run.launch) < 250, `found ${found - run.launch} ms from launch`);

  const result = analyzeRun({ motion: run.motion, gps: run.gps, approxLaunchMs: found, targets: [{ label: "0-60", kmh: 60 }] });
  assert.notStrictEqual(result.quality, "rejected", result.reasons.join());
  const trueSeconds = (60 / 3.6) / run.accel;
  const error = Math.abs(result.targets[0].seconds - trueSeconds);
  assert.ok(error < 0.3, `error ${error.toFixed(3)} s, delay ${result.delayMs} ms`);
});

test("a slow creep long before GPS start is still found, from the real 0.6.3 failure", () => {
  // GPS only saw movement about 3.5 s after the car began to pull away.
  const run = gentleRun();
  const found = findGentleLaunch(run.motion, run.gps, run.launch + 3500);
  assert.strictEqual(found.reason, null);
  assert.ok(Math.abs(found.launchMs - run.launch) < 250, `off by ${found.launchMs - run.launch} ms`);
});

test("movement far too long before GPS start is declined as likely handling", () => {
  const run = gentleRun();
  const found = findGentleLaunch(run.motion, run.gps, run.launch + 7000);
  assert.strictEqual(found.launchMs, null);
  assert.match(found.reason, /too long before GPS/);
});

test("a phone that never settled is declined with a reason", () => {
  const run = gentleRun();
  const shaken = run.motion.map((s) => ({ ...s, x: s.x + 3 * Math.sin(s.t / 40) }));
  const found = findGentleLaunch(shaken, run.gps, run.gpsStart);
  assert.strictEqual(found.launchMs, null);
  assert.match(found.reason, /never calm/);
});

test("no motion data gives no gentle launch", () => {
  assert.strictEqual(findGentleLaunch([], [{ t: 9000, kmh: 0 }], 10000).launchMs, null);
});

test("a parked car with vibration has no gentle launch", () => {
  const run = gentleRun({ accel: 0 });
  const found = findGentleLaunch(run.motion, run.gps, 12000);
  assert.strictEqual(found.launchMs, null);
  assert.match(found.reason, /no acceleration/);
});

test("smooth acceleration is not mistaken for standing still", () => {
  // No GPS reading shows the car stopped, so the steady, vibration-free pull can't be a reference.
  const run = gentleRun();
  const moving = run.gps.map((g) => ({ ...g, kmh: g.kmh + 20 }));
  const found = findGentleLaunch(run.motion, moving, run.launch + 5000);
  assert.strictEqual(found.launchMs, null);
  assert.match(found.reason, /never showed the car stopped/);
});

// --- Real field data, 7:19 and 7:20 PM runs (GPS readings relative to the live launch) ---
const REAL_RUN_GPS = [[-5384,0],[-4384,0],[-3384,0],[-2383,0],[-1383,0],[-383,0],[617,2.08],[1617,10.12],[2617,19.43],
  [3617,29.38],[4617,33.82],[5617,43.36],[6617,53.59],[7617,60.16],[8617,63.68],[9617,74.35],[10617,83.67],[11617,84.53],
  [12617,88.84],[13617,87.82],[14617,89.86],[15617,88.46],[16617,91.80],[17617,96.68],[18617,96.16],[19617,93.72],
  [20617,90.89],[21617,89.15],[22617,87.04],[23617,85.81],[24617,83.44],[25617,83.40],[26617,81.94],[27617,80.79]]
  .map(([t, kmh]) => ({ t, kmh, accuracy: 5 }));

function steadyMotion(from, to) {
  const motion = [];
  for (let t = from; t <= to; t += 1000 / 60) motion.push({ t, x: 0.05 * Math.sin(t), y: -1 + 0.05 * Math.cos(t), z: -9.8 });
  return motion;
}

test("a car that never fully stopped is told so, using the real 7:20 PM readings", () => {
  const gps = [[-5167,25.43],[-4167,16.85],[-3167,10.2],[-2167,7.8],[-1170,5.54],[-170,1.82],[830,1.44],[1830,9.7],[2830,15.75],[3830,18.32]]
    .map(([t, kmh]) => ({ t, kmh, accuracy: 4 }));
  const result = analyzeRun({ motion: steadyMotion(-6000, 4000), gps, approxLaunchMs: 0, targets: TARGET });
  assert.strictEqual(result.quality, "rejected");
  assert.match(result.reasons[0], /didn't fully stop/);
  assert.deepStrictEqual(result.distances, []);
});

test("launch detection follows the trend through vibration", () => {
  // Accel builds over 300 ms from 6000, with road-like vibration on top.
  const noise = randomSource(5);
  const motion = [];
  for (let t = 0; t <= 14000; t += 1000 / 60) {
    const a = t < 6000 ? 0 : Math.min(3, ((t - 6000) / 300) * 3);
    motion.push({ t, x: noise(0.2), y: -1 - a + noise(0.25), z: -9.8 + noise(0.3) });
  }
  const gps = [];
  for (let t = 0; t <= 14000; t += 1000) {
    gps.push({ t, kmh: Math.max(0, (t - 6000 - 700) / 1000) * 3 * 3.6, accuracy: 4 });
  }
  const result = analyzeRun({ motion, gps, approxLaunchMs: 6150, targets: [{ label: "0-60", kmh: 60 }] });
  assert.notStrictEqual(result.quality, "rejected", result.reasons.join());
  assert.ok(Math.abs(result.launchMs - 6000) < 150, `launch off by ${result.launchMs - 6000} ms`);
});

test("a large motion correction and a barely reached target are not graded good", () => {
  const run = simulate({ delay: 500 });
  const reduced = run.motion.map((s) => s); // Keeps the original sensor data intact.
  const peak = Math.max(...run.gps.map((g) => g.kmh));
  const gps = run.gps.map((g) => ({ ...g, kmh: g.kmh * 0.85 }));
  const result = analyzeRun({ motion: reduced, gps, approxLaunchMs: LAUNCH + 20, targets: [{ label: "top", kmh: peak * 0.85 - 1 }] });
  assert.strictEqual(result.quality, "fair");
  assert.ok(result.reasons.some((r) => /large correction/.test(r)), result.reasons.join());
  assert.ok(result.reasons.some((r) => /Only just reached/.test(r)), result.reasons.join());
});

// --- Distance timing ---
const DISTANCES = [{ label: "100 m", meters: 100 }, { label: "400 m", meters: 400 }];

test("distance and trap speed match a known constant-acceleration run", () => {
  const run = gentleRun({ accel: 3, delay: 800, launch: 10000, end: 30000 });
  const result = analyzeRun({ motion: run.motion, gps: run.gps, approxLaunchMs: 10020, targets: [], distanceTargets: DISTANCES });
  assert.notStrictEqual(result.quality, "rejected", result.reasons.join());
  for (const [i, meters] of [100, 400].entries()) {
    const trueSeconds = Math.sqrt((2 * meters) / 3);
    const trueSpeed = 3 * trueSeconds * 3.6;
    const found = result.distances[i];
    assert.ok(Math.abs(found.seconds - trueSeconds) < 0.25, `${meters} m: ${found.seconds} vs ${trueSeconds}`);
    assert.ok(Math.abs(found.trapKmh - trueSpeed) < 3, `${meters} m trap: ${found.trapKmh} vs ${trueSpeed}`);
    assert.strictEqual(found.liftedOff, false);
    assert.ok(found.plusMinus >= 0.1);
  }
});

test("distance timing on real GPS gives the hand-checked 400 m, flagged as lifted", () => {
  // Motion rebuilt from the real speed curve, 620 ms earlier as the app measured on this run.
  // GPS alone decides the distance result; this only gives the analysis a launch and a fit.
  const pull = (t) => {
    const later = t + 620;
    for (let i = 1; i < REAL_RUN_GPS.length; i++) {
      const a = REAL_RUN_GPS[i - 1];
      const b = REAL_RUN_GPS[i];
      if (later >= a.t && later < b.t) return ((b.kmh - a.kmh) / 3.6) / ((b.t - a.t) / 1000);
    }
    return 0;
  };
  const driven = steadyMotion(-6000, 27000).map((s) => ({ ...s, y: s.y - pull(s.t) }));
  const result = analyzeRun({
    motion: driven,
    gps: REAL_RUN_GPS,
    approxLaunchMs: 0,
    targets: [],
    distanceTargets: [{ label: "400 m", meters: 400 }, { label: "800 m", meters: 800 }],
  });
  assert.notStrictEqual(result.quality, "rejected", result.reasons.join());
  assert.strictEqual(result.distances.length, 1, "800 m was never covered, so it must not appear");
  const [found] = result.distances;
  const reportedTime = found.seconds + result.launchMs / 1000 + result.delayMs / 1000;
  assert.ok(Math.abs(reportedTime - 21.7) < 0.6, `400 m at reported ${reportedTime.toFixed(2)} s`);
  assert.ok(found.trapKmh > 85 && found.trapKmh < 96, `trap ${found.trapKmh}`);
  assert.strictEqual(found.liftedOff, true);
});

test("a GPS dropout ends distance timing rather than guessing across the gap", () => {
  const run = gentleRun({ accel: 3, delay: 0, launch: 10000, end: 26000 });
  const gappy = run.gps.filter((g) => g.t < 14000 || g.t > 20000);
  const result = analyzeRun({
    motion: run.motion,
    gps: gappy,
    approxLaunchMs: 10020,
    targets: [],
    distanceTargets: DISTANCES,
  });
  assert.ok(result.distances.every((d) => d.meters < 400));
});

// --- Android field logs ---
test("GPS restarts wait longer each time, up to a limit", () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map(gpsRestartDelayMs), [8000, 16000, 32000, 60000, 60000, 60000]);
});

test("the 86 s outage would now see far fewer restarts", () => {
  let restarts = 0;
  for (let waited = gpsRestartDelayMs(0); waited <= 86000; waited += gpsRestartDelayMs(restarts)) restarts++;
  assert.ok(restarts <= 4, `${restarts} restarts`);
});

test("old or missing motion data counts as no motion", () => {
  assert.strictEqual(hasRecentMotion([], 1000), false);
  assert.strictEqual(hasRecentMotion([{ t: 1000 }], 2000), true);
  assert.strictEqual(hasRecentMotion([{ t: 1000 }], 5000), false);
});

// --- Rolling runs, using real speeds from two drives (one reading a second) ---
const REAL_PULL_A = [23, 23, 29, 33, 35, 42, 48, 50, 56, 60, 68, 72, 81, 90, 99, 103, 100, 96, 92, 87, 82, 78];
const REAL_PULL_B = [19, 16, 13, 12, 11, 9, 8, 7, 7, 6, 5, 8, 10, 15, 18, 20, 23, 27, 32, 37, 41, 44, 48, 51, 53, 57, 66, 77, 87, 96, 103, 102, 100, 97, 94, 90, 86, 82];
const SPLITS_TEST = [
  { label: "60-100", fromKmh: 60, toKmh: 100 },
  { label: "100-150", fromKmh: 100, toKmh: 150 },
];

function runPull(speeds) {
  const tracker = new PullTracker();
  const gps = speeds.map((kmh, i) => ({ t: i * 1000, kmh }));
  let pull = null;
  for (const g of gps) pull = pull || tracker.update(g.t, g.kmh);
  return { gps, pull };
}

test("a real rolling pull gives its 60-100 split, and no split it never reached", () => {
  const { gps, pull } = runPull(REAL_PULL_A);
  assert.strictEqual(pull.peakKmh, 103);
  const { splits } = findSplits(gps, pull, SPLITS_TEST);
  assert.strictEqual(splits.length, 1);
  assert.ok(Math.abs(splits[0].seconds - 5.25) < 0.05, `${splits[0].seconds}`);
  assert.ok(splits[0].plusMinus >= 0.1);
});

test("two real drives produce different comparable times", () => {
  const a = runPull(REAL_PULL_A);
  const b = runPull(REAL_PULL_B);
  const splitB = findSplits(b.gps, b.pull, SPLITS_TEST).splits[0].seconds;
  assert.ok(Math.abs(splitB - 4.24) < 0.1, `${splitB}`);
  assert.ok(splitB < findSplits(a.gps, a.pull, SPLITS_TEST).splits[0].seconds);
});

test("GPS delay doesn't change a split", () => {
  const { gps, pull } = runPull(REAL_PULL_A);
  const shifted = gps.map((g) => ({ ...g, t: g.t + 700 }));
  const movedPull = { ...pull, startMs: pull.startMs + 700, peakMs: pull.peakMs + 700 };
  assert.strictEqual(findSplits(shifted, movedPull, SPLITS_TEST).splits[0].seconds, findSplits(gps, pull, SPLITS_TEST).splits[0].seconds);
});

test("small ups and downs and cruising aren't counted as pulls", () => {
  assert.strictEqual(runPull([50, 55, 60, 62, 58, 55, 50, 44, 40, 45, 50, 55, 60, 60, 60]).pull, null);
});

test("lifting during a split drops only that split", () => {
  const speeds = [40, 50, 60, 70, 80, 72, 68, 75, 90, 100, 110, 120, 105, 90];
  const { gps, pull } = runPull(speeds);
  const { splits } = findSplits(gps, pull, [
    { label: "60-100", fromKmh: 60, toKmh: 100 },
    { label: "80-110", fromKmh: 80, toKmh: 110 },
  ]);
  assert.deepStrictEqual(splits.map((x) => x.label), ["80-110"]);
});

test("a gradual launch with engine vibration is found near its true start", () => {
  // Modelled on the real gradual pull-away: 0.45 m/s2 of idle noise and a slow ramp.
  const noise = randomSource(4);
  const motion = [];
  for (let t = 0; t <= 22000; t += 1000 / 60) {
    const a = t < 12000 ? 0 : Math.min(1.4, ((t - 12000) / 4000) * 1.4);
    motion.push({ t, x: 0.3 + noise(0.45), y: -1 - a + noise(0.45), z: -9.5 + noise(0.45) });
  }
  const gps = [];
  let v = 0;
  for (let t = 0; t <= 22000; t += 1000) {
    const moving = Math.max(0, t - 700 - 12000) / 1000;
    v = moving <= 4 ? 0.175 * moving * moving : 2.8 + 1.4 * (moving - 4);
    gps.push({ t, kmh: v * 3.6, accuracy: 4 });
  }
  const gpsStart = gps.find((g) => g.kmh >= 3).t;
  const found = findGentleLaunch(motion, gps.filter((g) => g.t <= gpsStart), gpsStart);
  assert.strictEqual(found.reason, null);
  assert.ok(Math.abs(found.launchMs - 12000) < 1200, `off by ${found.launchMs - 12000} ms`);
});

test("a long cruise before speeding up again gives no misleading 0-100", () => {
  const cruise = Array(20).fill(60);
  const speeds = [0, 0, 0, 0, 5, 15, 30, 45, 58, ...cruise, 62, 70, 85, 100, 115, 120, 100, 80];
  const gps = speeds.map((kmh, i) => ({ t: i * 1000, kmh, accuracy: 4 }));
  const result = analyzeRun({
    motion: [],
    gps,
    approxLaunchMs: null,
    gpsStartMs: 4000,
    targets: [{ label: "0-40", kmh: 40 }, { label: "0-100", kmh: 100 }],
  });
  assert.deepStrictEqual(result.targets.map((t) => t.label), ["0-40"]);
  assert.ok(result.reasons.some((r) => /stopped accelerating/.test(r)), result.reasons.join());
});

// --- Roll races ---
// Holds a speed, then pulls at a steady rate. Readings arrive once a second, delayMs late.
function rollDrive({ held = 40, holdMs = 6000, accel = 4, delayMs = 500, withMotion = true, peakKmh = 160, jitter = 0.4 } = {}) {
  const noise = randomSource(9);
  const goMs = 20000 + holdMs;
  const speedAt = (t) => {
    if (t < goMs - holdMs) return Math.max(0, held + ((goMs - holdMs - t) / 1000) * -2);
    if (t < goMs) return held;
    return Math.min(peakKmh, held + ((t - goMs) / 1000) * accel * 3.6);
  };
  const gps = [];
  const end = goMs + ((peakKmh - held) / (accel * 3.6)) * 1000 + 5000;
  for (let t = 10000; t <= end; t += 1000) {
    const peakTime = goMs + ((peakKmh - held) / (accel * 3.6)) * 1000;
    const real = t - delayMs > peakTime + 1000 ? peakKmh - ((t - delayMs - peakTime) / 1000) * 20 : speedAt(t - delayMs);
    gps.push({ t, kmh: Math.max(0, real + noise(jitter)) });
  }
  const motion = [];
  if (withMotion) {
    for (let t = 10000; t <= end; t += 1000 / 60) {
      const a = t >= goMs && speedAt(t) < peakKmh ? accel : 0;
      motion.push({ t, x: 0.3 + noise(0.5), y: -1 - a + noise(0.5), z: -9.7 + noise(0.5) });
    }
  }
  const tracker = new PullTracker();
  let pull = null;
  for (const g of gps) pull = pull || tracker.update(g.t, g.kmh);
  return { gps, motion, pull, goMs, trueTime: (kmh) => (kmh - held) / (accel * 3.6) };
}

test("a hold then a hard pull is recognised and named as a 40 roll", () => {
  const drive = rollDrive();
  const roll = findRoll(drive.gps, drive.motion, drive.pull);
  assert.strictEqual(roll.name, "40 roll");
  assert.strictEqual(roll.goSource, "motion");
  assert.ok(Math.abs(roll.heldKmh - 40) < 1);
  assert.ok(Math.abs(roll.goMs - drive.goMs) < 300, `go off by ${roll.goMs - drive.goMs} ms`);
  assert.deepStrictEqual(roll.times.map((t) => t.label), ["40-60 km/h", "40-80 km/h", "40-100 km/h", "40-120 km/h", "40-150 km/h"]);
  for (const [i, kmh] of [60, 80, 100, 120, 150].entries()) {
    const error = Math.abs(roll.times[i].seconds - drive.trueTime(kmh));
    assert.ok(error < 0.3, `40-${kmh} off by ${error.toFixed(2)} s`);
  }
});

test("standard rolls at other speeds get their own names and targets", () => {
  for (const held of [60, 80, 100, 120]) {
    const drive = rollDrive({ held, peakKmh: held + 90 });
    const roll = findRoll(drive.gps, drive.motion, drive.pull);
    assert.strictEqual(roll.name, `${held} roll`);
    assert.ok(roll.times.every((t) => t.label.startsWith(`${held}-`)), JSON.stringify(roll.times));
  }
});

test("without motion data a roll is timed from GPS, and delay doesn't skew it", () => {
  for (const delayMs of [0, 500, 1000]) {
    const drive = rollDrive({ withMotion: false, delayMs });
    const roll = findRoll(drive.gps, drive.motion, drive.pull);
    assert.strictEqual(roll.goSource, "gps");
    assert.strictEqual(roll.quality, "fair");
    const to100 = roll.times.find((t) => t.label === "40-100 km/h");
    const error = Math.abs(to100.seconds - drive.trueTime(100));
    assert.ok(error < 0.5, `delay ${delayMs}: off by ${error.toFixed(2)} s`);
    assert.ok(roll.times[0].plusMinus >= 0.4);
  }
});

test("a held speed away from standard rolls is labelled as custom", () => {
  assert.deepStrictEqual(rollName(41), { startKmh: 40, standard: true });
  assert.deepStrictEqual(rollName(50), { startKmh: 50, standard: false });
  const drive = rollDrive({ held: 50, peakKmh: 140 });
  const roll = findRoll(drive.gps, drive.motion, drive.pull);
  assert.strictEqual(roll.name, "50 km/h roll");
  assert.strictEqual(roll.standard, false);
  assert.strictEqual(roll.quality, "fair");
});

test("things that aren't rolls aren't called rolls", () => {
  const brief = rollDrive({ holdMs: 1000 });
  assert.strictEqual(findRoll(brief.gps, brief.motion, brief.pull), null, "too short a hold");
  const gentle = rollDrive({ accel: 0.7, peakKmh: 90 });
  assert.strictEqual(findRoll(gentle.gps, gentle.motion, gentle.pull), null, "gently speeding up");
  for (const speeds of [REAL_PULL_A, REAL_PULL_B]) {
    const { gps, pull } = runPull(speeds);
    assert.strictEqual(findRoll(gps, [], pull), null, "real pulls with no steady hold");
  }
});

test("roll times stop at a lift, and never claim a speed not reached", () => {
  const speeds = [...Array(8).fill(40), 45, 58, 72, 85, 96, 80, 95, 110, 120, 100, 80];
  const gps = speeds.map((kmh, i) => ({ t: i * 1000, kmh }));
  const tracker = new PullTracker();
  let pull = null;
  for (const g of gps) pull = pull || tracker.update(g.t, g.kmh);
  const roll = findRoll(gps, [], pull);
  assert.ok(roll === null || !roll.times.some((t) => /-150/.test(t.label)));
});

test("roll ready is said once per hold, and not for every speed", () => {
  const watch = new RollReadyWatch();
  const heard = [];
  const say = (t, kmh) => { const r = watch.update(t, kmh); if (r !== null) heard.push(r); };
  for (let t = 0; t < 8000; t += 1000) say(t, 41);
  assert.deepStrictEqual(heard, [40]);
  for (let t = 8000; t < 12000; t += 1000) say(t, 50 + t / 400);
  for (let t = 12000; t < 18000; t += 1000) say(t, 50);
  assert.deepStrictEqual(heard, [40], "50 isn't a standard roll");
  for (let t = 18000; t < 26000; t += 1000) say(t, 20 + (t - 18000) / 150);
  for (let t = 40000; t < 48000; t += 1000) say(t, 60);
  assert.deepStrictEqual(heard, [40, 60]);
  say(49000, 60);
  assert.deepStrictEqual(heard, [40, 60], "no repeat while holding");
});

test("a 20 km/h roll is a standard roll, with low targets", () => {
  assert.deepStrictEqual(rollName(21), { startKmh: 20, standard: true });
  const drive = rollDrive({ held: 20, peakKmh: 130 });
  const roll = findRoll(drive.gps, drive.motion, drive.pull);
  assert.strictEqual(roll.name, "20 roll");
  assert.strictEqual(roll.times[0].label, "20-60 km/h");
  assert.ok(Math.abs(roll.times[0].seconds - drive.trueTime(60)) < 0.3);
});

test("callout numbers are written out as words", () => {
  assert.strictEqual(spokenNumber(20), "twenty");
  assert.strictEqual(spokenNumber(60), "sixty");
  assert.strictEqual(spokenNumber(100), "one hundred");
  assert.strictEqual(spokenNumber(150), "one hundred fifty");
  assert.strictEqual(spokenNumber(400), "four hundred");
  assert.strictEqual(spokenNumber(800), "eight hundred");
});

test("the clearest available English voice is picked, and a choice is respected", () => {
  const voices = [
    { name: "Zarvox", lang: "en-US" },
    { name: "Fred", lang: "en-US" },
    { name: "Thomas", lang: "fr-FR" },
    { name: "Plain", lang: "en-US" },
    { name: "Samantha", lang: "en-US" },
    { name: "Karen (Enhanced)", lang: "en-AU" },
  ];
  assert.strictEqual(pickVoice(voices, null).name, "Karen (Enhanced)");
  assert.strictEqual(pickVoice(voices.slice(0, 5), null).name, "Samantha");
  assert.strictEqual(pickVoice(voices.slice(0, 4), null).name, "Plain");
  assert.strictEqual(pickVoice(voices, "Plain").name, "Plain");
  assert.strictEqual(pickVoice(voices, "Gone").name, "Karen (Enhanced)");
  assert.strictEqual(pickVoice([], null), null);
});

// --- Rolls that begin from a stop ---
function stopThenRoll(holdSeconds) {
  const speedAt = (s) => {
    if (s < 8) return 0;
    if (s < 14) return ((s - 8) * 40) / 6;
    if (s < 14 + holdSeconds) return 40;
    const p = s - 14 - holdSeconds;
    return p < 8 ? 40 + p * 14 : Math.max(0, 152 - (p - 8) * 19);
  };
  const total = 14 + holdSeconds + 16;
  const gps = [];
  for (let s = 0; s < total; s++) gps.push({ t: s * 1000, kmh: Math.max(0, speedAt(s - 0.5)), accuracy: 4 });
  const tracker = new PullTracker();
  let pull = null;
  for (const g of gps) pull = pull || tracker.update(g.t, g.kmh);
  return { gps, pull };
}

for (const hold of [5, 12]) {
  test(`pulling away from a stop and holding ${hold} s counts as a 40 roll, not a slow launch`, () => {
    const { gps, pull } = stopThenRoll(hold);
    const roll = findRoll(gps, [], pull);
    assert.strictEqual(roll.name, "40 roll");
    const outcome = analyzeRun({ motion: [], gps, approxLaunchMs: null, gpsStartMs: 9000, targets: [{ label: "0-100", kmh: 100 }] });
    assert.notStrictEqual(outcome.quality, "rejected");
    assert.strictEqual(chooseRunType({ outcome, roll, pullStartMs: pull.startMs }), "roll");
    const to100 = roll.times.find((t) => t.label === "40-100 km/h");
    assert.ok(Math.abs(to100.seconds - 60 / 14) < 0.5, `${to100.seconds} vs ${60 / 14}`);
  });
}

test("a clean launch with no hold stays a standing start", () => {
  const speeds = [0, 0, 0, 0, 0, 7, 18, 29, 40, 50, 61, 72, 83, 94, 104, 115, 126, 137, 148, 155, 130, 100, 70];
  const gps = speeds.map((kmh, i) => ({ t: i * 1000, kmh, accuracy: 4 }));
  const { pull } = runPull(speeds);
  const roll = findRoll(gps, [], pull);
  const outcome = analyzeRun({ motion: [], gps, approxLaunchMs: null, gpsStartMs: 5000, targets: [{ label: "0-100", kmh: 100 }] });
  assert.strictEqual(roll, null);
  assert.strictEqual(chooseRunType({ outcome, roll, pullStartMs: pull.startMs }), "standing");
});

test("the real 124 km/h launch and the real 7:19 PM run stay standing starts", () => {
  const launch = [0, 0, 0, 0, 0, 0, 0, 0, 18, 35, 52, 62, 72, 82, 92, 100, 107, 113, 119, 121, 124, 118, 105, 85];
  for (const gps of [launch.map((kmh, i) => ({ t: i * 1000, kmh, accuracy: 4 })), REAL_RUN_GPS]) {
    const tracker = new PullTracker();
    let pull = null;
    for (const g of gps) pull = pull || tracker.update(g.t, g.kmh);
    assert.strictEqual(findRoll(gps, [], pull), null);
  }
});

test("a roll with no times to show doesn't replace a valid standing result", () => {
  const outcome = { quality: "good", launchMs: 1000, reasons: [] };
  assert.strictEqual(chooseRunType({ outcome, roll: { times: [] }, pullStartMs: 0 }), "standing");
  assert.strictEqual(chooseRunType({ outcome: null, roll: { times: [] }, pullStartMs: 0 }), "roll");
  assert.strictEqual(chooseRunType({ outcome: { quality: "rejected", reasons: ["x"] }, roll: null, pullStartMs: 0 }), "rolling");
});

const { findFromTimes } = require("./phone-core.js");

test("from-speed mode times from the moment the chosen speed is passed", () => {
  // 0 to 200 km/h at a steady 5 km/h per second, one fix a second.
  const gps = Array.from({ length: 45 }, (_, i) => ({ t: i * 1000, kmh: Math.min(i * 5, 200) }));
  const pull = { startMs: 0, peakMs: 40000, peakKmh: 200 };
  const times = findFromTimes(gps, pull, 60);
  assert.deepStrictEqual(times.map((t) => t.label), ["60-80 km/h", "60-100 km/h", "60-120 km/h", "60-150 km/h", "60-200 km/h"]);
  assert.ok(Math.abs(times[1].seconds - 8) < 0.01);
  assert.ok(Math.abs(findFromTimes(gps, pull, 100).find((t) => t.label === "100-200 km/h").seconds - 20) < 0.01);
});

test("from-speed mode gives nothing when the climb starts above that speed", () => {
  const gps = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, kmh: 70 + i * 5 }));
  assert.deepStrictEqual(findFromTimes(gps, { startMs: 0, peakMs: 9000, peakKmh: 115 }, 60), []);
});
