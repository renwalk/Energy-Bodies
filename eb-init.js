/* ============================================================================
   ENERGY BODIES — INITIALIZATION
   This file must load BEFORE sketch.js
   Sets up session tracking and global API
   ============================================================================ */

console.log('✅ eb-init.js loading...');

/* =============================
   AVERAGING CLASSES
   ============================= */
class OnlineMean {
  constructor() {
    this.mean = 0;
    this.n = 0;
  }
  add(x) {
    if (!Number.isFinite(x)) return;
    this.n++;
    this.mean += (x - this.mean) / this.n;
  }
}

class OnlineMeanArray {
  constructor(len = 0) {
    this.means = new Array(len).fill(0);
    this.n = 0;
  }
  add(arr) {
    if (!arr || !arr.length) return;
    if (this.means.length !== arr.length) {
      this.means = new Array(arr.length).fill(0);
    }
    this.n++;
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (!Number.isFinite(x)) continue;
      this.means[i] += (x - this.means[i]) / this.n;
    }
  }
}

class SessionAverager {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.startTs = 0;
    this.lastTs = 0;
    this.samples = 0;
    this.structure = new OnlineMean();
    this.balance = new OnlineMean();
    this.posture = new OnlineMean();
    this.velocity = new OnlineMean();
    this.emotions = {
      anxiety: new OnlineMean(),
      sadness: new OnlineMean(),
      joy: new OnlineMean(),
      anger: new OnlineMean(),
      fear: new OnlineMean(),
      calm: new OnlineMean()
    };
    this.regionWidths = new OnlineMeanArray(6);
    this.segmentProfile = new OnlineMeanArray(3);
  }

  begin() {
    this.reset();
    this.active = true;
    this.startTs = performance.now();
    this.lastTs = this.startTs;
    console.log('[SESSION] Started averaging');
  }

  add(sample) {
    if (!this.active) return;

    const now = performance.now();
    this.lastTs = now;

    this.structure.add(sample.structure ?? 0);
    this.balance.add(sample.balance ?? 0);
    this.posture.add(sample.posture ?? 0);
    this.velocity.add(sample.velocity ?? 0);

    if (sample.emotions) {
      for (const k in this.emotions) {
        this.emotions[k].add(sample.emotions[k] ?? 0);
      }
    }

    if (sample.regionWidths) {
      this.regionWidths.add(sample.regionWidths);
    }

    if (sample.segmentProfile) {
      this.segmentProfile.add(sample.segmentProfile);
    }

    this.samples++;
  }

  end() {
    const out = {
      durationMs: performance.now() - this.startTs,
      samples: this.samples,
      structure: this.structure.mean,
      balance: this.balance.mean,
      posture: this.posture.mean,
      velocity: this.velocity.mean,
      emotions: {},
      regionWidths: this.regionWidths.means.slice(),
      segmentProfile: this.segmentProfile.means.slice()
    };

    for (const k in this.emotions) {
      out.emotions[k] = this.emotions[k].mean;
    }

    this.active = false;
    console.log('[SESSION] Ended:', out);
    return out;
  }
}

/* =============================
   GLOBAL SESSION INSTANCE
   ============================= */
window.__ebSession = new SessionAverager();
window.__ebSessionReady = true;

/* =============================
   GLOBAL API BINDINGS
   ============================= */
window.beginSession = function () {
  if (!window.__ebSession) {
    window.__ebSession = new SessionAverager();
  }
  window.__ebSession.begin();
};

// Placeholder for onPrint - will be overridden by sketch.js
window.onPrint = function () {
  console.warn('[PRINT] eb-init.js placeholder - sketch.js should override this');
};

console.log('✅ eb-init.js loaded - session tracking ready');
