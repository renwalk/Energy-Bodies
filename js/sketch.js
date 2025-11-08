/* ============================================================================
   ENERGY BODIES — DISPLAY SKETCH
   Date: 2025-11-08
   IMPORTANT: Load eb-init.js BEFORE this file!
   ============================================================================ */

// Verify eb-init.js loaded
if (typeof window.beginSession !== 'function') {
  console.error('[SKETCH] ERROR: eb-init.js must be loaded first!');
}

/* =============================
   0) MASTER TUNING CONSTANTS
   ============================= */
const TUNE = {
  velocity: {
    kpMinScore: 0.5,
    vNormInMin: 0.015,
    vNormInMax: 0.2,
    vBlend: 0.125,
    fastEMA: 0.8,
    slowEMA: 0.01,
    angerBurstMin: 0.02,
    angerBurstMax: 1
  },
  emotions: {
    blendPoseVsSlider: 0.30,
    anxietyFromVel: { inMin: 0.3, inMax: 1.5, outMin: 0, outMax: 5 },
    calmFromBalance: { inMin: 0.2, inMax: 50, outMin: 5, outMax: 0 },
    sadnessFromAvgY: { inMin: 0, inMax: null, outMin: 0, outMax: 5 },
    fearFromLean: { inMin: 0, inMax: 100, outMin: 0, outMax: 5 },
    joyFromStructure: { inMin: 0.25, inMax: 1.0, outMin: 0, outMax: 5 }
  },
  follow: {
    enabledFreshMs: 300,
    axis: 'both',
    lerp: { tx: 0.20, ty: 0.20, rot: 0.18, sc: 0.12 }
  },
  coupling: {
    armsHands: { wristSpreadMin: 2, wristSpreadMax: 5.0, lerp: 0.12 },
    spine: { swayRange: 1.0, lerp: 0.20 },
    head: { velMin: 0.035, velMax: 0.05, lerp: 0.10 },
    neck: { velMin: 0.0005, velMax: 0.015, lerp: 0.18 },
    chest: { velMin: 0.00005, velMax: 0.010, reachMin: 0.7, reachMax: 2.0, lerp: 0.20 },
    abdomen: { velMin: 0.025, velMax: 0.0325, torsoMin: 1.20, torsoMax: 1.40, lerp: 0.10 },
    legsFeet: { velMin: 0.0001, velMax: 0.012, ankleSpreadMin: 0.9, ankleSpreadMax: 3.0, lerp: 0.20 }
  },
  visuals: {
    fear: { baseScaleFrom: 3.0, baseScaleTo: 0.6, freqFrom: 0.1, freqTo: 5.0, pulseAmp: 0.05 },
    anxiety: {
      spacingChaotic: { from: 40, to: 8 },
      spacingCalm: { from: 50, to: 20 },
      lineLenChaotic: { from: 4, to: 12 },
      lineLenCalm: { from: 20, to: 100 },
      jitterMax: 25,
      irregularityMax: 0.4,
      angleScaleChaotic: 0.02,
      angleScaleCalm: 0.005,
      curlMax: 80,
      alphaMin: 20, alphaMax: 255,
      minSpacingPx: 14,
      maxStrokes: 6000
    },
    marbles: { gridSpacing: 18, alphaPerUnit: 70 }
  }
};

/* =============================
   1) RUNTIME STATE & CONSTANTS
   ============================= */
console.log('✅ sketch.js loading...');

let displayOrientation = 'landscape';
let scene, orientationChannel;
let video, poseNet, poses = [];
let trackingStarted = false;

let __prevKeypoints = null;
let __prevByPart = new Map();

let __lastPoseEmitAt = 0;
const POSE_EMIT_MS = 80;

let segmentProfile = [0.0, 1.0, 0.0];
let shapeMask, patternGraphics, originOffset, emotionGraphics;

let movementVelocity = 0;
let smoothedStructure = 0;
let smoothedBalance = 0;
let smoothedPostureLean = 0;
let smoothedAvgY = 0;
let fastVel = 0, slowVel = 0;

let followPose = false, followAxis = 'both';
let poseTx = 0, poseTy = 0, poseRot = 0, poseSc = 1, _poseSeenAt = 0;

const regionNames = ['head', 'neck', 'armsHands', 'chest', 'abdomen', 'legsFeet'];
const emotionNames = ['anxiety', 'sadness', 'joy', 'anger', 'fear', 'calm'];
let regionSliders = {}, emotionSliders = {};
let regionOffsets = {};
for (const r of regionNames) regionOffsets[r] = { x: 0, y: 0 };

const regionKeypoints = {
  head: ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar'],
  neck: ['leftShoulder', 'rightShoulder'],
  chest: ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist'],
  armsHands: ['leftWrist', 'rightWrist', 'leftElbow', 'rightElbow'],
  abdomen: ['leftHip', 'rightHip'],
  legsFeet: ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle']
};

