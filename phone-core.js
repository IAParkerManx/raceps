// Times standing-start runs from phone sensors. The motion sensor marks the launch, because
// it reports far more often than GPS, and GPS speed marks each target. Thresholds are
// starting guesses and need tuning against real runs.
const LAUNCH_MS2 = 1.5; // Roughly 0.15 g, above typical idle vibration.
const LAUNCH_HOLD_MS = 150; // Must be sustained, so a single bump doesn't start a run.
const STILL_KMH = 3;
const FALSE_START_MS = 3000; // Launch with no GPS movement after this long gets discarded.
const MAX_GPS_GAP_MS = 3000; // A longer gap makes interpolation meaningless.
const MIN_RATE_WINDOW_MS = 1000;
const GPS_RESTART_FIRST_MS = 8000;
const GPS_RESTART_MAX_MS = 60000;
const MOTION_RECENT_MS = 1500;

class LaunchTimer {
  constructor(targets) {
    this.targets = targets;
    this.disarm();
  }

  disarm() {
    this.armed = false;
    this.candidateMs = null;
    this.startMs = null;
    this.startSource = null;
    this.previous = null;
    this.results = [];
    this.resultsStartMs = null;
  }

  onMotion(tMs, accelMs2) {
    if (!this.armed || this.startMs !== null) return;
    if (accelMs2 < LAUNCH_MS2) {
      this.candidateMs = null;
    } else if (this.candidateMs === null) {
      this.candidateMs = tMs;
    } else if (tMs - this.candidateMs >= LAUNCH_HOLD_MS) {
      this.startMs = this.candidateMs;
      this.startSource = "motion";
    }
  }

  // Returns any targets reached by this GPS sample.
  onSpeed(tMs, kmh) {
    const previous = this.previous;
    if (previous && tMs - previous.t > MAX_GPS_GAP_MS) {
      this.disarm();
      this.previous = { t: tMs, v: kmh };
      return [];
    }
    this.previous = { t: tMs, v: kmh };

    if (kmh < STILL_KMH) {
      const waiting = this.armed && this.startMs === null;
      const launching = this.startMs !== null && tMs - this.startMs <= FALSE_START_MS;
      if (waiting || launching) return [];
      // Re-arm, keeping the last results on screen until a new run produces one.
      const { results, resultsStartMs } = this;
      this.disarm();
      this.armed = true;
      this.results = results;
      this.resultsStartMs = resultsStartMs;
      this.previous = { t: tMs, v: kmh };
      return [];
    }
    if (!this.armed || !previous) return [];

    const crossing = (level) => previous.t + ((level - previous.v) / (kmh - previous.v)) * (tMs - previous.t);
    if (this.startMs === null) {
      // The motion sensor is blocked or missed the launch, so fall back to GPS (less accurate).
      this.startMs = crossing(STILL_KMH);
      this.startSource = "gps";
    }

    const finished = [];
    for (const target of this.targets) {
      if (previous.v < target.kmh && kmh >= target.kmh) {
        if (this.resultsStartMs !== this.startMs) {
          this.results = [];
          this.resultsStartMs = this.startMs;
        }
        if (this.results.some((r) => r.label === target.label)) continue;
        const result = { label: target.label, seconds: (crossing(target.kmh) - this.startMs) / 1000, source: this.startSource };
        this.results.push(result);
        finished.push(result);
      }
    }
    return finished;
  }
}

// Decides when to announce a speed. Each speed is announced once per run, and only during a
// run from a stop, so normal driving stays silent.
class SpeedCallouts {
  constructor(speeds) {
    this.speeds = [...speeds].sort((a, b) => a - b);
    this.announced = new Set();
    this.runStartMs = null;
  }

  // Returns the speed to announce, or null. If GPS jumps past several, only the highest is
  // returned, because a late callout for a lower speed would be misleading.
  update(kmh, runStartMs) {
    if (runStartMs !== this.runStartMs) {
      this.runStartMs = runStartMs;
      this.announced.clear();
    }
    if (runStartMs === null) return null;
    let callout = null;
    for (const speed of this.speeds) {
      if (kmh >= speed && !this.announced.has(speed)) {
        this.announced.add(speed);
        callout = speed;
      }
    }
    return callout;
  }
}

// Rate over the time actually measured. Returns null for a window too short to mean anything.
function rateHz(count, elapsedMs) {
  return elapsedMs >= MIN_RATE_WINDOW_MS ? Number(((count * 1000) / elapsedMs).toFixed(1)) : null;
}

