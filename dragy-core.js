// Decoder and run timer for the Dragy FD02 stream. No browser or Bluetooth dependencies.
// Offsets follow the u-blox NAV-PVT layout. Dragy's stream is only "NAV-PVT-like" per
// community notes, so iTOW, flags and sAcc still need confirming against a real device.
const FRAME_LENGTH = 100;
const HEADER = [0xb5, 0x62, 0x01, 0x07, 0x5c, 0x00];

function handshakeResponse(challenge) {
  const a = challenge[0];
  const b = challenge[1];
  return Uint8Array.of(a, b, a ^ b, a & b);
}

function checksumOk(frame) {
  let ckA = 0;
  let ckB = 0;
  for (let i = 2; i < FRAME_LENGTH - 2; i++) {
    ckA = (ckA + frame[i]) & 0xff;
    ckB = (ckB + ckA) & 0xff;
  }
  return ckA === frame[98] && ckB === frame[99];
}

function decodeFrame(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset + 6, 92);
  return {
    iTowMs: view.getUint32(0, true),
    fixType: view.getUint8(20),
    fixOk: (view.getUint8(21) & 1) === 1,
    satellites: view.getUint8(23),
    lon: view.getInt32(24, true) / 1e7,
    lat: view.getInt32(28, true) / 1e7,
    altitudeM: view.getInt32(36, true) / 1000,
    hAccM: view.getUint32(40, true) / 1000,
    speedKmh: (Math.max(0, view.getInt32(60, true)) * 3.6) / 1000,
    headingDeg: view.getInt32(64, true) * 1e-5,
    speedAccKmh: (view.getUint32(68, true) * 3.6) / 1000,
  };
}

// Rebuilds frames from fragmented notifications. Bad-checksum frames are counted and skipped.
class Reassembler {
  constructor() {
    this.buffer = [];
    this.badFrames = 0;
  }

  push(bytes) {
    this.buffer.push(...bytes);
    const samples = [];
    for (;;) {
      const start = this.findHeader();
      if (start < 0) {
        this.buffer = this.buffer.slice(-(HEADER.length - 1));
        return samples;
      }
      this.buffer = this.buffer.slice(start);
      if (this.buffer.length < FRAME_LENGTH) return samples;
      const frame = Uint8Array.from(this.buffer.slice(0, FRAME_LENGTH));
      if (checksumOk(frame)) {
        samples.push(decodeFrame(frame));
        this.buffer = this.buffer.slice(FRAME_LENGTH);
      } else {
        this.badFrames++;
        this.buffer = this.buffer.slice(2);
      }
    }
  }

  findHeader() {
    for (let i = 0; i + HEADER.length <= this.buffer.length; i++) {
      if (HEADER.every((value, j) => this.buffer[i + j] === value)) return i;
    }
    return -1;
  }
}

// Times a run from standstill using GNSS time, interpolating threshold crossings between
// samples. The 1 km/h start threshold is a placeholder: Dragy's own rule is unknown.
class RunTimer {
  constructor(targets, startKmh = 1) {
    this.targets = targets;
    this.startKmh = startKmh;
    this.reset();
  }

  reset() {
    this.armed = false;
    this.startMs = null;
    this.previous = null;
    this.results = [];
  }

  update(sample) {
    if (!sample.fixOk) {
      this.reset();
      return [];
    }
    const current = { t: sample.iTowMs, v: sample.speedKmh };
    const previous = this.previous;
    this.previous = current;
    const crossing = (level) =>
      previous.t + ((level - previous.v) / (current.v - previous.v)) * (current.t - previous.t);

    if (current.v < this.startKmh) {
      this.armed = true;
      this.startMs = null;
      this.results = [];
      return [];
    }
    if (!previous || !this.armed) return [];
    if (this.startMs === null) this.startMs = crossing(this.startKmh);

    const finished = [];
    for (const target of this.targets) {
      const done = this.results.some((r) => r.label === target.label);
      if (!done && previous.v < target.kmh && current.v >= target.kmh) {
        const result = { label: target.label, seconds: (crossing(target.kmh) - this.startMs) / 1000 };
        this.results.push(result);
        finished.push(result);
      }
    }
    return finished;
  }
}

if (typeof module !== "undefined") {
  module.exports = { handshakeResponse, Reassembler, RunTimer };
}