const EDGES = [
  ['leftShoulder', 'rightShoulder'],
  ['leftHip', 'rightHip'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
  ['leftShoulder', 'nose'], ['rightShoulder', 'nose'],
];

const UI_WIDTH = 320, CANVAS_PADDING = 20;
let K = 1;
let regionMaxWidths = {
  head: 60, neck: 20, chest: 50, armsHands: 150,
  abdomen: 80, legsFeet: 100, spine: 100
};

/* =============================
   2) AVERAGING CLASSES
   ============================= */
class OnlineMean {
  constructor() { this.mean = 0; this.n = 0; }
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

// Global session instance
window.__ebSession = null;

/* =============================
   3) GLOBAL API BINDINGS
   ============================= */
window.beginSession = function () {
  if (!window.__ebSession) {
    window.__ebSession = new SessionAverager();
  }
  window.__ebSession.begin();
};

window.onPrint = function () {
  console.log('[PRINT] Triggered');
  onPrintAverageThenSnapshot();
};

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/* =============================
   4) P5 SETUP / DRAW
   ============================= */
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  colorMode(RGB);
  angleMode(RADIANS);
  noFill();
  stroke(255);
  strokeWeight(2);

  scene = createGraphics(width, height);
  patternGraphics = createGraphics(width, height);
  shapeMask = createGraphics(width, height);
  emotionGraphics = createGraphics(width, height);

  [scene, patternGraphics, shapeMask, emotionGraphics].forEach(g => {
    g.colorMode(RGB);
    g.noFill();
    g.stroke(255);
    g.strokeWeight(2);
  });

  originOffset = createVector(width / 2, height / 2);

  // Initialize session
  window.__ebSession = new SessionAverager();
  console.log('[SESSION] Initialized');

  // Initialize sliders
  emotionNames.forEach(name => {
    let val = 0;
    emotionSliders[name] = {
      value: (v) => {
        if (v !== undefined) val = v;
        return val;
      }
    };
  });

  regionNames.forEach(name => {
    let val = 0;
    regionSliders[name] = {
      value: (v) => {
        if (v !== undefined) val = v;
        return val;
      }
    };
  });

  let spineVal = 0;
  regionSliders['spine'] = {
    value: (v) => {
      if (v !== undefined) spineVal = v;
      return spineVal;
    }
  };

  // Setup video
  const constraints = {
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 }
    },
    audio: false
  };

  video = createCapture(constraints, () => {
    console.log('🎥 Webcam ready');
  });
  video.size(640, 480);
  video.elt.playsInline = true;
  video.hide();

  // Setup PoseNet
  poseNet = ml5.poseNet(video, { detectionType: 'single' }, () => {
    console.log('🧠 PoseNet model loaded');
  });

  poseNet.on('pose', results => {
    if (!trackingStarted) return;
    poses = results;
    const pose = results[0]?.pose;
    if (!pose) return;

    updatePoseFactors(pose);
    updatePoseTransform(pose);
    coupleRegionsToPose(pose);
    updatePoseAnchor(pose);

    maybeEchoState();
    emitPoseMetrics();

    const now = millis();
    if (now - __lastPoseEmitAt >= POSE_EMIT_MS) {
      __lastPoseEmitAt = now;
      emitPoseToControl(pose);
    }
  });

  // Listen for orientation changes
  window.addEventListener('eb:orientation', (ev) => {
    const mode = ev.detail?.value;
    if (mode && mode !== displayOrientation) {
      displayOrientation = mode;
      console.log('[DISPLAY] Orientation →', displayOrientation);
    }
  });

  window.applySliders = applySliders;
  window.resetAll = resetAll;
}

function draw() {
  fill(255);
  noStroke();
  textSize(14);
  text(`poses: ${poses?.length || 0} | tracking: ${trackingStarted}`, 12, 20);

  // Show session status
  if (window.__ebSession?.active) {
    text(`Recording: ${window.__ebSession.samples} samples`, 12, 40);
  }

  K = Math.min(width, height) / 900;
  regionMaxWidths = {
    head: 60 * K,
    neck: 20 * K,
    chest: 50 * K,
    armsHands: 150 * K,
    abdomen: 80 * K,
    legsFeet: 100 * K,
    spine: 100 * K
  };

  scene.clear();
  patternGraphics.clear();
  emotionGraphics.clear();
  shapeMask.clear();

  const vals = {};
  for (let n of emotionNames) vals[n] = emotionSliders[n].value();

  const fearAmt = vals.fear / 5;
  const sadnessAmt = vals.sadness / 5;
  const joyAmt = vals.joy / 5;
  const angerAmt = vals.anger / 5;
  const anxietyVal = vals.anxiety;
  const calmAmt = vals.calm / 5;

  const FV = TUNE.visuals.fear;
  const baseScale = lerp(FV.baseScaleFrom, FV.baseScaleTo, fearAmt);
  const fearFreq = lerp(FV.freqFrom, FV.freqTo, fearAmt);
  const pulse = FV.pulseAmp * Math.sin(frameCount * fearFreq);
  const fearScale = baseScale + pulse;

  let baseRegionSpacings = regionNames.map((region, i) => {
    let base = [30, 20, 30, 15, 20, 50][i] * K;
    if (region === 'armsHands') return base + 30 * K;
    if (region === 'legsFeet') return base + 60 * K;
    return base;
  });

  const totalBaseHeight = baseRegionSpacings.reduce((a, b) => a + b, 0);
  const maxBodyHeight = height * 0.7;
  const bodyHeightScale = maxBodyHeight / totalBaseHeight;
  const regionSpacings = baseRegionSpacings.map(s => s * bodyHeightScale);

  drawBodyShape(regionSpacings, fearScale);
  drawEmotionLayers(emotionGraphics, joyAmt, sadnessAmt, angerAmt);
  drawAnxietyPattern(patternGraphics, anxietyVal, calmAmt);

  const maskImage = shapeMask.get();
  const emotionImage = emotionGraphics.get();
  const patternImage = patternGraphics.get();

  emotionImage.mask(maskImage);
  patternImage.mask(maskImage);
  scene.image(emotionImage, 0, 0);
  scene.image(patternImage, 0, 0);

  blitSceneTranslateOnly(scene);

  push();
  noStroke();
  fill(255);
  textSize(14);
  text(`[${displayOrientation}]`, 12, 60);
  pop();
}

/* =============================
   5) TRACKING TOGGLES (FIXED)
   ============================= */
function startTrackingImpl() {
  if (trackingStarted) return;

  trackingStarted = true;
  window.__ebTrackingStarted = true;

  // Start the session when tracking starts
  if (window.__ebSession && window.__ebSessionReady) {
    if (!window.__ebSession.active) {
      window.__ebSession.begin();
    }
  }

  if (window.EnergyBodiesDisplay) {
    EnergyBodiesDisplay.tracking(true);
  }
}

function stopTrackingImpl() {
  if (!trackingStarted) return;

    // Generate enhanced receipt with session data
    const receiptHTML = generateReceiptHTML(dataURL, avg);

    const w = window.open('', '_blank');
    w.document.write(receiptHTML);
    w.document.close();
    w.onload = () => { w.focus(); w.print(); };
  });
}