// Compares "major.minor.patch" versions, so a stale CDN response can't offer a downgrade.
function isNewerVersion(current, latest) {
  const a = String(current).split(".").map(Number);
  const b = String(latest).split(".").map(Number);
  if (b.length !== 3 || b.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

// --- Rolling pulls ---
// Splits between two speeds need no launch point, and GPS delay shifts both ends equally and
// cancels out. So they work for rolling runs, and they are the fairest numbers to compare.
const PULL_MIN_GAIN_KMH = 30;
const PULL_END_DROP_KMH = 15;
const SPLIT_MAX_DIP_KMH = 3;
const SPLIT_SPEED_ERROR_KMH = 0.5;

class PullTracker {
  constructor() {
    this.low = null;
    this.peak = null;
  }

  restart(point) {
    this.low = point;
    this.peak = point;
  }

  // Returns the finished pull once the driver lifts off, otherwise null.
  update(t, kmh) {
    const point = { t, kmh };
    if (!this.low || kmh <= this.low.kmh) {
      this.restart(point);
      return null;
    }
    if (kmh > this.peak.kmh) this.peak = point;
    const gain = this.peak.kmh - this.low.kmh;
    if (kmh >= this.peak.kmh - PULL_END_DROP_KMH && kmh >= STILL_KMH) return null;
    const pull = gain >= PULL_MIN_GAIN_KMH ? { startMs: this.low.t, peakMs: this.peak.t, peakKmh: this.peak.kmh } : null;
    this.restart(point);
    return pull;
  }
}

// Finds each split on the climb to the peak, skipping any the driver lifted during.
function findSplits(gps, pull, splits) {
  const points = gps.filter((g) => g.t >= pull.startMs && g.t <= pull.peakMs);
  let first = points.length - 1;
  while (first > 0 && points[first - 1].kmh <= points[first].kmh + SPLIT_MAX_DIP_KMH) first--;
  const climb = points.slice(first);
  const results = [];
  const crossing = (kmh, fromIndex) => {
    for (let i = fromIndex; i < climb.length; i++) {
      const a = climb[i - 1];
      const b = climb[i];
      if (a.kmh < kmh && b.kmh >= kmh) {
        return {
          index: i,
          t: a.t + ((kmh - a.kmh) / (b.kmh - a.kmh)) * (b.t - a.t),
          accel: ((b.kmh - a.kmh) / 3.6) / Math.max((b.t - a.t) / 1000, 0.1),
        };
      }
    }
    return null;
  };
  for (const split of splits) {
    const start = crossing(split.fromKmh, 1);
    const end = start && crossing(split.toKmh, start.index);
    if (!end) continue;
    let gap = 0;
    for (let i = start.index; i <= end.index; i++) gap = Math.max(gap, climb[i].t - climb[i - 1].t);
    if (gap > MAX_GPS_GAP_MS) continue;
    const speedError = SPLIT_SPEED_ERROR_KMH / 3.6;
    results.push({
      label: split.label,
      seconds: (end.t - start.t) / 1000,
      plusMinus: Math.max(0.1, Math.hypot(speedError / Math.max(start.accel, 0.5), speedError / Math.max(end.accel, 0.5))),
    });
  }
  return { fromKmh: climb.length ? climb[0].kmh : null, splits: results };
}

// Times from the moment speed passes a chosen speed, like a Dragy set to start at 60.
// Both ends come from GPS with the same delay, so the delay cancels out.
const FROM_TARGETS_KMH = [60, 80, 100, 120, 150, 200, 250];
function findFromTimes(gps, pull, startKmh) {
  const splits = FROM_TARGETS_KMH
    .filter((kmh) => kmh > startKmh)
    .map((kmh) => ({ label: `${startKmh}-${kmh} km/h`, fromKmh: startKmh, toKmh: kmh }));
  return findSplits(gps, pull, splits).splits;
}

// --- Voice ---
const TENS = ["", "ten", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const HUNDREDS = ["", "one hundred", "two hundred", "three hundred", "four hundred", "five hundred", "six hundred", "seven hundred", "eight hundred", "nine hundred"];

// Written out, because some voices read digits unclearly or run them together.
function spokenNumber(value) {
  const rest = value % 100;
  const parts = [HUNDREDS[Math.floor(value / 100)], TENS[Math.floor(rest / 10)], rest % 10 ? String(rest % 10) : ""];
  return parts.filter(Boolean).join(" ");
}

// Novelty and low-fidelity voices are clear only by accident, so they're never picked by default.
const NOVELTY_VOICES = /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|eddy|flo|fred|good news|grandma|grandpa|hysterical|jester|junior|kathy|organ|pipe|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox/i;
const CLEAR_VOICES = /samantha|karen|daniel|moira|tessa|serena|ava|allison|google (us|uk)/i;
const HIGH_QUALITY_VOICES = /premium|enhanced|neural|natural/i;

function pickVoice(voices, savedName, deviceLanguage = "en") {
  const saved = voices.find((v) => v.name === savedName);
  if (saved) return saved;
  const english = voices.filter((v) => /^en/i.test(v.lang) && !NOVELTY_VOICES.test(v.name));
  const score = (v) => (HIGH_QUALITY_VOICES.test(v.name) ? 4 : 0)
    + (CLEAR_VOICES.test(v.name) ? 2 : 0)
    + (v.lang.toLowerCase() === deviceLanguage.toLowerCase() ? 1 : 0);
  return english.reduce((best, v) => (!best || score(v) > score(best) ? v : best), null);
}

// --- GPS hardening ---
// Reacquiring GPS can take longer than the first wait, and restarting cancels the attempt in
// progress. Field logs showed fixed 8 s restarts repeating through an 86 s outage, so each
// failed attempt now gets longer before the next.
function gpsRestartDelayMs(attempts) {
  return Math.min(GPS_RESTART_FIRST_MS * 2 ** attempts, GPS_RESTART_MAX_MS);
}

function hasRecentMotion(motionLog, nowMs) {
  return motionLog.length > 0 && nowMs - motionLog[motionLog.length - 1].t <= MOTION_RECENT_MS;
}

// Field logs show iOS delivering fixes with no speed value. Those fixes are still useful:
// they separate "parked" from "GPS lost", so they must not read as a GPS dropout.
const MAX_DERIVE_GAP_MS = 5000;
const QUIET_WINDOW_MS = 1000;
const MIN_QUIET_SAMPLES = 5;
const QUIET_NOISE_MS2 = 0.6;

function distanceM(a, b) {
  const radians = Math.PI / 180;
  const meanLat = ((a.lat + b.lat) / 2) * radians;
  const x = (b.lon - a.lon) * radians * Math.cos(meanLat);
  const y = (b.lat - a.lat) * radians;
  return Math.hypot(x, y) * 6371000;
}

function motionIsQuiet(motionLog, nowMs) {
  const recent = [];
  for (let i = motionLog.length - 1; i >= 0 && motionLog[i].t >= nowMs - QUIET_WINDOW_MS; i--) {
    recent.push(motionLog[i]);
  }
  return recent.length >= MIN_QUIET_SAMPLES && calibrate(recent).noise < QUIET_NOISE_MS2;
}

// Returns the best speed for a fix. Source is "gps" (reported by the phone), "position"
// (derived from movement; too noisy for final timing), "still" (no speed reported, but
// neither position nor motion shows movement) or "none".
function resolveSpeed(fix, previous, quiet) {
  if (fix.speedMs !== null && fix.speedMs !== undefined && fix.speedMs >= 0) {
    return { kmh: fix.speedMs * 3.6, source: "gps" };
  }
  if (!previous) return { kmh: null, source: "none" };
  const elapsedMs = fix.t - previous.t;
  if (elapsedMs <= 0 || elapsedMs > MAX_DERIVE_GAP_MS) return { kmh: null, source: "none" };
  const moved = distanceM(previous, fix);
  // Movement within the combined accuracy of both fixes can't be told apart from GPS noise.
  if (moved <= fix.accuracy + previous.accuracy) {
    return quiet ? { kmh: 0, source: "still" } : { kmh: null, source: "none" };
  }
  return { kmh: ((moved / elapsedMs) * 1000) * 3.6, source: "position" };
}

// Measures what the phone really delivers, so rate problems show up as numbers in the logs.
class GpsHealth {
  constructor() {
    this.lastT = null;
    this.reset();
  }

  reset() {
    this.fixes = 0;
    this.missingSpeed = 0;
    this.duplicates = 0;
    this.intervals = [];
    this.ages = [];
  }

  // Returns false for a repeated or out-of-order fix, which should be ignored.
  record({ t, now, speedMissing }) {
    if (this.lastT !== null && t <= this.lastT) {
      this.duplicates++;
      return false;
    }
    if (this.lastT !== null) this.intervals.push(t - this.lastT);
    this.lastT = t;
    this.fixes++;
    if (speedMissing) this.missingSpeed++;
    this.ages.push(now - t);
    return true;
  }

  summary() {
    const total = this.intervals.reduce((sum, value) => sum + value, 0);
    return {
      fixes: this.fixes,
      missingSpeedPct: this.fixes ? Math.round((this.missingSpeed / this.fixes) * 100) : 0,
      duplicates: this.duplicates,
      hz: total ? Number(((this.intervals.length * 1000) / total).toFixed(2)) : 0,
      medianMs: this.intervals.length ? median(this.intervals) : null,
      maxGapMs: this.intervals.length ? Math.max(...this.intervals) : null,
      medianAgeMs: this.ages.length ? median(this.ages) : null,
    };
  }
}

// --- After-run analysis ---
// Integrates the motion sensor into a detailed speed curve, then uses GPS to correct its
// long-term drift and to measure how late GPS speed arrives. All thresholds are starting
// guesses until real iPhone logs are available.
const CALIBRATION_MS = 5000;
const CALIBRATION_GUARD_MS = 300; // Excludes the moments just before launch.
const MIN_CALIBRATION_MS = 2000;
const CALIBRATION_STEP_MS = 250;
const CALIBRATION_NOISE_LIMITS = [0.35, 0.6]; // Prefers a truly calm stretch if one exists.
const GENTLE_HISTORY_MS = 12000;
const GENTLE_REFERENCE_MS = 2000;
const GENTLE_CALM_NOISE = 0.45;
const GENTLE_STOPPED_KMH = 0.5;
const GENTLE_GPS_LAG_MS = 500; // The car moves this long before GPS reports it, at the least.
const GENTLE_MAX_BACK_MS = 6000;
const GENTLE_SEARCH_FORWARD_MS = 500;
const GENTLE_WINDOW_MS = 500; // Long enough to average out engine vibration.
const GENTLE_STEP_MS = 50;
const GENTLE_MIN_MS2 = 0.25;
const GENTLE_NOISE_FACTOR = 0.5;
const ONSET_MIN_MS2 = 0.2;
const ONSET_NOISE_FACTOR = 0.75;
const ONSET_WINDOW_MS = 120;
const ONSET_STEP_MS = 16;
const ONSET_SEARCH_BACK_MS = 1500;
const STOP_CHECK_MS = 2000; // GPS must have shown the car stopped for this long before launch.
const ACCEL_SLOPE_MS = 2000; // Long enough that vibration doesn't read as acceleration.
const LAUNCH_UNCERTAINTY_S = 0.1;
const LARGE_CORRECTION = 0.1;
const NEAR_TARGET_KMH = 3; // Barely reaching a target makes its time unreliable.
const DISTANCE_SPEED_ERROR = 0.01; // Assumed 1% speed error until real runs measure it.
const LIFTED_BELOW_PEAK_KMH = 5;
const TYPICAL_GPS_DELAY_MS = 500; // Real runs measured about 0.4 to 0.75 s.
const TYPICAL_DELAY_UNCERTAINTY_S = 0.25;
const GPS_LAUNCH_UNCERTAINTY_S = 0.4;
const GPS_START_SEARCH_MS = 8000;
const GPS_STOPPED_KMH = 1;
const GPS_STOPPED_RECENT_MS = 5000;
const GPS_MIN_SLOPE_MS2 = 0.2;
const MOTION_LATE_LIMIT_MS = 1000;
const MOTION_EARLY_LIMIT_MS = 6000;
const MAX_TRUSTED_RMSE = 1;
const MAX_TRUSTED_CORRECTION = 0.25;
const CLEAN_RUN_DIP_KMH = 5;
const STALL_WINDOW_MS = 8000;
const STALL_MIN_GAIN_KMH = 3;
const STALL_MIN_KMH = 20;
const SLOW_START_KMH = 10;
const SLOW_START_MS = 6000;
const SPEED_ERROR_KMH = 0.5;
const ROTATION_WINDOW_MS = 500;
const MIN_GRAVITY_ALIGNMENT = 0.9; // About 25 degrees of phone rotation.
const AXIS_WINDOW_MS = 2000;
const MAX_DELAY_MS = 2000;
const DELAY_STEP_MS = 20;
const RIDGE = 0.001; // Keeps the fit near the raw sensor when scale and drift look alike.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vector = (sample) => [sample.x, sample.y, sample.z];

function calibrate(samples) {
  const sum = [0, 0, 0];
  for (const s of samples) {
    sum[0] += s.x;
    sum[1] += s.y;
    sum[2] += s.z;
  }
  const gravity = times(sum, 1 / samples.length);
  let squares = 0;
  for (const s of samples) {
    const d = minus(vector(s), gravity);
    squares += dot(d, d);
  }
  const noise = Math.sqrt(squares / samples.length);
  return { gravity, noise, still: noise < 0.6 };
}

// A real run showed a phone still settling for the first seconds of the window, so this uses
// the longest calm stretch that ends at launch rather than requiring the whole window.
function findCalibration(samples) {
  const lastT = samples[samples.length - 1].t;
  for (const limit of CALIBRATION_NOISE_LIMITS) {
    for (let from = samples[0].t; lastT - from >= MIN_CALIBRATION_MS; from += CALIBRATION_STEP_MS) {
      const calibration = calibrate(samples.filter((s) => s.t >= from));
      if (calibration.noise < limit) return calibration;
    }
  }
  return null;
}

// Forward acceleration can't change the reading along the original gravity direction, but
// turning the phone does. So a sustained drop there means the phone moved, however hard the
// car is accelerating. Windows average out road bumps.
function phoneRotated(samples, gravity) {
  const size = Math.sqrt(dot(gravity, gravity));
  const up = times(gravity, 1 / size);
  let sum = 0;
  let count = 0;
  let windowEnd = samples[0].t + ROTATION_WINDOW_MS;
  for (const s of samples) {
    if (s.t > windowEnd) {
      if (count && sum / count < size * MIN_GRAVITY_ALIGNMENT) return true;
      sum = 0;
      count = 0;
      windowEnd = s.t + ROTATION_WINDOW_MS;
    }
    sum += dot(vector(s), up);
    count++;
  }
  return false;
}

// Mean horizontal acceleration during launch gives the direction of travel, sign included.
function forwardAxis(samples, gravity) {
  const up = times(gravity, 1 / Math.sqrt(dot(gravity, gravity)));
  const sum = [0, 0, 0];
  for (const s of samples) {
    const d = minus(vector(s), gravity);
    const horizontal = minus(d, times(up, dot(d, up)));
    sum[0] += horizontal[0];
    sum[1] += horizontal[1];
    sum[2] += horizontal[2];
  }
  const length = Math.sqrt(dot(sum, sum));
  return length > 0 ? times(sum, 1 / length) : null;
}

// Refines the live launch estimate. Averaging over a short window follows the trend, because
// a real run showed single samples latching onto vibration and placing launch too late.
function findLaunchOnset(motion, gravity, axis, approxMs, noise) {
  const threshold = Math.max(ONSET_MIN_MS2, ONSET_NOISE_FACTOR * noise);
  const nearby = motion
    .filter((s) => s.t >= approxMs - ONSET_SEARCH_BACK_MS - ONSET_WINDOW_MS && s.t <= approxMs + LAUNCH_HOLD_MS + ONSET_WINDOW_MS)
    .map((s) => ({ t: s.t, accel: dot(minus(vector(s), gravity), axis) }));
  const meanAround = (center) => {
    const inside = nearby.filter((s) => Math.abs(s.t - center) <= ONSET_WINDOW_MS / 2);
    return inside.length ? inside.reduce((sum, s) => sum + s.accel, 0) / inside.length : 0;
  };
  const anchor = approxMs + LAUNCH_HOLD_MS;
  if (meanAround(anchor) < threshold) return approxMs;
  for (let center = anchor; center >= approxMs - ONSET_SEARCH_BACK_MS; center -= ONSET_STEP_MS) {
    if (meanAround(center) < threshold) return center;
  }
  return approxMs - ONSET_SEARCH_BACK_MS;
}

function integrateSpeed(motion, gravity, axis, launchMs) {
  const curve = [{ t: launchMs, v: 0 }];
  let previousAccel = 0;
  for (const s of motion) {
    if (s.t <= launchMs) continue;
    const accel = dot(minus(vector(s), gravity), axis);
    const last = curve[curve.length - 1];
    curve.push({ t: s.t, v: last.v + (0.5 * (accel + previousAccel) * (s.t - last.t)) / 1000 });
    previousAccel = accel;
  }
  return curve;
}

function speedAt(curve, t) {
  if (t <= curve[0].t) return 0;
  let low = 0;
  let high = curve.length - 1;
  if (t >= curve[high].t) return curve[high].v;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (curve[middle].t <= t) low = middle;
    else high = middle;
  }
  const a = curve[low];
  const b = curve[high];
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

// Fits gpsSpeed(t) = scale * curve(t - delay) + drift * (t - delay - launch).
function fitCurve(curve, gps, launchMs, delayMs) {
  let vv = 0, vt = 0, tt = 0, vg = 0, tg = 0;
  const points = gps.map((g) => {
    const tau = Math.max(0, g.t - delayMs - launchMs) / 1000;
    const v = speedAt(curve, g.t - delayMs);
    const target = g.kmh / 3.6;
    vv += v * v;
    vt += v * tau;
    tt += tau * tau;
    vg += v * target;
    tg += tau * target;
    return { v, tau, target };
  });
  const a = vv * (1 + RIDGE);
  const c = tt * (1 + RIDGE);
  const determinant = a * c - vt * vt;
  if (determinant <= 0) return { scale: 1, drift: 0, sse: Infinity };
  const right = vg + RIDGE * vv;
  const scale = (right * c - vt * tg) / determinant;
  const drift = (a * tg - vt * right) / determinant;
  let sse = 0;
  for (const p of points) sse += (p.target - scale * p.v - drift * p.tau) ** 2;
  return { scale, drift, sse };
}

function estimateDelay(curve, gps, launchMs) {
  const results = [];
  for (let delayMs = 0; delayMs <= MAX_DELAY_MS; delayMs += DELAY_STEP_MS) {
    results.push({ delayMs, ...fitCurve(curve, gps, launchMs, delayMs) });
  }
  const best = results.reduce((a, b) => (b.sse < a.sse ? b : a));
  // Delays that fit almost as well show how tightly the data pins this down.
  const tolerance = best.sse * 1.1 + 0.02 * gps.length;
  const plausible = results.filter((r) => r.sse <= tolerance).map((r) => r.delayMs);
  const spreadMs = (Math.max(...plausible) - Math.min(...plausible)) / 2;
  return { ...best, spreadMs };
}

// A gentle pull-away can stay under the live launch threshold, leaving only a late GPS start.
// The motion data is still there, so this searches it for where acceleration really began.
// Returns { launchMs, reason }, with launchMs null when launch can't be pinned down.
//
// The time from launch to the GPS start varies with how gently the car pulls away, so a fixed
// search range fails. Instead this finds the latest calm stretch before the GPS start, then
// takes the first real acceleration after it.
function latestCalmStretch(samples) {
  if (!samples.length) return null;
  const firstT = samples[0].t;
  for (let end = samples[samples.length - 1].t; end - GENTLE_REFERENCE_MS >= firstT; end -= CALIBRATION_STEP_MS) {
    const stretch = samples.filter((s) => s.t >= end - GENTLE_REFERENCE_MS && s.t <= end);
    if (stretch.length < MIN_QUIET_SAMPLES) continue;
    const calibration = calibrate(stretch);
    if (calibration.noise < GENTLE_CALM_NOISE) return { ...calibration, endMs: end };
  }
  return null;
}

function findGentleLaunch(motion, gps, gpsStartMs) {
  const declined = (reason) => ({ launchMs: null, reason });
  // Steady acceleration has little vibration and can look calm to the motion sensor alone, so
  // the calm stretch must also end while GPS still showed the car stopped.
  const stopped = gps.filter((g) => g.t <= gpsStartMs && g.kmh < GENTLE_STOPPED_KMH);
  if (!stopped.length) return declined("GPS never showed the car stopped before the run");
  const stoppedUntil = stopped[stopped.length - 1].t - GENTLE_GPS_LAG_MS;
  const history = motion.filter((s) => s.t >= gpsStartMs - GENTLE_HISTORY_MS && s.t <= stoppedUntil);
  if (!history.length) return declined("no motion data before the run");
  const calm = latestCalmStretch(history);
  if (!calm) return declined("phone was never calm before the run");

  const { gravity, noise } = calm;
  const up = times(gravity, 1 / Math.sqrt(dot(gravity, gravity)));
  // Sample noise overstates a window average. A real idling car read 0.45 m/s2 of noise, and
  // a threshold scaled fully to that placed a gradual launch about 3 s too late.
  const threshold = Math.max(GENTLE_MIN_MS2, GENTLE_NOISE_FACTOR * noise);
  const searchStart = calm.endMs;
  const searchEnd = gpsStartMs + GENTLE_SEARCH_FORWARD_MS;
  const search = motion.filter((s) => s.t >= searchStart && s.t <= searchEnd);

  // Averaging the acceleration vector over a window cancels vibration but keeps real pull.
  for (let from = searchStart; from <= searchEnd - GENTLE_WINDOW_MS; from += GENTLE_STEP_MS) {
    const sum = [0, 0, 0];
    let count = 0;
    for (const s of search) {
      if (s.t < from || s.t >= from + GENTLE_WINDOW_MS) continue;
      const d = minus(vector(s), gravity);
      const horizontal = minus(d, times(up, dot(d, up)));
      sum[0] += horizontal[0];
      sum[1] += horizontal[1];
      sum[2] += horizontal[2];
      count++;
    }
    if (count < MIN_QUIET_SAMPLES) continue;
    const mean = times(sum, 1 / count);
    if (Math.sqrt(dot(mean, mean)) >= threshold) {
      // A long wait before GPS saw movement suggests the phone was handled, not a launch.
      const launchMs = from + GENTLE_WINDOW_MS / 2;
      if (gpsStartMs - launchMs > GENTLE_MAX_BACK_MS) return declined("first movement was too long before GPS");
      return { launchMs, reason: null };
    }
  }
  return declined("no acceleration found after the calm stretch");
}

// --- Run analysis ---
// Real runs showed GPS staying reliable while the motion sensor failed in many ways: phones
// swinging in mounts, and drift reaching double the true speed. So final times always come
// from GPS, and motion only sharpens the launch point and measures GPS delay when it's sound.
// Bad motion data lowers the grade and widens the range, but never loses a run.

function firstMovingReading(gps, anchorMs) {
  const moving = gps.filter((g, i) => g.kmh >= STILL_KMH && i > 0 && gps[i - 1].kmh < STILL_KMH);
  const nearby = moving.filter((g) => g.t >= anchorMs - GPS_START_SEARCH_MS && g.t <= anchorMs + GPS_START_SEARCH_MS);
  if (!nearby.length) return null;
  return nearby.reduce((a, b) => (Math.abs(b.t - anchorMs) < Math.abs(a.t - anchorMs) ? b : a));
}

// Extends the first moving readings back to zero speed, then allows for typical GPS delay.
function estimateGpsLaunch(gps, gpsStartMs) {
  const stopped = gps.filter((g) => g.t <= gpsStartMs && g.kmh < GPS_STOPPED_KMH);
  if (!stopped.length) return null;
  const lastStopped = stopped[stopped.length - 1];
  if (gpsStartMs - lastStopped.t > GPS_STOPPED_RECENT_MS) return null;
  const [a, b] = gps.filter((g) => g.t > lastStopped.t);
  if (!a || !b) return null;
  const slope = ((b.kmh - a.kmh) / 3.6) / ((b.t - a.t) / 1000);
  const zero = slope > GPS_MIN_SLOPE_MS2 ? a.t - ((a.kmh / 3.6) / slope) * 1000 : lastStopped.t;
  return Math.max(zero, lastStopped.t) - TYPICAL_GPS_DELAY_MS;
}

// Everything the motion sensor can offer for this run. Each part is optional.
function readMotion(motion, gps, approxLaunchMs) {
  const notes = [];
  const none = { launchMs: null, delay: null, notes };
  if (approxLaunchMs === null || approxLaunchMs === undefined) return none;
  const still = motion.filter((s) =>
    s.t >= approxLaunchMs - CALIBRATION_MS && s.t <= approxLaunchMs - CALIBRATION_GUARD_MS);
  if (!still.length || still[still.length - 1].t - still[0].t < MIN_CALIBRATION_MS) {
    notes.push("Not enough time stopped before launch");
    return none;
  }
  const calibration = findCalibration(still);
  if (!calibration) {
    notes.push("Phone moved before launch");
    return none;
  }
  const launchSamples = motion.filter((s) => s.t >= approxLaunchMs && s.t <= approxLaunchMs + AXIS_WINDOW_MS);
  const axis = launchSamples.length >= 10 ? forwardAxis(launchSamples, calibration.gravity) : null;
  if (!axis) {
    notes.push("Too little motion data during launch");
    return none;
  }
  const launchMs = findLaunchOnset(motion, calibration.gravity, axis, approxLaunchMs, calibration.noise);

  // From here the launch point stands, and only the delay measurement can still fail.
  const result = { launchMs, delay: null, notes };
  const after = gps.filter((g) => g.t >= launchMs);
  if (after.length < 4) return result;
  const peak = after.reduce((a, b) => (b.kmh > a.kmh ? b : a));
  const used = after.filter((g) => g.t <= peak.t);
  const running = motion.filter((s) => s.t >= launchMs && s.t <= peak.t);
  if (used.length < 4 || running.length < 2) return result;
  let maxGap = 0;
  for (let i = 1; i < running.length; i++) maxGap = Math.max(maxGap, running[i].t - running[i - 1].t);
  result.motionHz = ((running.length - 1) * 1000) / (running[running.length - 1].t - running[0].t);
  if (maxGap > 500 || result.motionHz < 15) {
    notes.push("Motion sensor paused during the run");
    return result;
  }
  if (phoneRotated(running, calibration.gravity)) {
    notes.push("Phone moved during the run. Mount it firmly.");
    return result;
  }
  const curve = integrateSpeed(motion.filter((s) => s.t <= peak.t), calibration.gravity, axis, launchMs);
  const fit = estimateDelay(curve, used, launchMs);
  result.rmse = Math.sqrt(fit.sse / used.length);
  result.scale = fit.scale;
  const sound = result.rmse <= MAX_TRUSTED_RMSE
    && Math.abs(fit.scale - 1) <= MAX_TRUSTED_CORRECTION
    && fit.spreadMs <= 300
    && fit.delayMs < MAX_DELAY_MS;
  if (!sound) {
    notes.push("Motion sensor and GPS disagreed");
    return result;
  }
  result.delay = { delayMs: fit.delayMs, spreadMs: fit.spreadMs };
  if (Math.abs(fit.scale - 1) > LARGE_CORRECTION) notes.push("Motion sensor needed a large correction");
  return result;
}

// Delay-corrected speed from launch onward. Stops at a GPS dropout, and at any real slowdown
// before the peak, because later times would no longer describe one continuous launch.
function buildTimeline(gps, launchMs, delayMs, startKmh = 0) {
  const readings = gps.filter((g) => g.t - delayMs > launchMs);
  const peakT = readings.length ? readings.reduce((a, b) => (b.kmh > a.kmh ? b : a)).t : 0;
  const points = [{ t: launchMs, v: startKmh / 3.6 }];
  let highest = startKmh;
  let previousT = launchMs + delayMs;
  let stoppedBy = null;
  for (const g of readings) {
    if (g.t - previousT > MAX_GPS_GAP_MS) {
      stoppedBy = "GPS dropped out, so later times are left out";
      break;
    }
    if (g.t < peakT && highest - g.kmh > CLEAN_RUN_DIP_KMH) {
      stoppedBy = "Speed dropped during the run, so later times are left out";
      break;
    }
    // A long cruise before speeding up again would otherwise read as one very slow launch.
    const earlier = readings.filter((r) => r.t <= g.t - STALL_WINDOW_MS).pop();
    if (g.t < peakT && earlier && highest >= STALL_MIN_KMH && g.kmh - earlier.kmh < STALL_MIN_GAIN_KMH) {
      stoppedBy = "The car stopped accelerating, so later times are left out";
      break;
    }
    highest = Math.max(highest, g.kmh);
    points.push({ t: g.t - delayMs, v: g.kmh / 3.6, kmh: g.kmh });
    previousT = g.t;
  }
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
  return { points, peak, stoppedBy };
}

function findSpeedTimes(timeline, launchMs, targets, uncertainty, reasons) {
  const { points, peak } = timeline;
  const results = [];
  for (const target of targets) {
    const goal = target.kmh / 3.6;
    if (peak.v < goal) continue; // Never extrapolate past what GPS actually saw.
    if ((peak.v - goal) * 3.6 < NEAR_TARGET_KMH) reasons.push(`Only just reached ${target.label}`);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a.v < goal && b.v >= goal) {
        const t = a.t + ((goal - a.v) / (b.v - a.v)) * (b.t - a.t);
        const accel = (b.v - a.v) / ((b.t - a.t) / 1000);
        const speedError = (SPEED_ERROR_KMH / 3.6) / Math.max(accel, 0.5);
        results.push({
          label: target.label,
          seconds: (t - launchMs) / 1000,
          plusMinus: Math.max(0.1, Math.hypot(speedError, uncertainty)),
        });
        break;
      }
    }
  }
  return results;
}

// Adds up speed over distance. One reading a second is coarse for a moment in time but
// averages out over distance. Never extends past what GPS covered.
function findDistances(timeline, launchMs, targets, uncertainty) {
  const { points, peak } = timeline;
  const results = [];
  const remaining = [...targets].sort((a, b) => a.meters - b.meters);
  let covered = 0;
  for (let i = 1; i < points.length && remaining.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = (b.t - a.t) / 1000;
    const step = ((a.v + b.v) / 2) * dt;
    while (remaining.length && covered + step >= remaining[0].meters) {
      const target = remaining.shift();
      const left = target.meters - covered;
      // Solves distance = v0 * x + (v1 - v0) * x^2 / (2 * dt) for the time x into this segment.
      const slope = (b.v - a.v) / dt;
      const x = Math.abs(slope) < 1e-6
        ? left / Math.max(a.v, 0.01)
        : (-a.v + Math.sqrt(Math.max(0, a.v * a.v + 2 * slope * left))) / slope;
      const speed = a.v + slope * x;
      const speedError = (DISTANCE_SPEED_ERROR * target.meters) / Math.max(speed, 1);
      results.push({
        label: target.label,
        meters: target.meters,
        seconds: (a.t - launchMs) / 1000 + x,
        trapKmh: speed * 3.6,
        plusMinus: Math.max(0.1, Math.hypot(speedError, uncertainty)),
        liftedOff: a.t + x * 1000 > peak.t && (peak.v - speed) * 3.6 > LIFTED_BELOW_PEAK_KMH,
      });
    }
    covered += step;
  }
  return results;
}

// Input: raw motion ({t,x,y,z} including gravity) and GPS ({t,kmh,accuracy}) around a run.
// approxLaunchMs comes from the motion sensor and may be null. Only a run that never truly
// started from a stop, or has too little GPS, is rejected.
function analyzeRun({ motion, gps, approxLaunchMs = null, gpsStartMs = null, targets, distanceTargets = [] }) {
  const rejected = (reason) => ({ quality: "rejected", reasons: [reason], targets: [], distances: [] });
  const anchor = approxLaunchMs !== null ? approxLaunchMs : gpsStartMs;
  if (anchor === null) return rejected("Launch couldn't be found");

  const moving = firstMovingReading(gps, anchor);
  const gpsLaunch = moving ? estimateGpsLaunch(gps, moving.t) : null;
  const motionRead = readMotion(motion, gps, approxLaunchMs);
  const reasons = [...motionRead.notes];

  // A motion launch far from what GPS shows is likely the phone being handled.
  let launchMs = motionRead.launchMs;
  if (launchMs !== null && gpsLaunch !== null
    && (launchMs > gpsLaunch + MOTION_LATE_LIMIT_MS || launchMs < gpsLaunch - MOTION_EARLY_LIMIT_MS)) {
    reasons.push("Motion sensor launch didn't match GPS");
    launchMs = null;
  }
  const launchFromMotion = launchMs !== null;
  if (!launchFromMotion) launchMs = gpsLaunch;
  if (launchMs === null) return rejected("Car didn't fully stop before launch");
  if (gps.some((g) => g.t >= launchMs - STOP_CHECK_MS && g.t <= launchMs && g.kmh >= STILL_KMH)) {
    return rejected("Car didn't fully stop before launch");
  }
  if (!launchFromMotion) reasons.push("Launch taken from GPS, so the start is less exact");

  const delay = launchFromMotion && motionRead.delay;
  const delayMs = delay ? delay.delayMs : TYPICAL_GPS_DELAY_MS;
  if (!delay) reasons.push(`Used a typical GPS delay of ${TYPICAL_GPS_DELAY_MS} ms`);

  const timeline = buildTimeline(gps, launchMs, delayMs);
  if (timeline.points.length < 4) return rejected("Too few GPS readings during the run");
  if (timeline.stoppedBy) reasons.push(timeline.stoppedBy);

  const crawling = timeline.points.find((p) => p.v * 3.6 >= SLOW_START_KMH);
  if (crawling && crawling.t - launchMs > SLOW_START_MS) reasons.push("Slow start, not a full launch");
  const accuracies = gps.filter((g) => g.t >= launchMs).map((g) => g.accuracy).filter((a) => a != null).sort((a, b) => a - b);
  if (accuracies.length && accuracies[accuracies.length >> 1] > 15) reasons.push("GPS accuracy was poor");

  const uncertainty = Math.hypot(
    launchFromMotion ? LAUNCH_UNCERTAINTY_S : GPS_LAUNCH_UNCERTAINTY_S,
    delay ? delay.spreadMs / 1000 : TYPICAL_DELAY_UNCERTAINTY_S,
  );
  const speedTimes = findSpeedTimes(timeline, launchMs, targets, uncertainty, reasons);
  return {
    quality: reasons.length ? "fair" : "good",
    reasons,
    targets: speedTimes,
    distances: findDistances(timeline, launchMs, distanceTargets, uncertainty),
    launchMs,
    launchSource: launchFromMotion ? "motion" : "gps",
    delayMs,
    delaySource: delay ? "measured" : "typical",
    rmse: motionRead.rmse,
    scale: motionRead.scale,
    motionHz: motionRead.motionHz,
  };
}

// --- Roll races ---
// A roll is a steady hold followed by a sudden, sustained pull. It's recognised afterwards, so
// the whole pull is available, and it needs no setup from the driver.
const STANDARD_ROLLS_KMH = [20, 40, 60, 80, 100, 120, 140];
const ROLL_NAME_TOLERANCE_KMH = 5;
const ROLL_TARGETS_KMH = [60, 80, 100, 120, 150, 200, 250];
const ROLL_MIN_TARGET_GAIN_KMH = 15;
const ROLL_MIN_HOLD_KMH = 15;
const HOLD_BAND_KMH = 3;
const HOLD_MIN_MS = 3000;
const GO_MIN_GAIN_KMH = 15;
const GO_GAIN_WINDOW_MS = 5000;
const GO_MARGIN_KMH = 2;
const ROLL_MOTION_WINDOW_MS = 300;
const ROLL_MOTION_STEP_MS = 50;
const ROLL_MIN_PULL_MS2 = 0.5;
const ROLL_MOTION_NOISE_FACTOR = 0.5;
const ROLL_MOTION_EARLY_LIMIT_MS = 2500;
const ROLL_MOTION_LATE_LIMIT_MS = 200;
const ROLL_MOTION_UNCERTAINTY_S = 0.28; // Launch point plus a typical, unmeasured GPS delay.
const ROLL_GPS_UNCERTAINTY_S = 0.4;
const ROLL_READY_REPEAT_MS = 30000;
const ROLL_READY_RESET_KMH = 8;

function rollName(heldKmh) {
  const nearest = STANDARD_ROLLS_KMH.reduce((a, b) => (Math.abs(b - heldKmh) < Math.abs(a - heldKmh) ? b : a));
  return Math.abs(nearest - heldKmh) <= ROLL_NAME_TOLERANCE_KMH
    ? { startKmh: nearest, standard: true }
    : { startKmh: Math.round(heldKmh), standard: false };
}

// Holding a steady speed means no forward acceleration, so the average reading during the hold
// is gravity alone. The first sustained pull beyond that is the go moment.
function findRollGoFromMotion(motion, holdStartMs, holdEndMs, searchEndMs) {
  const hold = motion.filter((s) => s.t >= holdStartMs && s.t <= holdEndMs - ROLL_MOTION_WINDOW_MS);
  if (hold.length < MIN_QUIET_SAMPLES * 4) return null;
  const { gravity, noise } = calibrate(hold);
  const up = times(gravity, 1 / Math.sqrt(dot(gravity, gravity)));
  const threshold = Math.max(ROLL_MIN_PULL_MS2, ROLL_MOTION_NOISE_FACTOR * noise);
  const search = motion.filter((s) => s.t >= holdStartMs && s.t <= searchEndMs);
  for (let from = holdStartMs; from <= searchEndMs - ROLL_MOTION_WINDOW_MS; from += ROLL_MOTION_STEP_MS) {
    const sum = [0, 0, 0];
    let count = 0;
    for (const s of search) {
      if (s.t < from || s.t >= from + ROLL_MOTION_WINDOW_MS) continue;
      const d = minus(vector(s), gravity);
      const horizontal = minus(d, times(up, dot(d, up)));
      sum[0] += horizontal[0];
      sum[1] += horizontal[1];
      sum[2] += horizontal[2];
      count++;
    }
    if (count < MIN_QUIET_SAMPLES) continue;
    const mean = times(sum, 1 / count);
    if (Math.sqrt(dot(mean, mean)) >= threshold) return from + ROLL_MOTION_WINDOW_MS / 2;
  }
  return null;
}

// Returns the roll behind a finished pull, or null if it wasn't a hold followed by a real pull.
function findRoll(gps, motion, pull) {
  const points = gps.filter((g) => g.t >= pull.startMs - GPS_START_SEARCH_MS && g.t <= pull.peakMs);
  // The go reading is the last one still flat, working back from the peak.
  let goIndex = -1;
  for (let i = points.length - 3; i >= 0; i--) {
    if (points[i + 2].kmh - points[i].kmh < HOLD_BAND_KMH) {
      goIndex = i + 2;
      break;
    }
  }
  if (goIndex < 1) return null;
  const goReading = points[goIndex];

  // The hold runs back from there for as long as speed stays in a narrow band.
  let holdFirst = goIndex;
  let low = goReading.kmh;
  let high = goReading.kmh;
  while (holdFirst > 0) {
    const previous = points[holdFirst - 1];
    const nextLow = Math.min(low, previous.kmh);
    const nextHigh = Math.max(high, previous.kmh);
    if (nextHigh - nextLow > HOLD_BAND_KMH * 2 || goReading.t - previous.t > GPS_START_SEARCH_MS) break;
    low = nextLow;
    high = nextHigh;
    holdFirst--;
  }
  if (goReading.t - points[holdFirst].t < HOLD_MIN_MS) return null;
  const heldKmh = median(points.slice(holdFirst, goIndex + 1).map((g) => g.kmh));
  if (heldKmh < ROLL_MIN_HOLD_KMH) return null;

  // A real pull gains speed quickly. This separates a roll from gently speeding up.
  const soon = points.filter((g) => g.t > goReading.t && g.t <= goReading.t + GO_GAIN_WINDOW_MS);
  if (!soon.length || Math.max(...soon.map((g) => g.kmh)) - heldKmh < GO_MIN_GAIN_KMH) return null;

  // Where GPS speed leaves the hold, traced back along the first rise. No delay correction is
  // needed with this start, because the delay affects both ends of the time equally.
  const rise = soon.find((g) => g.kmh >= heldKmh + GO_MARGIN_KMH);
  if (!rise) return null;
  // Measured after the first rise, because that one straddles the go moment and reads low.
  const riseIndex = points.indexOf(rise);
  const after = points[riseIndex + 1] || rise;
  const before = points[riseIndex + 1] ? rise : points[riseIndex - 1];
  const slope = ((after.kmh - before.kmh) / 3.6) / ((after.t - before.t) / 1000);
  const gpsGoMs = rise.t - (((rise.kmh - heldKmh) / 3.6) / Math.max(slope, 0.5)) * 1000;

  const motionGo = findRollGoFromMotion(motion, points[holdFirst].t, goReading.t, gpsGoMs + GO_GAIN_WINDOW_MS / 10);
  const motionUsable = motionGo !== null
    && motionGo >= gpsGoMs - ROLL_MOTION_EARLY_LIMIT_MS
    && motionGo <= gpsGoMs + ROLL_MOTION_LATE_LIMIT_MS;
  const goMs = motionUsable ? motionGo : gpsGoMs;
  const delayMs = motionUsable ? TYPICAL_GPS_DELAY_MS : 0;
  const uncertainty = motionUsable ? ROLL_MOTION_UNCERTAINTY_S : ROLL_GPS_UNCERTAINTY_S;

  const name = rollName(heldKmh);
  const reasons = [];
  if (!name.standard) reasons.push("Held speed isn't near a standard roll, so compare with care");
  if (!motionUsable) reasons.push("Go moment taken from GPS, so the start is less exact");
  const timeline = buildTimeline(gps.filter((g) => g.t <= pull.peakMs), goMs, delayMs, heldKmh);
  if (timeline.stoppedBy) reasons.push(timeline.stoppedBy);
  const targets = ROLL_TARGETS_KMH
    .filter((kmh) => kmh >= heldKmh + ROLL_MIN_TARGET_GAIN_KMH)
    .map((kmh) => ({ label: `${name.startKmh}-${kmh} km/h`, kmh }));
  const rollTimes = findSpeedTimes(timeline, goMs, targets, uncertainty, reasons);
  return {
    name: name.standard ? `${name.startKmh} roll` : `${name.startKmh} km/h roll`,
    standard: name.standard,
    heldKmh,
    goMs,
    goSource: motionUsable ? "motion" : "gps",
    holdSeconds: (goReading.t - points[holdFirst].t) / 1000,
    times: rollTimes,
    quality: reasons.length ? "fair" : "good",
    reasons,
  };
}

// Decides what a finished pull counts as. Most drivers reach a roll by pulling away from a stop,
// so a clear hold and pull with times to show beats a standing result, which would otherwise
// present the hold as part of one very slow launch.
function chooseRunType({ outcome, roll, pullStartMs }) {
  if (roll && roll.times.length) return "roll";
  const standing = outcome && outcome.quality !== "rejected" && outcome.launchMs >= pullStartMs - 3000;
  if (standing) return "standing";
  return roll ? "roll" : "rolling";
}

// Says when the driver has settled into a standard roll speed, once per hold.
class RollReadyWatch {
  constructor() {
    this.recent = [];
    this.announced = null;
    this.announcedAt = -Infinity;
  }

  // Returns the standard roll speed to announce, or null.
  update(t, kmh) {
    this.recent.push({ t, kmh });
    while (this.recent.length && t - this.recent[0].t > HOLD_MIN_MS) this.recent.shift();
    if (this.announced !== null && Math.abs(kmh - this.announced) > ROLL_READY_RESET_KMH) this.announced = null;
    if (this.recent.length < 3 || t - this.recent[0].t < HOLD_MIN_MS - 500) return null;
    const speeds = this.recent.map((p) => p.kmh);
    if (Math.max(...speeds) - Math.min(...speeds) > HOLD_BAND_KMH * 2) return null;
    const held = median(speeds);
    if (held < ROLL_MIN_HOLD_KMH) return null;
    const name = rollName(held);
    if (!name.standard || this.announced !== null || t - this.announcedAt < ROLL_READY_REPEAT_MS) return null;
    this.announced = name.startKmh;
    this.announcedAt = t;
    return name.startKmh;
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

if (typeof module !== "undefined") module.exports = { LaunchTimer, analyzeRun, median, resolveSpeed, motionIsQuiet, GpsHealth, SpeedCallouts, rateHz, isNewerVersion, findGentleLaunch, gpsRestartDelayMs, hasRecentMotion, PullTracker, findSplits, findFromTimes, estimateGpsLaunch, findRoll, rollName, RollReadyWatch, chooseRunType, spokenNumber, pickVoice };
