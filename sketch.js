
console.log("✅ sketch.js is starting to load...");

// --- ORIENTATION ---
let displayOrientation = "landscape"; // "landscape" | "portrait"
let scene; // off-screen buffer for the whole frame
let orientationChannel; // optional: cross-page control

// --- GLOBAL VARIABLES ---
let video;
let poseNet;
let poses = [];

// Body shape and rendering
let segmentProfile = [0.0, 1.0, 0.0];
let shapeMask;
let patternGraphics;
let originOffset;
let emotionGraphics;

// Pose net results
let prevPose;
let movementVelocity = 0;
let smoothedStructure = 0;
let smoothedBalance = 0;
let smoothedPostureLean = 0;
let smoothedAvgY = 0;
let prevVelocity = 0;

// UI Controls (now dummy)
let regionSliders = {};
let emotionSliders = {};
let startButton;
let stopButton;
let trackingStarted = false;

// Names for regions and emotions
const regionNames = ["head", "neck", "armsHands", "chest", "abdomen", "legsFeet"];
const emotionNames = ["anxiety", "sadness", "joy", "anger", "fear", "calm"];

// Layout constants
const UI_WIDTH = 320;
const CANVAS_PADDING = 20;

// Responsive factor (GLOBAL) —
// small, targeted use so we don't restructure the sketch
let K = 1; // updated each frame after createCanvas()

// Region max widths (will be rebuilt each frame with K)
let regionMaxWidths = {
  head: 60,
  neck: 20,
  chest: 50,
  armsHands: 150,
  abdomen: 80,
  legsFeet: 100,
  spine: 100
};

let ws;

function setOrientation(next) {
  if (next === 'toggle') {
    displayOrientation = (displayOrientation === 'portrait') ? 'landscape' : 'portrait';
  } else if (next === 'portrait' || next === 'landscape') {
    displayOrientation = next;
  } else {
    console.warn('[DISPLAY] Unknown orientation value:', next);
    return;
  }
  console.log('[DISPLAY] Orientation ->', displayOrientation);
}

// expose for quick console testing
window.setOrientation = setOrientation;
window.toggleOrientation = () => setOrientation('toggle');

// Bind a WebSocket so it can change orientation
function bindWs(ws){
  ws.onmessage = (evt) => {
    console.log('[DISPLAY] WS raw message:', evt.data);
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (msg && msg.type === 'orientation') {
      if (msg.value === 'toggle') {
        setOrientation('toggle');
      } else if (msg.value === 'portrait' || msg.value === 'landscape') {
        if (msg.value !== displayOrientation) setOrientation(msg.value);
      }
    }
  };
}

// Robust keyboard fallback (press "v")
window.addEventListener('keydown', (ev) => {
  if ((ev.code === 'KeyV') || (typeof ev.key === 'string' && ev.key.toLowerCase() === 'v')) {
    setOrientation('toggle');
  }
});

function setup() {
  createCanvas(windowWidth, windowHeight);
  // (1) NEW: unify physical pixels across displays so size looks the same
  pixelDensity(1); // <-- keeps sizing consistent on Retina vs non‑Retina

  colorMode(RGB);
  angleMode(RADIANS);
  noFill();
  stroke(255);
  strokeWeight(2);

  // Off-screen scene buffer
  scene = createGraphics(width, height);
  patternGraphics = createGraphics(width, height);
  shapeMask = createGraphics(width, height);
  emotionGraphics = createGraphics(width, height);

  [scene, patternGraphics, shapeMask, emotionGraphics].forEach(g=>{
    g.colorMode(RGB); g.noFill(); g.stroke(255); g.strokeWeight(2);
  });

  originOffset = createVector(width / 2, height / 2);

  // --- Create dummy emotion sliders ---
  emotionNames.forEach(name => {
    let val = 0;
    emotionSliders[name] = {
      value: function(newVal) {
        if (newVal !== undefined) val = newVal;
        return val;
      }
    };
  });

  // --- Create dummy region sliders ---
  regionNames.forEach(name => {
    let val = 0;
    regionSliders[name] = {
      value: function(newVal) {
        if (newVal !== undefined) val = newVal;
        return val;
      }
    };
  });

  // --- Add spine slider dummy ---
  let spineVal = 0;
  regionSliders["spine"] = {
    value: function(newVal) {
      if (newVal !== undefined) spineVal = newVal;
      return spineVal;
    }
  };

    const constraints = {
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  };
  video = createCapture(constraints, () => console.log('🎥 webcam ready'));
  video.size(640, 480);
  video.elt.setAttribute('playsinline',''); // iOS-safe
  video.hide();

  poseNet = ml5.poseNet(video, { detectionType: 'single' }, () => {
    console.log('🧠 PoseNet model loaded');
  });
  poseNet.on('pose', results => { if (!trackingStarted) return; poses = results; });

  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'; // small robustness tweak
    const host = window.location.hostname;
    ws = new WebSocket(`${proto}://${host}:8080`);
    ws.onopen = () => console.log("[DISPLAY] WS connected");
    bindWs(ws);
  } catch (e) {
    console.warn("[DISPLAY] WS unavailable:", e);
  }

  // Make them globally visible so display.html can update them
  window.emotionSliders = emotionSliders;
  window.regionSliders = regionSliders;
}