function generateReceiptHTML(imageDataURL, sessionData) {
  const timestamp = new Date().toLocaleString();
  const durationSec = (sessionData.durationMs / 1000).toFixed(1);

  // Format numbers
  const fmt = (val) => (typeof val === 'number' ? val.toFixed(2) : '0.00');
  const fmtPct = (val) => (typeof val === 'number' ? (val * 100).toFixed(0) + '%' : '0%');

  // Build emotion rows
  let emotionRows = '';
  for (const name of (emotionNames||[])) {
    const val = sessionData.emotions?.[name] ?? 0;
    const barWidth = (val / 5) * 100;
    emotionRows += `
      <tr>
        <td class="label">${name.charAt(0).toUpperCase() + name.slice(1)}</td>
        <td class="value">${fmt(val)}</td>
        <td class="bar">
          <div class="bar-fill" style="width: ${barWidth}%"></div>
        </td>
      </tr>
    `;
  }

  // Build region rows
  let regionRows = '';
  for (let i = 0; i < (regionNames||[]).length; i++) {
    const name = regionNames[i];
    const val = sessionData.regionWidths?.[i] ?? 0;
    const barWidth = (val / 5) * 100;
    const displayName = name.replace(/([A-Z])/g, ' $1').trim();
    regionRows += `
      <tr>
        <td class="label">${displayName.charAt(0).toUpperCase() + displayName.slice(1)}</td>
        <td class="value">${fmt(val)}</td>
        <td class="bar">
          <div class="bar-fill" style="width: ${barWidth}%"></div>
        </td>
      </tr>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Energy Body Receipt</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body {
            background: #000;
            color: #fff;
            font-family: 'Courier New', monospace;
            font-size: 11px;
          }
          .receipt {
            width: 4in;
            margin: 0 auto;
            background: #000;
            padding: 0.25in;
          }
          .header {
            text-align: center;
            border-bottom: 2px dashed #fff;
            padding-bottom: 10px;
            margin-bottom: 15px;
          }
          .header h1 {
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 5px;
            letter-spacing: 1px;
          }
          .header .timestamp {
            font-size: 9px;
            opacity: 0.8;
          }
          .image-container {
            width: 100%;
            margin: 15px 0;
            text-align: center;
          }
          .image-container img {
            width: 100%;
            height: auto;
            border: 1px solid #fff;
          }
          .section {
            margin: 15px 0;
            border-top: 1px dashed #666;
            padding-top: 10px;
          }
          .section-title {
            font-weight: bold;
            font-size: 12px;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .meta-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-bottom: 10px;
          }
          .meta-item {
            font-size: 10px;
          }
          .meta-item .label {
            opacity: 0.7;
          }
          .meta-item .value {
            font-weight: bold;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 5px;
          }
          tr {
            border-bottom: 1px solid #333;
          }
          td {
            padding: 5px 2px;
            font-size: 10px;
          }
          td.label {
            width: 40%;
            text-transform: capitalize;
          }
          td.value {
            width: 20%;
            text-align: right;
            font-weight: bold;
          }
          td.bar {
            width: 40%;
            padding-left: 8px;
          }
          .bar-fill {
            height: 8px;
            background: #fff;
            transition: width 0.3s;
          }
          .core-metrics {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 8px;
          }
          .metric {
            text-align: center;
            padding: 8px;
            border: 1px solid #444;
          }
          .metric .name {
            font-size: 9px;
            opacity: 0.7;
            margin-bottom: 3px;
          }
          .metric .val {
            font-size: 14px;
            font-weight: bold;
          }
          .footer {
            margin-top: 20px;
            padding-top: 10px;
            border-top: 2px dashed #fff;
            text-align: center;
            font-size: 9px;
            opacity: 0.6;
          }
          @page {
            size: 4in 6in;
            margin: 0;
          }
          @media print {
            body { background: #000; }
            .receipt { margin: 0; }
          }
        </style>
      </head>
      <body>
        <div class="receipt">
          <!-- Header -->
          <div class="header">
            <h1>ENERGY BODY</h1>
            <div class="timestamp">${timestamp}</div>
          </div>

          <!-- Session Info -->
          <div class="section">
            <div class="section-title">Session Summary</div>
            <div class="meta-grid">
              <div class="meta-item">
                <div class="label">Duration:</div>
                <div class="value">${durationSec}s</div>
              </div>
              <div class="meta-item">
                <div class="label">Samples:</div>
                <div class="value">${sessionData.samples}</div>
              </div>
            </div>
          </div>

          <!-- Energy Body Image -->
          <div class="image-container">
            <img src="${imageDataURL}" alt="Energy Body">
          </div>

          <!-- Core Metrics -->
          <div class="section">
            <div class="section-title">Core Metrics</div>
            <div class="core-metrics">
              <div class="metric">
                <div class="name">Structure</div>
                <div class="val">${fmtPct(sessionData.structure)}</div>
              </div>
              <div class="metric">
                <div class="name">Balance</div>
                <div class="val">${fmt(sessionData.balance)}</div>
              </div>
              <div class="metric">
                <div class="name">Posture</div>
                <div class="val">${fmtPct(sessionData.posture)}</div>
              </div>
              <div class="metric">
                <div class="name">Velocity</div>
                <div class="val">${fmtPct(sessionData.velocity)}</div>
              </div>
            </div>
          </div>

          <!-- Emotions -->
          <div class="section">
            <div class="section-title">Emotional State</div>
            <table>
              ${emotionRows}
            </table>
          </div>

          <!-- Body Regions -->
          <div class="section">
            <div class="section-title">Region Activity</div>
            <table>
              ${regionRows}
            </table>
          </div>

          <!-- Footer -->
          <div class="footer">
            Energy Bodies — Session ${Date.now().toString().slice(-6)}
          </div>
        </div>
      </body>
    </html>
  `;
}

function onPrintSnapshotFallback(){
  const dataURL = captureEnergyBodyHiRes();
  const w = window.open('', '_blank');
  w.document.write(`
    <html><head><title>Print Energy Body</title>
      <style>
        html,body{margin:0;padding:0;background:#000;}
        img{width:100%;height:auto;display:block;}
        @page { size: 4in 6in; margin: 0; }
      </style>
    </head>
    <body><img src="${dataURL}"></body></html>
  `);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
}

// Register implementations with eb-init.js
window.__ebStartTrackingImpl = startTrackingImpl;
window.__ebStopTrackingImpl = stopTrackingImpl;
window.__ebTrackingReady = true;

/* =============================
   6) POSE → EMOTION FACTORS
   ============================= */
function updatePoseFactors(pose) {
  if (!pose || !pose.keypoints) return;

  const kp = pose.keypoints.filter(k => k.score > TUNE.velocity.kpMinScore);
  if (!kp.length) return;

  // Calculate velocity
  let velAvg = 0;
  if (__prevKeypoints) {
    const diag = Math.hypot(video?.width || 640, video?.height || 480) || 1;
    let sum = 0, n = 0;
    for (const k of kp) {
      const prev = __prevKeypoints.find(p => p.part === k.part);
      if (!prev) continue;
      const dx = (k.position.x - prev.position.x) / diag;
      const dy = (k.position.y - prev.position.y) / diag;
      sum += Math.hypot(dx, dy);
      n++;
    }
    if (n > 0) velAvg = sum / n;
  }
  __prevKeypoints = kp.map(k => ({
    part: k.part,
    position: { x: k.position.x, y: k.position.y }
  }));

  const vNorm = clamp01(map(velAvg, TUNE.velocity.vNormInMin, TUNE.velocity.vNormInMax, 0, 1));
  movementVelocity = lerp(movementVelocity, vNorm, TUNE.velocity.vBlend);
  fastVel = lerp(fastVel, vNorm, TUNE.velocity.fastEMA);
  slowVel = lerp(slowVel, vNorm, TUNE.velocity.slowEMA);

  const burst = Math.max(0, fastVel - slowVel);
  const poseAnger = clamp01(map(burst, TUNE.velocity.angerBurstMin, TUNE.velocity.angerBurstMax, 0, 1)) * 5;

  // Calculate structure
  const Ls = pose.leftShoulder;
  const Rs = pose.rightShoulder;
  const Lw = pose.leftWrist;
  const Rw = pose.rightWrist;

  let structure = 0;
  if (Ls && Rs && Lw && Rw) {
    const span = dist(Ls.x, Ls.y, Rs.x, Rs.y);
    const lw = dist(Ls.x, Ls.y, Lw.x, Lw.y) / span;
    const rw = dist(Rs.x, Rs.y, Rw.x, Rw.y) / span;
    structure = clamp01(map((lw + rw) * 0.5, 0.7, 2.0, 0, 1));
  }
  smoothedStructure = lerp(smoothedStructure, structure, 0.15);

  // Balance
  const shoulderDiff = Math.abs(Ls?.y - Rs?.y);
  const hipDiff = Math.abs(pose.leftHip?.y - pose.rightHip?.y);
  smoothedBalance = lerp(smoothedBalance, (shoulderDiff + hipDiff), 0.15);

  // Posture lean
  let lean = 0;
  if (Ls && Rs && pose.leftHip && pose.rightHip) {
    const sx = (Ls.x + Rs.x) / 2;
    const sy = (Ls.y + Rs.y) / 2;
    const hx = (pose.leftHip.x + pose.rightHip.x) / 2;
    const hy = (pose.leftHip.y + pose.rightHip.y) / 2;
    const ang = Math.atan2(hy - sy, hx - sx);
    lean = clamp01(map(Math.abs(ang), 0.0, Math.PI / 6, 0, 1));
  }
  smoothedPostureLean = lerp(smoothedPostureLean, lean, 0.15);

  // Average Y position
  const avgY = (pose.leftShoulder.y + pose.rightShoulder.y) / 2;
  smoothedAvgY = lerp(smoothedAvgY, avgY, 0.1);

  // Map to emotions
  const E = TUNE.emotions;
  if (E.sadnessFromAvgY.inMax === null) E.sadnessFromAvgY.inMax = height;

  let poseAnxiety = constrain(
    map(movementVelocity, E.anxietyFromVel.inMin, E.anxietyFromVel.inMax,
      E.anxietyFromVel.outMin, E.anxietyFromVel.outMax), 0, 5
  );
  let poseCalm = constrain(
    map(smoothedBalance, E.calmFromBalance.inMin, E.calmFromBalance.inMax,
      E.calmFromBalance.outMin, E.calmFromBalance.outMax), 0, 5
  );
  let poseSadness = constrain(
    map(smoothedAvgY, E.sadnessFromAvgY.inMin, E.sadnessFromAvgY.inMax,
      E.sadnessFromAvgY.outMin, E.sadnessFromAvgY.outMax), 0, 5
  );
  let poseFear = constrain(
    map(smoothedPostureLean, E.fearFromLean.inMin, E.fearFromLean.inMax,
      E.fearFromLean.outMin, E.fearFromLean.outMax), 0, 5
  );
  let poseJoy = constrain(
    map(smoothedStructure, E.joyFromStructure.inMin, E.joyFromStructure.inMax,
      E.joyFromStructure.outMin, E.joyFromStructure.outMax), 0, 5
  );

  const BL = E.blendPoseVsSlider;
  const blend = (p, s) => lerp(s, p, BL);

  emotionSliders.anxiety.value(blend(poseAnxiety, emotionSliders.anxiety.value()));
  emotionSliders.calm.value(blend(poseCalm, emotionSliders.calm.value()));
  emotionSliders.sadness.value(blend(poseSadness, emotionSliders.sadness.value()));
  emotionSliders.fear.value(blend(poseFear, emotionSliders.fear.value()));
  emotionSliders.joy.value(blend(poseJoy, emotionSliders.joy.value()));
  emotionSliders.anger.value(blend(poseAnger, emotionSliders.anger.value()));
}

/* =============================
   7) REGION COUPLING
   ============================= */
function regionVelocity(pose, parts) {
  const diag = Math.hypot(video?.width || 640, video?.height || 480) || 1;
  let sum = 0, n = 0;

  for (const name of parts) {
    const k = pose.keypoints.find(p => p.part === name && p.score > TUNE.velocity.kpMinScore);
    if (!k) continue;

    const prev = __prevByPart.get(name);
    if (prev) {
      const dx = (k.position.x - prev.x) / diag;
      const dy = (k.position.y - prev.y) / diag;
      sum += Math.hypot(dx, dy);
      n++;
    }
    __prevByPart.set(name, { x: k.position.x, y: k.position.y });
  }

  return n > 0 ? (sum / n) : 0;
}

function coupleRegionsToPose(pose) {
  if (!pose || !pose.keypoints) return;

  const C = TUNE.coupling;
  const get = part => {
    const k = pose.keypoints.find(p => p.part === part && p.score > TUNE.velocity.kpMinScore);
    return k ? k.position : null;
  };

  const ls = get('leftShoulder');
  const rs = get('rightShoulder');
  const lh = get('leftHip');
  const rh = get('rightHip');
  const lw = get('leftWrist');
  const rw = get('rightWrist');
  const la = get('leftAnkle');
  const ra = get('rightAnkle');

  // Head
  {
    const v = regionVelocity(pose, regionKeypoints.head);
    const val = constrain(map(v, C.head.velMin, C.head.velMax, 0, 5), 0, 5);
    regionSliders.head.value(lerp(regionSliders.head.value(), val, C.head.lerp));
  }

  // Neck
  {
    const v = regionVelocity(pose, regionKeypoints.neck);
    const val = constrain(map(v, C.neck.velMin, C.neck.velMax, 0, 5), 0, 5);
    regionSliders.neck.value(lerp(regionSliders.neck.value(), val, C.neck.lerp));
  }

  // Arms & Hands
  if (lw && rw && ls && rs) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    const wristSpread = dist(lw.x, lw.y, rw.x, rw.y) / Math.max(span, 1e-6);
    const base = constrain(
      map(wristSpread, C.armsHands.wristSpreadMin, C.armsHands.wristSpreadMax, 0, 5), 0, 5
    );
    const v = regionVelocity(pose, regionKeypoints.armsHands);
    const boost = constrain(map(v, C.head.velMin, C.chest.velMax, 0, 5), 0, 5) * 0.5;
    const armsVal = constrain(base + boost, 0, 5);
    regionSliders.armsHands.value(lerp(regionSliders.armsHands.value(), armsVal, C.armsHands.lerp));
  }

  // Chest
  if (ls && rs) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    let openness = 0;
    if (lw && rw) {
      const lwR = dist(ls.x, ls.y, lw.x, lw.y) / span;
      const rwR = dist(rs.x, rs.y, rw.x, rw.y) / span;
      openness = (lwR + rwR) * 0.5;
    }
    const openVal = constrain(map(openness, C.chest.reachMin, C.chest.reachMax, 0, 5), 0, 5);
    const v = regionVelocity(pose, regionKeypoints.chest);
    const vVal = constrain(map(v, C.chest.velMin, C.chest.velMax, 0, 5), 0, 5);
    const chestVal = constrain(0.6 * openVal + 0.4 * vVal, 0, 5);
    regionSliders.chest.value(lerp(regionSliders.chest.value(), chestVal, C.chest.lerp));
  }

  // Abdomen
  if (ls && rs && lh && rh) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    const scx = (ls.x + rs.x) / 2;
    const scy = (ls.y + rs.y) / 2;
    const hcx = (lh.x + rh.x) / 2;
    const hcy = (lh.y + rh.y) / 2;
    const torsoLen = dist(scx, scy, hcx, hcy) / Math.max(span, 1e-6);
    const torsoVal = 5 - constrain(map(torsoLen, C.abdomen.torsoMin, C.abdomen.torsoMax, 0, 5), 0, 5);
    const v = regionVelocity(pose, regionKeypoints.abdomen);
    const vVal = constrain(map(v, C.abdomen.velMin, C.abdomen.velMax, 0, 5), 0, 5);
    const abdVal = constrain(0.6 * torsoVal + 0.4 * vVal, 0, 5);
    regionSliders.abdomen.value(lerp(regionSliders.abdomen.value(), abdVal, C.abdomen.lerp));
  }

  // Legs & Feet
  if (la && ra && lh && rh) {
    const hipSpan = dist(lh.x, lh.y, rh.x, rh.y);
    const stepW = dist(la.x, la.y, ra.x, ra.y) / Math.max(hipSpan, 1e-6);
    const spreadVal = constrain(
      map(stepW, C.legsFeet.ankleSpreadMin, C.legsFeet.ankleSpreadMax, 0, 5), 0, 5
    );
    const v = regionVelocity(pose, regionKeypoints.legsFeet);
    const vVal = constrain(map(v, C.legsFeet.velMin, C.legsFeet.velMax, 0, 5), 0, 5);
    const legsVal = constrain(0.5 * spreadVal + 0.5 * vVal, 0, 5);
    regionSliders.legsFeet.value(lerp(regionSliders.legsFeet.value(), legsVal, C.legsFeet.lerp));
  }

  // Spine
  if (ls && rs) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    const spineSway = ((ls.x + rs.x) * 0.5 - (video?.width || 640) / 2) / Math.max(span, 1e-6);
    const spineVal = map(
      spineSway,
      -TUNE.coupling.spine.swayRange,
      TUNE.coupling.spine.swayRange,
      0,
      regionMaxWidths.spine || 100
    );
    regionSliders['spine'].value(lerp(regionSliders['spine'].value(), spineVal, TUNE.coupling.spine.lerp));
  }
}

