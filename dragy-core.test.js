// Run with: node --test
const test = require("node:test");
const assert = require("node:assert");
const { handshakeResponse, Reassembler, RunTimer } = require("./dragy-core.js");

function frame({ iTowMs = 0, speedMmS = 0, flags = 1 }) {
  const bytes = new Uint8Array(100);
  bytes.set([0xb5, 0x62, 0x01, 0x07, 0x5c, 0x00]);
  const view = new DataView(bytes.buffer, 6, 92);
  view.setUint32(0, iTowMs, true);
  view.setUint8(20, 3);
  view.setUint8(21, flags);
  view.setUint8(23, 12);
  view.setInt32(24, 185000000, true);
  view.setInt32(28, -339000000, true);
  view.setInt32(60, speedMmS, true);
  let ckA = 0, ckB = 0;
  for (let i = 2; i < 98; i++) {
    ckA = (ckA + bytes[i]) & 0xff;
    ckB = (ckB + ckA) & 0xff;
  }
  bytes[98] = ckA;
  bytes[99] = ckB;
  return bytes;
}

test("handshake matches the documented formula", () => {
  assert.deepStrictEqual([...handshakeResponse([0xf0, 0x3c])], [0xf0, 0x3c, 0xcc, 0x30]);
});

test("reassembles fragments and decodes fields", () => {
  const data = frame({ iTowMs: 1000, speedMmS: 27778 });
  const r = new Reassembler();
  let samples = [];
  for (let i = 0; i < data.length; i += 7) samples = samples.concat(r.push(data.slice(i, i + 7)));
  assert.strictEqual(samples.length, 1);
  assert.strictEqual(samples[0].iTowMs, 1000);
  assert.strictEqual(samples[0].lat, -33.9);
  assert.strictEqual(samples[0].lon, 18.5);
  assert.ok(Math.abs(samples[0].speedKmh - 100) < 0.01);
});

test("skips corrupt frames and recovers after leading junk", () => {
  const bad = frame({ iTowMs: 1 });
  bad[50] ^= 0xff;
  const r = new Reassembler();
  const samples = r.push([0x00, 0x01, ...bad, ...frame({ iTowMs: 2 })]);
  assert.strictEqual(r.badFrames, 1);
  assert.deepStrictEqual(samples.map((s) => s.iTowMs), [2]);
});

function sample(t, kmh, fixOk = true) {
  return { iTowMs: t, speedKmh: kmh, fixOk };
}

test("interpolates a run at 25 Hz", () => {
  const timer = new RunTimer([{ label: "0-100", kmh: 100 }]);
  for (let t = 0; t <= 200; t += 40) timer.update(sample(t, 0));
  for (let t = 40; t <= 6000; t += 40) timer.update(sample(200 + t, t * 0.02));
  // 20 km/h per second: 1 km/h at 0.05 s and 100 km/h at 5 s.
  assert.ok(Math.abs(timer.results[0].seconds - 4.95) < 0.001);
});

test("does not time a rolling start, and a lost fix cancels the run", () => {
  const rolling = new RunTimer([{ label: "0-100", kmh: 100 }]);
  [50, 90, 110].forEach((v, i) => rolling.update(sample(i * 100, v)));
  assert.strictEqual(rolling.results.length, 0);

  const lost = new RunTimer([{ label: "0-100", kmh: 100 }]);
  lost.update(sample(0, 0));
  lost.update(sample(100, 50));
  lost.update(sample(200, 80, false));
  lost.update(sample(300, 110));
  assert.strictEqual(lost.results.length, 0);
});