function draw() {
  // (2) Small, focused responsiveness (no full refactor)
  K = min(width, height) / 900; // tweak 900 to taste if you want larger/smaller baseline

  // Rebuild region widths with K (tiny change, big visual effect)
  regionMaxWidths = {
    head:      60 * K,
    neck:      20 * K,
    chest:     50 * K,
    armsHands: 150 * K,
    abdomen:   80 * K,
    legsFeet:  100 * K,
    spine:     100 * K
  };

  scene.background(0);

  // Clear graphics buffers
  patternGraphics.clear();
  emotionGraphics.clear();
  shapeMask.clear();

  // --- Get current emotion values ---
  let emotionValues = {};
  for (let name of emotionNames) {
    emotionValues[name] = emotionSliders[name].value();
  }

  let fearAmt    = emotionValues["fear"] / 5;
  let sadnessAmt = emotionValues["sadness"] / 5;
  let joyAmt     = emotionValues["joy"] / 5;
  let angerAmt   = emotionValues["anger"] / 5;
  let anxietyVal = emotionValues["anxiety"];
  let calmAmt    = emotionValues["calm"] / 5;

  // --- Fear scaling ---
  let baseScale = lerp(3, 0.6, fearAmt);
  let fearFreq  = lerp(0.1, 5, fearAmt);
  let pulse     = 0.05 * sin(frameCount * fearFreq);
  let fearScale = baseScale + pulse;

  // --- Body region spacing (light touch: keep your logic, just a small K nudge) ---
  let baseRegionSpacings = regionNames.map((region, i) => {
    let base = [30, 20, 30, 15, 20, 50][i] * K; // <= tiny tweak
    if (region === "armsHands") return base + 30 * K;
    if (region === "legsFeet") return base + 60 * K;
    return base;
  });
  let totalBaseHeight = baseRegionSpacings.reduce((a, b) => a + b, 0);
  let maxBodyHeight   = height * 0.7;
  let bodyHeightScale = maxBodyHeight / totalBaseHeight;
  let regionSpacings = baseRegionSpacings.map(s => s * bodyHeightScale);

  // If you want it centered as before when a UI column is present, you can re‑enable:
  // originOffset.y = (height - regionSpacings.reduce((a, b) => a + b, 0)) / 2;
  // originOffset.x = UI_WIDTH + (width - UI_WIDTH - CANVAS_PADDING * 2) / 2 + CANVAS_PADDING;

  // --- Draw body shape ---
  drawBodyShape(regionSpacings, fearScale);

  // --- Draw layers (with tiny perf guardrails) ---
  drawEmotionLayers(emotionGraphics, joyAmt, sadnessAmt, angerAmt);
  drawAnxietyPattern(patternGraphics, anxietyVal, calmAmt);

  // --- Mask ---
  let maskImage    = shapeMask.get();
  let emotionImage = emotionGraphics.get();
  let patternImage = patternGraphics.get();

  emotionImage.mask(maskImage);
  patternImage.mask(maskImage);

  scene.image(emotionImage, 0, 0);
  scene.image(patternImage, 0, 0);

  // --- FINAL BLIT: same as yours (kept intact) ---
  clear();
  if (displayOrientation === "portrait") {
    push();
    translate(0, height);
    rotate(-HALF_PI);
    image(scene, 0, 0, height, width); // note swapped dims
    pop();
  } else {
    image(scene, 0, 0, width, height);
  }
  // small on-screen state badge
  push();
  noStroke();
  fill(255);
  textSize(14);
  text(`[${displayOrientation}]`, 12, 20);
  pop();
}