/* =============================
   8) POSE TRANSFORM & ANCHOR
   ============================= */
function updatePoseTransform(pose) {
  if (!pose || !pose.keypoints) return;

  const get = part => {
    const k = pose.keypoints.find(p => p.part === part);
    return (k && k.score > TUNE.velocity.kpMinScore) ? k.position : null;
  };

  const ls = get('leftShoulder');
  const rs = get('rightShoulder');
  const lh = get('leftHip');
  const rh = get('rightHip');

  if (!(ls && rs && lh && rh)) return;

  const cx = (ls.x + rs.x + lh.x + rh.x) / 4;
  const cy = (ls.y + rs.y + lh.y + rh.y) / 4;
  const sx = (ls.x + rs.x) / 2;
  const sy = (ls.y + rs.y) / 2;
  const hx = (lh.x + rh.x) / 2;
  const hy = (lh.y + rh.y) / 2;
  const ang = Math.atan2(hy - sy, hx - sx) - Math.PI / 2;
  const shoulderW = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const baseline = 220;
  const s = constrain(shoulderW / baseline, 0.6, 1.8);

  const L = TUNE.follow.lerp;
  poseTx = lerp(poseTx, cx, L.tx);
  poseTy = lerp(poseTy, cy, L.ty);
  poseRot = lerp(poseRot, ang, L.rot);
  poseSc = lerp(poseSc, s, L.sc);
  _poseSeenAt = millis();
}