function drawBodyShape(regionSpacings, fearScale) {
  let stepsPerRegion = 2;

  // --- Center vertically by starting above origin by half the total height ---
  let spacingAccumulator = -regionSpacings.reduce((a, b) => a + b, 0) / 2;

  let leftSide = [];
  let rightSide = [];
  let crotchPoints = [];

  // tiny local offsets made responsive with K (no wider refactor)
  const legTaper   = 60 * K;
  const domeOffset = 60 * K;

  for (let i = 0; i < regionNames.length; i++) {
    for (let s = 0; s < stepsPerRegion; s++) {
      let t = s / (stepsPerRegion - 1);
      let y = spacingAccumulator + t * (regionSpacings[i] || 60 * K);

      if (regionNames[i] === "chest") y -= 60 * K;
      if (regionNames[i] === "armsHands") y += map(t, 0, 1, 0, 40 * K);
      if (regionNames[i] === "legsFeet") y += map(t, 0, 1, 0, 80 * K);

      let spineOffset = regionSliders["spine"].value();
      let sliderVal = regionSliders[regionNames[i]].value();
      let maxWidth = regionMaxWidths[regionNames[i]] || 80 * K;
      let halfWidth = map(sliderVal, 0, 5, 0, maxWidth) * fearScale;

      if (regionNames[i] === "legsFeet") {
        halfWidth -= map(t, 0, 1, 0, legTaper);
      }

      leftSide.push(
        createVector(
          -halfWidth - spineOffset / 2 + originOffset.x,
          y + originOffset.y
        )
      );
      rightSide.unshift(
        createVector(
          halfWidth + spineOffset / 2 + originOffset.x,
          y + originOffset.y
        )
      );

      if (regionNames[i] === "legsFeet" && s === stepsPerRegion - 1) {
        crotchPoints.push(
          createVector(originOffset.x, y + originOffset.y - 300 * K)
        );
      }
    }
    spacingAccumulator += regionSpacings[i];
  }

  let domeY = leftSide[0].y - domeOffset;
  let leftAnchor = createVector(originOffset.x, domeY);
  let rightAnchor = createVector(originOffset.x, domeY);

  let fullShape = [
    leftAnchor,
    ...leftSide,
    ...crotchPoints,
    ...rightSide,
    rightAnchor,
  ];

  // --- Draw shape to mask ---
  shapeMask.noStroke();
  shapeMask.fill(255);
  shapeMask.curveTightness(-0.5);
  shapeMask.beginShape();
  shapeMask.curveVertex(fullShape[0].x, fullShape[0].y);
  for (let pt of fullShape) shapeMask.curveVertex(pt.x, pt.y);
  shapeMask.curveVertex(
    fullShape[fullShape.length - 1].x,
    fullShape[fullShape.length - 1].y
  );
  shapeMask.endShape(CLOSE);

  // --- Draw main body outline ---
  scene.push();
  scene.noFill();
  scene.stroke(0);
  scene.strokeWeight(1 * K);
  scene.curveTightness(-0.5);
  scene.beginShape();
  scene.curveVertex(fullShape[0].x, fullShape[0].y);
  for (let pt of fullShape) scene.curveVertex(pt.x, pt.y);
  scene.curveVertex(fullShape[fullShape.length - 1].x, fullShape[fullShape.length - 1].y);
  scene.endShape(CLOSE);
  scene.pop();

  return fullShape;
}

// --- DRAW PATTERN FUNCTION --- (tiny perf clamps)
function drawAnxietyPattern(pg, val, calm) {
  pg.clear();
  let alpha = lerp(255, 50, calm);
  pg.stroke(255, alpha);
  pg.strokeWeight(2 * K);
  pg.noFill();

  let smoothness = calm; // 0 = chaotic, 1 = smooth

  let baseSpacing = lerp(
    map(val, 0, 5, 40, 8),
    map(val, 0, 5, 50, 20),
    smoothness
  ) * K;
  baseSpacing = max(baseSpacing, 14); // clamp density for speed

  let lineLength = lerp(
    map(val, 0, 5, 4, 12),
    map(val, 0, 5, 20, 100), // longer lines with calm
    smoothness
  ) * K;

  let jitterAmount = lerp(map(val, 0, 5, 0, 25), 0, smoothness) * K;
  let irregularity = lerp(map(val, 0, 5, 0, 0.4), 0, smoothness);
  let angleScale = lerp(0.02, 0.005, smoothness);
  let curlStrength = lerp(0, 50, calm) * K; // calm-based curl factor

  let strokes = 0, maxStrokes = 6000; // guardrail
  for (let y = 0; y < height; y += baseSpacing) {
    for (let x = 0; x < width; x += baseSpacing) {
      if (strokes++ > maxStrokes) return;
      let offsetX = x + random(-baseSpacing * irregularity, baseSpacing * irregularity);
      let offsetY = y + random(-baseSpacing * irregularity, baseSpacing * irregularity);

      let jitterX = (noise(offsetX * 0.01, offsetY * 0.01, frameCount * 0.01) - 0.5) * jitterAmount;
      let jitterY = (noise(offsetY * 0.01, offsetX * 0.01, frameCount * 0.01) - 0.5) * jitterAmount;

      let angle = noise(offsetX * angleScale, offsetY * angleScale, frameCount * 0.005) * TWO_PI;
      let dx = cos(angle) * lineLength;
      let dy = sin(angle) * lineLength;

      let startX = offsetX + jitterX;
      let startY = offsetY + jitterY;
      let endX = offsetX + dx + jitterX;
      let endY = offsetY + dy + jitterY;

      let midX = offsetX + dx * 0.5 + sin(frameCount * 0.02 + y * 0.01) * curlStrength;
      let midY = offsetY + dy * 0.5 + cos(frameCount * 0.02 + x * 0.01) * curlStrength;

      pg.beginShape();
      pg.vertex(startX, startY);
      pg.quadraticVertex(midX + jitterX, midY + jitterY, endX, endY);
      pg.endShape();
    }
  }
}

// --- DRAW EMOTION MARBLE FUNCTION --- (tiny perf clamps)
function drawEmotionLayers(pg, joyAmt, sadnessAmt, angerAmt) {
  pg.clear();

  // pg.blendMode(OVERLAY);

  let gridSpacing = 18; //max(18 * K, 12); // clamp density
  let emotionAlpha = 70;

  // let dots = 0, maxDots = 4000; // guardrail per frame

  // Joy layer
  if (joyAmt > 0) {
    for (let y = 0; y < height; y += gridSpacing) {
      for (let x = 0; x < width; x += gridSpacing) {
        // if (dots++ > maxDots) return;
        let alpha = joyAmt * emotionAlpha;
        let cJoy = color("#ffff00");
        cJoy.setAlpha(alpha);
        let angle = noise(x * 0.01, y * 0.01) * TWO_PI * 4;
        let dx = cos(angle) * gridSpacing * 2;
        let dy = sin(angle) * gridSpacing * 2;

        pg.noStroke();
        pg.fill(cJoy);
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  }

  // Sadness layer
  if (sadnessAmt > 0) {
    for (let y = 0; y < height; y += gridSpacing) {
      for (let x = 0; x < width; x += gridSpacing) {
        // if (dots++ > maxDots) return;
        let alpha = sadnessAmt * emotionAlpha;
        let cSad = color("#2196F3");
        cSad.setAlpha(alpha);
        let angle = noise(x * 0.01 + 100, y * 0.01 + 100) * TWO_PI * 4;
        let dx = cos(angle) * gridSpacing * 2;
        let dy = sin(angle) * gridSpacing * 2;

        pg.noStroke();
        pg.fill(cSad);
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  }

  // Anger layer
  if (angerAmt > 0) {
    for (let y = 0; y < height; y += gridSpacing) {
      for (let x = 0; x < width; x += gridSpacing) {
        // if (dots++ > maxDots) return;
        let alpha = angerAmt * emotionAlpha;
        let cAnger = color("#FF53BC");
        cAnger.setAlpha(alpha);
        let angle = noise(x * 0.01 + 200, y * 0.01 + 200) * TWO_PI * 4;
        let dx = cos(angle) * gridSpacing * 2;
        let dy = sin(angle) * gridSpacing * 2;

        pg.noStroke();
        pg.fill(cAnger);
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  }
}

function startTracking() {
  if (trackingStarted) return;           // prevent double-start
  trackingStarted = true;

  if (!video) {
    const constraints = {
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    };
    video = createCapture(constraints, ()=>console.log('🎥 webcam ready'));
    video.size(640,480); video.hide();
  }

  if (!poseNet) {
    poseNet = ml5.poseNet(video, { detectionType: 'single' }, ()=>console.log('🧠 PoseNet model loaded'));
    poseNet.on('pose', results => { if (!trackingStarted) return; poses = results; });
  }


video = createCapture({ video: true, audio: false }, ()=>console.log('🎥 webcam ready'));
video.size(640,480); video.hide();

poseNet = ml5.poseNet(video, { detectionType: 'single' }, ()=>console.log('🧠 PoseNet model loaded'));
poseNet.on('pose', results => { if (!trackingStarted) return; poses = results; });
}

function stopTracking() {
  if (video) {
    video.remove();
    video = null;
  }
  if (poseNet) {
    poseNet.removeListener("pose", gotPoses);
    poseNet = null;
  }
  trackingStarted = false;
}

function gotPoses(results) {
  if (results.length > 0) {
    let pose = results[0].pose;
    poses = results;
    // (unchanged metrics and mapping)
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  scene = createGraphics(width, height);
  scene.colorMode(RGB);
  scene.noFill();
  scene.stroke(255);
  scene.strokeWeight(2);

  patternGraphics = createGraphics(width, height);
  shapeMask = createGraphics(width, height);
  emotionGraphics = createGraphics(width, height);

  originOffset = createVector(width / 2, height / 2);
}