function updatePoseAnchor(pose) {
  if (!pose || !pose.keypoints) return;

  const get = part => {
    const k = pose.keypoints.find(p => p.part === part);
    return (k && k.score > TUNE.velocity.kpMinScore) ? k.position : null;
  };

  const ls = get('leftShoulder');
  const rs = get('rightShoulder');
  const lh = get('leftHip');
  const rh = get('rightHip');

  if (!(ls && rs && lh && rh)) return;

  const cx = (ls.x + rs.x + lh.x + rh.x) / 4;
  const cy = (ls.y + rs.y + lh.y + rh.y) / 4;
  poseTx = lerp(poseTx, cx, 0.25);
  poseTy = lerp(poseTy, cy, 0.25);
  _poseSeenAt = millis();
}

/* =============================
   9) CONTROL PANEL COMMUNICATION
   ============================= */
function emitPoseToControl(pose) {
  if (!window.EnergyBodiesDisplay || !pose?.keypoints?.length) return;

  const vw = video?.width || 640;
  const vh = video?.height || 480;
  const pts = pose.keypoints.map(k => [
    k.part,
    k.position.x / vw,
    k.position.y / vh,
    k.score
  ]);

  window.EnergyBodiesDisplay.pose({
    keypoints: pts,
    vw,
    vh,
    t: millis()
  });
}

let __lastEmitMs = 0;
function emitPoseMetrics() {
  // Add to session if active
  if (trackingStarted && window.__ebSession?.active) {
    const p = poses?.[0]?.pose;
    if (p && p.score > 0.25) {
      window.__ebSession.add(buildSampleForThisFrame());
    }
  }

  const now = millis();
  if (now - __lastEmitMs < 80) return;
  __lastEmitMs = now;

  if (window.EnergyBodiesDisplay) {
    const h = video?.height || 480;
    const normBalance = smoothedBalance / h;
    const normPosture = smoothedPostureLean;
    const normAvgY = smoothedAvgY / h;

    EnergyBodiesDisplay.pose({
      movementVelocity,
      fastVel,
      structure: smoothedStructure,
      balance: normBalance,
      postureLean: normPosture,
      avgY: normAvgY
    });
  }
}

let __lastEcho = 0;
function maybeEchoState() {
  const t = millis();
  if (!window.EnergyBodiesDisplay) return;
  if (t - __lastEcho < 250) return;
  __lastEcho = t;

  const emotion = {};
  const region = {};

  for (const n of emotionNames) {
    emotion[n] = Number(emotionSliders[n].value());
  }

  for (const n of [...regionNames, 'spine']) {
    region[n] = Number(regionSliders[n]?.value() || 0);
  }

  EnergyBodiesDisplay.echo({ emotion, region });
}

/* =============================
   10) DRAWING FUNCTIONS
   ============================= */
function blitSceneTranslateOnly(sceneGfx) {
  clear();
  push();
  imageMode(CENTER);

  const vw = video?.width || width;
  const vh = video?.height || height;
  let s;

  if (displayOrientation === 'portrait') {
    translate(0, height);
    rotate(-HALF_PI);
    s = Math.min(height / vw, width / vh);
  } else {
    s = Math.min(width / vw, height / vh);
  }

  let cx = width / 2;
  let cy = height / 2;

  if (followPose && (millis() - _poseSeenAt < TUNE.follow.enabledFreshMs)) {
    const dx = (poseTx - vw / 2) * s;
    const dy = (poseTy - vh / 2) * s;
    if (followAxis === 'both' || followAxis === 'x') cx += dx;
    if (followAxis === 'both' || followAxis === 'y') cy += dy;
  }

  translate(cx, cy);

  if (displayOrientation === 'portrait') {
    image(sceneGfx, 0, 0, height, width);
  } else {
    image(sceneGfx, 0, 0, width, height);
  }

  pop();
}

function drawBodyShape(regionSpacings, fearScale) {
  let stepsPerRegion = 2;
  let spacingAccumulator = -regionSpacings.reduce((a, b) => a + b, 0) / 2;
  let leftSide = [], rightSide = [], crotchPoints = [];
  const legTaper = 60 * K;
  const domeOffset = 60 * K;

  for (let i = 0; i < regionNames.length; i++) {
    for (let s = 0; s < stepsPerRegion; s++) {
      let t = s / (stepsPerRegion - 1);
      let y = spacingAccumulator + t * (regionSpacings[i] || 60 * K);

      if (regionNames[i] === 'chest') y -= 60 * K;
      if (regionNames[i] === 'armsHands') y += map(t, 0, 1, 0, 40 * K);
      if (regionNames[i] === 'legsFeet') y += map(t, 0, 1, 0, 80 * K);

      let spineOffset = regionSliders['spine'].value();
      let sliderVal = regionSliders[regionNames[i]].value();
      let maxWidth = regionMaxWidths[regionNames[i]] || 80 * K;
      let halfWidth = map(sliderVal, 0, 5, 0, maxWidth) * fearScale;

      if (regionNames[i] === 'legsFeet') {
        halfWidth -= map(t, 0, 1, 0, legTaper);
      }

      leftSide.push(createVector(
        -halfWidth - spineOffset / 2 + originOffset.x,
        y + originOffset.y
      ));
      rightSide.unshift(createVector(
        halfWidth + spineOffset / 2 + originOffset.x,
        y + originOffset.y
      ));

      if (regionNames[i] === 'legsFeet' && s === stepsPerRegion - 1) {
        crotchPoints.push(createVector(
          originOffset.x,
          y + originOffset.y - 300 * K
        ));
      }
    }
    spacingAccumulator += regionSpacings[i];
  }

  let domeY = leftSide[0].y - domeOffset;
  let leftAnchor = createVector(originOffset.x, domeY);
  let rightAnchor = createVector(originOffset.x, domeY);
  let fullShape = [leftAnchor, ...leftSide, ...crotchPoints, ...rightSide, rightAnchor];

  // Draw mask
  shapeMask.noStroke();
  shapeMask.fill(255);
  shapeMask.curveTightness(-0.5);
  shapeMask.beginShape();
  shapeMask.curveVertex(fullShape[0].x, fullShape[0].y);
  for (let pt of fullShape) {
    shapeMask.curveVertex(pt.x, pt.y);
  }
  shapeMask.curveVertex(fullShape[fullShape.length - 1].x, fullShape[fullShape.length - 1].y);
  shapeMask.endShape(CLOSE);

  // Draw outline
  scene.push();
  scene.noFill();
  scene.stroke(0);
  scene.strokeWeight(1 * K);
  scene.curveTightness(-0.5);
  scene.beginShape();
  scene.curveVertex(fullShape[0].x, fullShape[0].y);
  for (let pt of fullShape) {
    scene.curveVertex(pt.x, pt.y);
  }
  scene.curveVertex(fullShape[fullShape.length - 1].x, fullShape[fullShape.length - 1].y);
  scene.endShape(CLOSE);
  scene.pop();

  return fullShape;
}

// Register print implementation
window.__ebPrintImpl = onPrintAverageThenSnapshot;

function drawAnxietyPattern(pg, val, calm) {
  pg.clear();
  const A = TUNE.visuals.anxiety;
  const alpha = lerp(A.alphaMax, A.alphaMin, calm);
  pg.stroke(255, alpha);
  pg.strokeWeight(2 * K);
  pg.noFill();

  let baseSpacing = lerp(
    map(val, 0, 5, A.spacingChaotic.from, A.spacingChaotic.to),
    map(val, 0, 5, A.spacingCalm.from, A.spacingCalm.to),
    calm
  ) * K;
  baseSpacing = Math.max(baseSpacing, A.minSpacingPx);

  const lineLength = lerp(
    map(val, 0, 5, A.lineLenChaotic.from, A.lineLenChaotic.to),
    map(val, 0, 5, A.lineLenCalm.from, A.lineLenCalm.to),
    calm
  ) * K;

  const jitterAmount = lerp(map(val, 0, 5, 0, A.jitterMax), 0, calm) * K;
  const irregularity = lerp(map(val, 0, 5, 0, A.irregularityMax), 0, calm);
  const angleScale = lerp(A.angleScaleChaotic, A.angleScaleCalm, calm);
  const curlStrength = lerp(0, A.curlMax, calm) * K;

  const cols = Math.ceil(width / baseSpacing);
  const rows = Math.ceil(height / baseSpacing);
  const totalCells = cols * rows;
  const budget = Math.min(totalCells, A.maxStrokes || totalCells);
  const stride = Math.max(1, Math.ceil(Math.sqrt(totalCells / budget)));

  for (let yi = 0; yi < rows; yi += stride) {
    const y = yi * baseSpacing;
    for (let xi = 0; xi < cols; xi += stride) {
      const x = xi * baseSpacing;
      const ox = x + random(-baseSpacing * irregularity, baseSpacing * irregularity);
      const oy = y + random(-baseSpacing * irregularity, baseSpacing * irregularity);
      const jx = (noise(ox * 0.01, oy * 0.01, frameCount * 0.01) - 0.5) * jitterAmount;
      const jy = (noise(oy * 0.01, ox * 0.01, frameCount * 0.01) - 0.5) * jitterAmount;
      const ang = noise(ox * angleScale, oy * angleScale, frameCount * 0.005) * TWO_PI;
      const dx = Math.cos(ang) * lineLength;
      const dy = Math.sin(ang) * lineLength;
      const sx = ox + jx;
      const sy = oy + jy;
      const ex = ox + dx + jx;
      const ey = oy + dy + jy;
      const mx = ox + dx * 0.5 + Math.sin(frameCount * 0.02 + y * 0.01) * curlStrength;
      const my = oy + dy * 0.5 + Math.cos(frameCount * 0.02 + x * 0.01) * curlStrength;
      pg.beginShape();
      pg.vertex(sx, sy);
      pg.quadraticVertex(mx + jx, my + jy, ex, ey);
      pg.endShape();
    }
  }
}

function drawEmotionLayers(pg, joyAmt, sadnessAmt, angerAmt) {
  pg.clear();
  const M = TUNE.visuals.marbles;
  const gridSpacing = M.gridSpacing;
  const emotionAlpha = M.alphaPerUnit;

  // Joy (yellow)
  if (joyAmt > 0) {
    for (let y = 0; y < height; y += gridSpacing) {
      for (let x = 0; x < width; x += gridSpacing) {
        let alpha = joyAmt * emotionAlpha;
        let c = color('#ffff00');
        c.setAlpha(alpha);
        let a = noise(x * 0.01, y * 0.01) * TWO_PI * 4;
        let dx = Math.cos(a) * gridSpacing * 2;
        let dy = Math.sin(a) * gridSpacing * 2;
        pg.noStroke();
        pg.fill(c);
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  }

  // Sadness (blue)
  if (sadnessAmt > 0) {
    for (let y = 0; y < height; y += gridSpacing) {
      for (let x = 0; x < width; x += gridSpacing) {
        let alpha = sadnessAmt * emotionAlpha;
        let c = color('#2196F3');
        c.setAlpha(alpha);
        let a = noise(x * 0.01 + 100, y * 0.01 + 100) * TWO_PI * 4;
        let dx = Math.cos(a) * gridSpacing * 2;
        let dy = Math.sin(a) * gridSpacing * 2;
        pg.noStroke();
        pg.fill(c);
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  }

  // Anger (pink)
  if (angerAmt > 0) {
    for (let y = 0; y < height; y += gridSpacing) {
      for (let x = 0; x < width; x += gridSpacing) {
        let alpha = angerAmt * emotionAlpha;
        let c = color('#FF53BC');
        c.setAlpha(alpha);
        let a = noise(x * 0.01 + 200, y * 0.01 + 200) * TWO_PI * 4;
        let dx = Math.cos(a) * gridSpacing * 2;
        let dy = Math.sin(a) * gridSpacing * 2;
        pg.noStroke();
        pg.fill(c);
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  }
}

/* =============================
   11) PRINT FLOW
   ============================= */
function captureEnergyBodyHiRes() {
  // This function should capture at higher DPI
  // For now, just capture current canvas
  return get().canvas.toDataURL('image/png');
}

function onPrintAverageThenSnapshot() {
  const s = window.__ebSession;

  if (!s || !s.active) {
    console.warn('[PRINT] No active session - using snapshot');
    return onPrintSnapshotFallback();
  }

  const avg = s.end();

  if (!avg || avg.samples === 0) {
    console.warn('[PRINT] No samples - using snapshot');
    return onPrintSnapshotFallback();
  }

  // Save current state
  const saved = {
    emotions: emotionNames.map(n => emotionSliders[n]?.value()),
    regions: regionNames.map(n => regionSliders[n]?.value()),
    spine: regionSliders['spine']?.value?.(),
    structure: smoothedStructure,
    balance: smoothedBalance,
    posture: smoothedPostureLean,
    velocity: movementVelocity,
  };

  // Apply averaged values
  for (const n of emotionNames) {
    emotionSliders[n]?.value(avg.emotions?.[n] ?? 0);
  }

  for (let i = 0; i < regionNames.length; i++) {
    const n = regionNames[i];
    regionSliders[n]?.value(avg.regionWidths?.[i] ?? 0);
  }

  regionSliders['spine']?.value(0);
  smoothedStructure = avg.structure ?? 0;
  smoothedBalance = avg.balance ?? 0;
  smoothedPostureLean = avg.posture ?? 0;
  movementVelocity = avg.velocity ?? 0;

  // Capture after one frame render
  requestAnimationFrame(() => {
    const dataURL = captureEnergyBodyHiRes();

    // Restore original state
    for (let i = 0; i < emotionNames.length; i++) {
      const n = emotionNames[i];
      emotionSliders[n]?.value(saved.emotions[i]);
    }

    for (let i = 0; i < regionNames.length; i++) {
      const n = regionNames[i];
      regionSliders[n]?.value(saved.regions[i]);
    }

    regionSliders['spine']?.value(saved.spine);
    smoothedStructure = saved.structure;
    smoothedBalance = saved.balance;
    smoothedPostureLean = saved.posture;
    movementVelocity = saved.velocity;

    // Open print window
    const w = window.open('', '_blank');
    w.document.write(`
      <html>
        <head>
          <title>Print Energy Body</title>
          <style>
            html, body { margin: 0; padding: 0; background: #000; }
            img { width: 100%; height: auto; display: block; }
            @page { size: 4in 6in; margin: 0; }
          </style>
        </head>
        <body><img src="${dataURL}"></body>
      </html>
    `);
    w.document.close();
    w.onload = () => {
      w.focus();
      w.print();
    };
  });
}

function onPrintSnapshotFallback() {
  const dataURL = captureEnergyBodyHiRes();
  const w = window.open('', '_blank');
  w.document.write(`
    <html>
      <head>
        <title>Print Energy Body</title>
        <style>
          html, body { margin: 0; padding: 0; background: #000; }
          img { width: 100%; height: auto; display: block; }
          @page { size: 4in 6in; margin: 0; }
        </style>
      </head>
      <body><img src="${dataURL}"></body>
    </html>
  `);
  w.document.close();
  w.onload = () => {
    w.focus();
    w.print();
  };
}

/* =============================
   12) WINDOW RESIZE
   ============================= */
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  scene = createGraphics(width, height);
  patternGraphics = createGraphics(width, height);
  shapeMask = createGraphics(width, height);
  emotionGraphics = createGraphics(width, height);

  [scene, patternGraphics, shapeMask, emotionGraphics].forEach(g => {
    g.colorMode(RGB);
    g.noFill();
    g.stroke(255);
    g.strokeWeight(2);
  });

  originOffset = createVector(width / 2, height / 2);
}

/* =============================
   13) CONTROL PANEL INTEGRATION
   ============================= */
const PAUSE_CAMERA_ON_RESET = false;
const RESET_INPUT_BLOCK_MS = 600;
let __blockIncomingUntil = 0;

function applySliders(emotion = {}, region = {}, opts = {}) {
  const now = millis ? millis() : 0;
  if (!opts.force && now < __blockIncomingUntil) return;

  const BLEND = 0.35;

  for (const k in emotion) {
    if (emotionSliders[k]) {
      const cur = emotionSliders[k].value();
      emotionSliders[k].value(lerp(cur, Number(emotion[k]) || 0, BLEND));
    }
  }

  for (const k in region) {
    if (regionSliders[k]) {
      const cur = regionSliders[k].value();
      regionSliders[k].value(lerp(cur, Number(region[k]) || 0, BLEND));
    }
  }

  maybeEchoState();
}

function resetAll({ echo = true, resetPoseCaches = true, stopTrackingNow = true } = {}) {
  if (stopTrackingNow) {
    try {
      if (typeof stopTracking === 'function') stopTracking();
    } catch (err) { }

    if (window.EnergyBodiesDisplay) {
      try {
        EnergyBodiesDisplay.tracking(false);
      } catch (err) { }
    }

    if (PAUSE_CAMERA_ON_RESET && video?.elt) {
      try {
        video.elt.pause();
      } catch (err) { }
    }
  }

  // Reset all sliders
  for (const n of emotionNames) emotionSliders[n]?.value(0);
  for (const n of [...regionNames, 'spine']) regionSliders[n]?.value(0);

  // Reset metrics
  movementVelocity = 0;
  fastVel = 0;
  slowVel = 0;
  smoothedStructure = 0;
  smoothedBalance = 0;
  smoothedPostureLean = 0;
  smoothedAvgY = 0;

  // Reset pose tracking
  followPose = false;
  followAxis = 'both';
  poseRot = 0;
  poseSc = 1;
  const vw = video?.width || 640;
  const vh = video?.height || 480;
  poseTx = vw / 2;
  poseTy = vh / 2;
  _poseSeenAt = millis ? millis() : 0;

  if (resetPoseCaches) {
    __prevKeypoints = null;
    if (__prevByPart?.clear) __prevByPart.clear();
    poses = [];
  }

  // Clear graphics
  scene?.clear?.();
  patternGraphics?.clear?.();
  emotionGraphics?.clear?.();
  shapeMask?.clear?.();

  __blockIncomingUntil = (millis ? millis() : 0) + RESET_INPUT_BLOCK_MS;

  if (echo) maybeEchoState();
}

function buildSampleForThisFrame() {
  const emotions = {};
  for (const n of emotionNames) {
    emotions[n] = Number(emotionSliders[n]?.value() || 0);
  }

  const regionWidths = regionNames.map(n => Number(regionSliders[n]?.value() || 0));

  return {
    structure: smoothedStructure,
    balance: smoothedBalance,
    posture: smoothedPostureLean,
    velocity: movementVelocity,
    emotions,
    regionWidths,
    segmentProfile: segmentProfile.slice()
  };
}