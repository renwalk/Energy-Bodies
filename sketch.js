/*
==============================================================================
 ENERGY BODIES — PER-REGION WIDTH COUPLING + CONTROL PANEL INTEGRATION
 - Keeps your motion-driven width coupling (head/neck/chest/abdomen/legs + arms/spine)
 - Adds hooks to work with the iPad control + display receiver:
   • window.applySliders(emotion, region)
   • window.startTracking() / window.stopTracking()
   • Emits pose metrics and tracking state via EnergyBodiesDisplay.* if present
   • Optional echo back of current slider state (so the iPad mirrors renderer truth)
 - Consolidates duplicate print helpers
==============================================================================
*/
const TUNE = {
  velocity: {
    kpMinScore: 0.5,
    vNormInMin: 0.00015,
    vNormInMax: 0.02,
    vBlend: 0.5,
    fastEMA: 0.6,
    slowEMA: 0.05,
    angerBurstMin: 0.05,
    angerBurstMax: 1
  },
  emotions: {
    blendPoseVsSlider: 0.60,
    anxietyFromVel:   { inMin: 0.3, inMax: 1.5, outMin: 0, outMax: 5 },
    calmFromBalance:  { inMin: 0.2,   inMax: 50,  outMin: 5, outMax: 0 },
    sadnessFromAvgY:  { inMin: 0,   inMax: null, outMin: 0, outMax: 5 },
    fearFromLean:     { inMin: 0,   inMax: 200, outMin: 0, outMax: 5 },
    joyFromStructure: { inMin: 0,   inMax: 1,   outMin: 0, outMax: 5 }
  },
  follow: {
    enabledFreshMs: 300,
    axis: 'both',
    lerp: { tx: 0.20, ty: 0.20, rot: 0.18, sc: 0.12 }
  },
  coupling: {
    armsHands: { wristSpreadMin: 2, wristSpreadMax: 5.0, lerp: 0.12 },
    spine:     { swayRange: 1.0, lerp: 0.20 },

    head:   { velMin: 0.00009, velMax: 0.008,  lerp: 0.20 },
    neck:   { velMin: 0.0001, velMax: 0.01,  lerp: 0.20 },

    chest:  { velMin: 0.00005, velMax: 0.010,  reachMin: 0.7, reachMax: 2.0, lerp: 0.20 },
    abdomen:{ velMin: 0.00001, velMax: 0.002,  torsoMin: 1.2, torsoMax: 2.2, lerp: 0.20 },
    legsFeet:{ velMin: 0.001, velMax: 0.02, ankleSpreadMin: 0.9, ankleSpreadMax: 3.0, lerp: 0.20 }
  },
  visuals: {
    fear: { baseScaleFrom: 3.0, baseScaleTo: 0.6, freqFrom: 0.1, freqTo: 5.0, pulseAmp: 0.05 },
    anxiety: {
      spacingChaotic: { from: 40, to: 8 },
      spacingCalm:    { from: 50, to: 20 },
      lineLenChaotic: { from: 4,  to: 12 },
      lineLenCalm:    { from: 20, to: 100 },
      jitterMax: 25,
      irregularityMax: 0.4,
      angleScaleChaotic: 0.02,
      angleScaleCalm:    0.005,
      curlMax: 50,
      alphaMin: 50, alphaMax: 255,
      minSpacingPx: 14,
      maxStrokes: 9000
    },
    marbles: { gridSpacing: 18, alphaPerUnit: 70 }
  }
};

console.log("✅ sketch.js (control-integrated) loading...");

// --- ORIENTATION ---
let displayOrientation = "landscape";
let scene, orientationChannel;

// --- GLOBALS ---
let video, poseNet, poses = [];
let __prevKeypoints = null;         // global previous keypoints (for velocity)
let __prevByPart = new Map();       // per-part previous pos cache for region motion
let __lastPoseEmitAt = 0;
const POSE_EMIT_MS = 80; // ~12.5 fps to keep bandwidth low


// Rendering
let segmentProfile = [0.0, 1.0, 0.0];
let shapeMask, patternGraphics, originOffset, emotionGraphics;

// Pose metrics
let movementVelocity = 0;
let smoothedStructure = 0;
let smoothedBalance = 0;
let smoothedPostureLean = 0;
let smoothedAvgY = 0;
let fastVel = 0, slowVel = 0;
let followPose = false, followAxis = 'both';
let poseTx = 0, poseTy = 0, poseRot = 0, poseSc = 1, _poseSeenAt = 0;
let regionOffsets = {};

// PoseNet Skeleton 
for (const r of (window.regionNames || ["head","neck","armsHands","chest","abdomen","legsFeet"])) regionOffsets[r] = { x: 0, y: 0 };
let latestPose = null;
const EDGES = [
  // torso
  ['leftShoulder','rightShoulder'],
  ['leftHip','rightHip'],
  ['leftShoulder','leftHip'],
  ['rightShoulder','rightHip'],
  // arms
  ['leftShoulder','leftElbow'], ['leftElbow','leftWrist'],
  ['rightShoulder','rightElbow'], ['rightElbow','rightWrist'],
  // legs
  ['leftHip','leftKnee'], ['leftKnee','leftAnkle'],
  ['rightHip','rightKnee'], ['rightKnee','rightAnkle'],
  // neck-ish
  ['leftShoulder','nose'], ['rightShoulder','nose'],
];


// UI / Slider mirrors (renderer-side state holders)
let regionSliders = {}, emotionSliders = {}, trackingStarted = false;
const regionNames = ["head", "neck", "armsHands", "chest", "abdomen", "legsFeet"];
const emotionNames = ["anxiety", "sadness", "joy", "anger", "fear", "calm"];

const regionKeypoints = {
  head:      ["nose", "leftEye", "rightEye", "leftEar", "rightEar"],
  neck:      ["leftShoulder", "rightShoulder"],
  chest:     ["leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist"],
  armsHands: ["leftWrist", "rightWrist", "leftElbow", "rightElbow"],
  abdomen:   ["leftHip", "rightHip"],
  legsFeet:  ["leftKnee", "rightKnee", "leftAnkle", "rightAnkle"]
};

const UI_WIDTH = 320, CANVAS_PADDING = 20; let K = 1;
let regionMaxWidths = { head:60, neck:20, chest:50, armsHands:150, abdomen:80, legsFeet:100, spine:100 };

// --- PRINT: consolidated helpers ---------------------------------------ƒ
function captureEnergyBodyHiRes() {
  const src = (typeof scene !== "undefined" && scene) ? scene : window._renderer || null; // p5 canvas
  const srcCanvas = src?.elt || document.querySelector("canvas");
  const scale = 3; // upscale
  const w = srcCanvas.width * scale;
  const h = srcCanvas.height * scale;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const ctx = off.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return off.toDataURL("image/jpeg", 0.92);
}

function captureOnWhiteForPrint(scale = 2) {
  const src = (scene?.elt) || document.querySelector("canvas");
  const off = document.createElement("canvas");
  off.width = src.width * scale; off.height = src.height * scale;
  const ctx = off.getContext("2d");
  // ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, off.width, off.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, off.width, off.height);
  return off.toDataURL("image/jpeg", 0.92);
}

function printReceiptKiosk(dataURL, meta="") {
  const w = window.open("", "_blank", "width=800,height=1200");
  w.document.write(`
  <html><head><meta charset="utf-8" />
  <style>
    @page { size: 4in 6in; margin: 0; }
    html, body { height:100%; margin:0; background:#fff; }
    body { display:flex; }
    .frame { width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
    img { width:100%; height:100%; object-fit: contain; display:block; }
    .meta { position:absolute; bottom:0.1in; left:0; right:0; text-align:center; font-size:8pt; white-space:pre; }
  </style>
  </head><body>
    <div class="frame">
      <img src="${dataURL}" />
      <div class="meta">Energy Bodies — ${new Date().toLocaleString()}${meta ? "\n"+meta : ""}</div>
    </div>
    <script>onload=()=>{print(); setTimeout(()=>close(), 400);}<\/script>
  </body></html>`);
  w.document.close();
}

function onPrintClick() {
  const img = captureOnWhiteForPrint(2);
  printReceiptKiosk(img, "MIT Info+ • Energy Bodies");
}

// function addPrintButton() {
//   if (window.__printBtn) return;
//   const btn = document.createElement("button");
//   btn.textContent = "Print Energy Body";
//   btn.style.cssText = "position:fixed;bottom:16px;right:16px;padding:10px 14px;font-size:14px;z-index:99999;cursor:pointer;";
//   btn.addEventListener("click", onPrintClick);
//   document.body.appendChild(btn);
//   window.__printBtn = btn;
// }

// --- SETUP --------------------------------------------------------------
function setup(){
  createCanvas(windowWidth, windowHeight); pixelDensity(1);
  colorMode(RGB); angleMode(RADIANS); noFill(); stroke(255); strokeWeight(2);
  // addPrintButton();       

  scene = createGraphics(width, height);
  patternGraphics = createGraphics(width, height);
  shapeMask = createGraphics(width, height);
  emotionGraphics = createGraphics(width, height);
  ;[scene,patternGraphics,shapeMask,emotionGraphics].forEach(g=>{ g.colorMode(RGB); g.noFill(); g.stroke(255); g.strokeWeight(2); });

  originOffset = createVector(width/2, height/2);

  // Renderer-side slider mirrors
  emotionNames.forEach(name=>{ let val=0; emotionSliders[name]={ value:(v)=>{ if(v!==undefined) val=v; return val; } }; });
  regionNames.forEach(name=>{ let val=0; regionSliders[name]={ value:(v)=>{ if(v!==undefined) val=v; return val; } }; });
  let spineVal=0; regionSliders["spine"]={ value:(v)=>{ if(v!==undefined) spineVal=v; return spineVal; } };

  // Video
  const constraints = { video:{ facingMode:'user', width:{ideal:640}, height:{ideal:480} }, audio:false };
  video = createCapture(constraints, ()=>console.log('🎥 webcam ready')); video.size(640,480); video.elt.playsInline = true; video.hide();

  // PoseNet
  poseNet = ml5.poseNet(video, { detectionType:'single' }, ()=>console.log('🧠 PoseNet model loaded'));
  let debugPoseCount = 0;
  
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
    emitPoseMetrics();   // send meters to the control (~12 fps throttled)


    const now = millis();
    if (now - __lastPoseEmitAt >= POSE_EMIT_MS) {
      __lastPoseEmitAt = now;
      emitPoseToControl(pose);
    }
  });
  


  // Orientation event from Display Receiver (if present)
  window.addEventListener('eb:orientation', (ev) => {
    const mode = ev.detail?.value; // 'landscape' | 'portrait'
    if (mode && mode !== displayOrientation) {
      displayOrientation = mode;
      console.log('[DISPLAY] Orientation →', displayOrientation);
    }
  });

  // Expose for control receiver
  window.applySliders = applySliders;
  window.startTracking = startTracking;
  window.stopTracking  = stopTracking;
  window.resetAll = resetAll;
  window.addEventListener('eb:reset', () => resetAll());
}

function draw(){
  fill(255); noStroke(); textSize(14);
  text(`video ${video?.width||0}x${video?.height||0} | poses: ${poses?.length||0} | tracking: ${trackingStarted}`, 12, 20);

  K = min(width, height)/900;
  regionMaxWidths = { head:60*K, neck:20*K, chest:50*K, armsHands:150*K, abdomen:80*K, legsFeet:100*K, spine:100*K };

  scene.clear(); patternGraphics.clear(); emotionGraphics.clear(); shapeMask.clear();

  // emotions
  let vals={}; for (let n of emotionNames) vals[n]=emotionSliders[n].value();
  let fearAmt=vals.fear/5, sadnessAmt=vals.sadness/5, joyAmt=vals.joy/5, angerAmt=vals.anger/5, anxietyVal=vals.anxiety, calmAmt=vals.calm/5;

  const FV=TUNE.visuals.fear; let baseScale=lerp(FV.baseScaleFrom,FV.baseScaleTo,fearAmt); let fearFreq=lerp(FV.freqFrom,FV.freqTo,fearAmt); let pulse=FV.pulseAmp*sin(frameCount*fearFreq); let fearScale=baseScale+pulse;

  let baseRegionSpacings = regionNames.map((region,i)=>{ let base=[30,20,30,15,20,50][i]*K; if(region==='armsHands') return base+30*K; if(region==='legsFeet') return base+60*K; return base; });
  let totalBaseHeight=baseRegionSpacings.reduce((a,b)=>a+b,0); let maxBodyHeight=height*0.7; let bodyHeightScale=maxBodyHeight/totalBaseHeight; let regionSpacings=baseRegionSpacings.map(s=>s*bodyHeightScale);

  drawBodyShape(regionSpacings, fearScale, smoothedStructure, smoothedBalance);
  drawEmotionLayers(emotionGraphics, joyAmt, sadnessAmt, angerAmt);
  drawAnxietyPattern(patternGraphics, anxietyVal, calmAmt);

  let maskImage=shapeMask.get(); let emotionImage=emotionGraphics.get(); let patternImage=patternGraphics.get();
  emotionImage.mask(maskImage); patternImage.mask(maskImage); scene.image(emotionImage,0,0); scene.image(patternImage,0,0);

  blitSceneTranslateOnly(scene);
  push(); noStroke(); fill(255); textSize(14); text(`[${displayOrientation}]`,12,20); pop();
}

function blitSceneTranslateOnly(sceneGfx){
  clear(); push(); imageMode(CENTER);
  const vw=video?.width||width, vh=video?.height||height; let s;
  if(displayOrientation==='portrait'){ translate(0,height); rotate(-HALF_PI); s=Math.min(height/vw, width/vh);} else { s=Math.min(width/vw, height/vh);} 
  let cx=width/2, cy=height/2;
  if (followPose && (millis()-_poseSeenAt < TUNE.follow.enabledFreshMs)){
    const dx=(poseTx - vw/2)*s; const dy=(poseTy - vh/2)*s;
    if (followAxis==='both' || followAxis==='x') cx+=dx;
    if (followAxis==='both' || followAxis==='y') cy+=dy;
  }
  translate(cx,cy);
  if(displayOrientation==='portrait') image(sceneGfx,0,0,height,width); else image(sceneGfx,0,0,width,height);
  pop();
}

function drawBodyShape(regionSpacings, fearScale){
  let stepsPerRegion=2; let spacingAccumulator=-regionSpacings.reduce((a,b)=>a+b,0)/2;
  let leftSide=[], rightSide=[], crotchPoints=[]; const legTaper=60*K, domeOffset=60*K;
  for(let i=0;i<regionNames.length;i++){
    for(let s=0;s<stepsPerRegion;s++){
      let t=s/(stepsPerRegion-1); let y=spacingAccumulator + t*(regionSpacings[i]||60*K);
      if(regionNames[i]==='chest') y-=60*K; if(regionNames[i]==='armsHands') y+=map(t,0,1,0,40*K); if(regionNames[i]==='legsFeet') y+=map(t,0,1,0,80*K);
      let spineOffset=regionSliders['spine'].value(); let sliderVal=regionSliders[regionNames[i]].value(); let maxWidth=regionMaxWidths[regionNames[i]]||80*K; let halfWidth=map(sliderVal,0,5,0,maxWidth)*fearScale;
      if(regionNames[i]==='legsFeet') halfWidth -= map(t,0,1,0,legTaper);
      leftSide.push(createVector(-halfWidth - spineOffset/2 + originOffset.x, y + originOffset.y));
      rightSide.unshift(createVector(halfWidth + spineOffset/2 + originOffset.x, y + originOffset.y));
      if(regionNames[i]==='legsFeet' && s===stepsPerRegion-1) crotchPoints.push(createVector(originOffset.x, y+originOffset.y - 300*K));
    }
    spacingAccumulator += regionSpacings[i];
  }
  let domeY=leftSide[0].y - domeOffset; let leftAnchor=createVector(originOffset.x,domeY), rightAnchor=createVector(originOffset.x,domeY);
  let fullShape=[ leftAnchor, ...leftSide, ...crotchPoints, ...rightSide, rightAnchor ];
  shapeMask.noStroke(); shapeMask.fill(255); shapeMask.curveTightness(-0.5); shapeMask.beginShape(); shapeMask.curveVertex(fullShape[0].x,fullShape[0].y); for (let pt of fullShape) shapeMask.curveVertex(pt.x,pt.y); shapeMask.curveVertex(fullShape[fullShape.length-1].x, fullShape[fullShape.length-1].y); shapeMask.endShape(CLOSE);
  scene.push(); scene.noFill(); scene.stroke(0); scene.strokeWeight(1*K); scene.curveTightness(-0.5); scene.beginShape(); scene.curveVertex(fullShape[0].x,fullShape[0].y); for (let pt of fullShape) scene.curveVertex(pt.x,pt.y); scene.curveVertex(fullShape[fullShape.length-1].x,fullShape[fullShape.length-1].y); scene.endShape(CLOSE); scene.pop();
  return fullShape;
}

function drawAnxietyPattern(pg, val, calm){
  pg.clear();
  const A = TUNE.visuals.anxiety;

  // Alpha & base params
  const alpha = lerp(A.alphaMax, A.alphaMin, calm);
  pg.stroke(255, alpha);
  pg.strokeWeight(2 * K);
  pg.noFill();

  // Interpolated spacing/length based on anxiety & calm
  let baseSpacing = lerp(
    map(val, 0, 5, A.spacingChaotic.from, A.spacingChaotic.to),
    map(val, 0, 5, A.spacingCalm.from, A.spacingCalm.to),
    calm
  ) * K;
  baseSpacing = max(baseSpacing, A.minSpacingPx);

  const lineLength = lerp(
    map(val, 0, 5, A.lineLenChaotic.from, A.lineLenChaotic.to),
    map(val, 0, 5, A.lineLenCalm.from,   A.lineLenCalm.to),
    calm
  ) * K;

  const jitterAmount  = lerp(map(val,0,5,0,A.jitterMax), 0, calm) * K;
  const irregularity  = lerp(map(val,0,5,0,A.irregularityMax), 0, calm);
  const angleScale    = lerp(A.angleScaleChaotic, A.angleScaleCalm, calm);
  const curlStrength  = lerp(0, A.curlMax, calm) * K;

  // --- Budgeted, even sampling across the FULL canvas ---
  const cols = Math.ceil(width  / baseSpacing);
  const rows = Math.ceil(height / baseSpacing);
  const totalCells = cols * rows;

  // Keep existing cap for perf, but distribute across the whole grid
  const budget = Math.min(totalCells, A.maxStrokes || totalCells);

  // Use a 2D stride so we sample evenly in X and Y
  const stride = Math.max(1, Math.ceil(Math.sqrt(totalCells / budget)));

  for (let yi = 0; yi < rows; yi += stride){
    const y = yi * baseSpacing;
    for (let xi = 0; xi < cols; xi += stride){
      const x = xi * baseSpacing;

      // Jittered cell origin
      const ox = x + random(-baseSpacing * irregularity, baseSpacing * irregularity);
      const oy = y + random(-baseSpacing * irregularity, baseSpacing * irregularity);

      // Per-stroke jitter
      const jx = (noise(ox*0.01, oy*0.01, frameCount*0.01) - 0.5) * jitterAmount;
      const jy = (noise(oy*0.01, ox*0.01, frameCount*0.01) - 0.5) * jitterAmount;

      const ang = noise(ox * angleScale, oy * angleScale, frameCount * 0.005) * TWO_PI;
      const dx  = Math.cos(ang) * lineLength;
      const dy  = Math.sin(ang) * lineLength;

      const sx = ox + jx, sy = oy + jy;
      const ex = ox + dx + jx, ey = oy + dy + jy;

      // Curved middle for a touch of “curl”
      const mx = ox + dx * 0.5 + Math.sin(frameCount * 0.02 + y * 0.01) * curlStrength;
      const my = oy + dy * 0.5 + Math.cos(frameCount * 0.02 + x * 0.01) * curlStrength;

      pg.beginShape();
      pg.vertex(sx, sy);
      pg.quadraticVertex(mx + jx, my + jy, ex, ey);
      pg.endShape();
    }
  }
}


function drawEmotionLayers(pg, joyAmt, sadnessAmt, angerAmt){
  pg.clear(); const M=TUNE.visuals.marbles; let gridSpacing=M.gridSpacing, emotionAlpha=M.alphaPerUnit;
  if(joyAmt>0){ for(let y=0;y<height;y+=gridSpacing){ for(let x=0;x<width;x+=gridSpacing){ let alpha=joyAmt*emotionAlpha; let c=color('#ffff00'); c.setAlpha(alpha); let a=noise(x*0.01,y*0.01)*TWO_PI*4; let dx=cos(a)*gridSpacing*2; let dy=sin(a)*gridSpacing*2; pg.noStroke(); pg.fill(c); pg.ellipse(x+dx,y+dy,gridSpacing*2,gridSpacing*2); } } }
  if(sadnessAmt>0){ for(let y=0;y<height;y+=gridSpacing){ for(let x=0;x<width;x+=gridSpacing){ let alpha=sadnessAmt*emotionAlpha; let c=color('#2196F3'); c.setAlpha(alpha); let a=noise(x*0.01+100,y*0.01+100)*TWO_PI*4; let dx=cos(a)*gridSpacing*2; let dy=sin(a)*gridSpacing*2; pg.noStroke(); pg.fill(c); pg.ellipse(x+dx,y+dy,gridSpacing*2,gridSpacing*2); } } }
  if(angerAmt>0){ for(let y=0;y<height;y+=gridSpacing){ for(let x=0;x<width;x+=gridSpacing){ let alpha=angerAmt*emotionAlpha; let c=color('#FF53BC'); c.setAlpha(alpha); let a=noise(x*0.01+200,y*0.01+200)*TWO_PI*4; let dx=cos(a)*gridSpacing*2; let dy=sin(a)*gridSpacing*2; pg.noStroke(); pg.fill(c); pg.ellipse(x+dx,y+dy,gridSpacing*2,gridSpacing*2); } } }
}

function startTracking(){ if(trackingStarted) return; trackingStarted=true; console.log('[TRACKING] ON'); if (window.EnergyBodiesDisplay) EnergyBodiesDisplay.tracking(true); }
function stopTracking(){ if(!trackingStarted) return; trackingStarted=false; poses=[]; console.log('[TRACKING] OFF'); if (window.EnergyBodiesDisplay) EnergyBodiesDisplay.tracking(false); }

// --------------------------- POSE → FACTORS ---------------------------
function updatePoseFactors(pose){
  if(!pose||!pose.keypoints) return;
  const kp = pose.keypoints.filter(k=>k.score > TUNE.velocity.kpMinScore);
  if(!kp.length) return;

  // global velocity
  let velAvg=0; if(__prevKeypoints){ const diag=Math.hypot(video?.width||640, video?.height||480)||1; let sum=0,n=0; for(const k of kp){ const prev=__prevKeypoints.find(p=>p.part===k.part); if(!prev) continue; const dx=(k.position.x-prev.position.x)/diag; const dy=(k.position.y-prev.position.y)/diag; sum+=Math.hypot(dx,dy); n++; } if(n>0) velAvg=sum/n; }
  __prevKeypoints = kp.map(k=>({ part:k.part, position:{ x:k.position.x, y:k.position.y } }));

  const vNorm = constrain(map(velAvg, TUNE.velocity.vNormInMin, TUNE.velocity.vNormInMax, 0,1), 0,1);
  movementVelocity = lerp(movementVelocity, vNorm, TUNE.velocity.vBlend);
  fastVel = lerp(fastVel, vNorm, TUNE.velocity.fastEMA);
  slowVel = lerp(slowVel, vNorm, TUNE.velocity.slowEMA);
  const burst=Math.max(0, fastVel - slowVel);
  const poseAnger = constrain(map(burst, TUNE.velocity.angerBurstMin, TUNE.velocity.angerBurstMax, 0,5), 0,5);

  // structure
  const Ls=pose.leftShoulder, Rs=pose.rightShoulder, Lw=pose.leftWrist, Rw=pose.rightWrist;
  let structure=0; if(Ls&&Rs&&Lw&&Rw){ const span=dist(Ls.x,Ls.y,Rs.x,Rs.y); const lw=dist(Ls.x,Ls.y,Lw.x,Lw.y)/span; const rw=dist(Rs.x,Rs.y,Rw.x,Rw.y)/span; structure=constrain(map((lw+rw)*0.5, 0.7,2.0, 0,1), 0,1);} smoothedStructure=lerp(smoothedStructure,structure,0.15);

  const shoulderDiff=Math.abs(Ls?.y - Rs?.y), hipDiff=Math.abs(pose.leftHip?.y - pose.rightHip?.y); smoothedBalance=lerp(smoothedBalance, (shoulderDiff+hipDiff), 0.15);

  let lean=0; if(Ls&&Rs&&pose.leftHip&&pose.rightHip){ const sx=(Ls.x+Rs.x)/2, sy=(Ls.y+Rs.y)/2; const hx=(pose.leftHip.x+pose.rightHip.x)/2, hy=(pose.leftHip.y+pose.rightHip.y)/2; const ang=Math.atan2(hy-sy, hx-sx)-0; lean=constrain(map(Math.abs(ang), 0.0, Math.PI/6, 0,1), 0,1);} smoothedPostureLean=lerp(smoothedPostureLean,lean,0.15);

  const avgY=(pose.leftShoulder.y + pose.rightShoulder.y)/2; smoothedAvgY=lerp(smoothedAvgY,avgY,0.1);

  const E=TUNE.emotions; if(E.sadnessFromAvgY.inMax===null) E.sadnessFromAvgY.inMax=height;
  let poseAnxiety=constrain(map(movementVelocity, E.anxietyFromVel.inMin,E.anxietyFromVel.inMax, E.anxietyFromVel.outMin,E.anxietyFromVel.outMax), 0,5);
  let poseCalm   =constrain(map(smoothedBalance,   E.calmFromBalance.inMin,E.calmFromBalance.inMax, E.calmFromBalance.outMin,E.calmFromBalance.outMax), 0,5);
  let poseSadness=constrain(map(smoothedAvgY,      E.sadnessFromAvgY.inMin,E.sadnessFromAvgY.inMax, E.sadnessFromAvgY.outMin,E.sadnessFromAvgY.outMax), 0,5);
  let poseFear   =constrain(map(smoothedPostureLean,E.fearFromLean.inMin,   E.fearFromLean.inMax,   E.fearFromLean.outMin,   E.fearFromLean.outMax), 0,5);
  let poseJoy    =constrain(map(smoothedStructure,  E.joyFromStructure.inMin,E.joyFromStructure.inMax,E.joyFromStructure.outMin,E.joyFromStructure.outMax), 0,5);

  const BL=E.blendPoseVsSlider, blend=(p,s)=>lerp(s,p,BL);
  emotionSliders.anxiety.value( blend(poseAnxiety, emotionSliders.anxiety.value()) );
  emotionSliders.calm.value(    blend(poseCalm,    emotionSliders.calm.value()) );
  emotionSliders.sadness.value( blend(poseSadness, emotionSliders.sadness.value()) );
  emotionSliders.fear.value(    blend(poseFear,    emotionSliders.fear.value()) );
  emotionSliders.joy.value(     blend(poseJoy,     emotionSliders.joy.value()) );
  emotionSliders.anger.value(   blend(poseAnger,   emotionSliders.anger.value()) );
}

// ------------------------ REGION COUPLING ------------------------------
function regionVelocity(pose, parts){
  const diag=Math.hypot(video?.width||640, video?.height||480)||1;
  let sum=0, n=0;
  for(const name of parts){
    const k = pose.keypoints.find(p=>p.part===name && p.score > TUNE.velocity.kpMinScore);
    if(!k) continue;
    const prev = __prevByPart.get(name);
    if(prev){ const dx=(k.position.x - prev.x)/diag; const dy=(k.position.y - prev.y)/diag; sum += Math.hypot(dx,dy); n++; }
    __prevByPart.set(name, { x:k.position.x, y:k.position.y });
  }
  return n>0 ? (sum/n) : 0;
}

function coupleRegionsToPose(pose){
  if(!pose||!pose.keypoints) return; const C=TUNE.coupling; const get=part=>{ const k=pose.keypoints.find(p=>p.part===part && p.score> TUNE.velocity.kpMinScore); return k? k.position : null; };

  const ls=get('leftShoulder'), rs=get('rightShoulder');
  const lh=get('leftHip'), rh=get('rightHip');
  const lw=get('leftWrist'), rw=get('rightWrist');
  const la=get('leftAnkle'), ra=get('rightAnkle');

  // HEAD
  { const v=regionVelocity(pose, regionKeypoints.head); const val=constrain(map(v, C.head.velMin, C.head.velMax, 0,5), 0,5); regionSliders.head.value( lerp(regionSliders.head.value(), val, C.head.lerp) ); }

  // NECK
  { const v=regionVelocity(pose, regionKeypoints.neck); const val=constrain(map(v, C.neck.velMin, C.neck.velMax, 0,5), 0,5); regionSliders.neck.value( lerp(regionSliders.neck.value(), val, C.neck.lerp) ); }

  // ARMS/HANDS: spread + motion boost
  if(lw && rw && ls && rs){
    const span=dist(ls.x,ls.y,rs.x,rs.y);
    const wristSpread = dist(lw.x,lw.y,rw.x,rw.y) / max(span,1e-6);
    const base = constrain(map(wristSpread, C.armsHands.wristSpreadMin, C.armsHands.wristSpreadMax, 0,5), 0,5);
    const v    = regionVelocity(pose, regionKeypoints.armsHands);
    const boost= constrain(map(v, C.head.velMin, C.chest.velMax, 0,5), 0,5) * 0.5;
    const armsVal = constrain(base + boost, 0, 5);
    regionSliders.armsHands.value( lerp(regionSliders.armsHands.value(), armsVal, C.armsHands.lerp) );
  }

  // CHEST: motion + openness
  if(ls && rs){
    const span=dist(ls.x,ls.y,rs.x,rs.y);
    let openness=0; if(lw && rw){ const lwR=dist(ls.x,ls.y,lw.x,lw.y)/span; const rwR=dist(rs.x,rs.y,rw.x,rw.y)/span; openness = (lwR+rwR)*0.5; }
    const openVal = constrain(map(openness, C.chest.reachMin, C.chest.reachMax, 0,5), 0,5);
    const v       = regionVelocity(pose, regionKeypoints.chest);
    const vVal    = constrain(map(v, C.chest.velMin, C.chest.velMax, 0,5), 0,5);
    const chestVal= constrain(0.6*openVal + 0.4*vVal, 0,5);
    regionSliders.chest.value( lerp(regionSliders.chest.value(), chestVal, C.chest.lerp) );
  }

  // ABDOMEN: compression + motion
  if(ls && rs && lh && rh){
    const span=dist(ls.x,ls.y,rs.x,rs.y);
    const scx=(ls.x+rs.x)/2, scy=(ls.y+rs.y)/2; const hcx=(lh.x+rh.x)/2, hcy=(lh.y+rh.y)/2;
    const torsoLen = dist(scx,scy,hcx,hcy)/max(span,1e-6); // larger when tall/extended
    const torsoVal = 5 - constrain(map(torsoLen, C.abdomen.torsoMin, C.abdomen.torsoMax, 0,5), 0,5); // compressed → wider
    const v        = regionVelocity(pose, regionKeypoints.abdomen);
    const vVal     = constrain(map(v, C.abdomen.velMin, C.abdomen.velMax, 0,5), 0,5);
    const abdVal   = constrain(0.6*torsoVal + 0.4*vVal, 0,5);
    regionSliders.abdomen.value( lerp(regionSliders.abdomen.value(), abdVal, C.abdomen.lerp) );
  }

  // LEGS/FEET: ankle spread + leg motion
  if(la && ra && lh && rh){
    const hipSpan = dist(lh.x,lh.y,rh.x,rh.y);
    const stepW   = dist(la.x,la.y,ra.x,ra.y) / max(hipSpan,1e-6);
    const spreadVal = constrain(map(stepW, C.legsFeet.ankleSpreadMin, C.legsFeet.ankleSpreadMax, 0,5), 0,5);
    const v         = regionVelocity(pose, regionKeypoints.legsFeet);
    const vVal      = constrain(map(v, C.legsFeet.velMin, C.legsFeet.velMax, 0,5), 0,5);
    const legsVal   = constrain(0.5*spreadVal + 0.5*vVal, 0,5);
    regionSliders.legsFeet.value( lerp(regionSliders.legsFeet.value(), legsVal, C.legsFeet.lerp) );
  }

  // SPINE sway
  if(ls && rs){
    const span=dist(ls.x,ls.y,rs.x,rs.y);
    const spineSway = ((ls.x + rs.x)*0.5 - (video?.width||640)/2)/max(span,1e-6);
    const spineVal = map(spineSway, -C.spine.swayRange, C.spine.swayRange, 0, regionMaxWidths.spine||100);
    regionSliders['spine'].value( lerp(regionSliders['spine'].value(), spineVal, C.spine.lerp) );
  }
}

function updatePoseTransform(pose){
  if(!pose||!pose.keypoints) return; const get=part=>{ const k=pose.keypoints.find(p=>p.part===part); return (k && k.score>TUNE.velocity.kpMinScore)? k.position : null; };
  const ls=get('leftShoulder'), rs=get('rightShoulder'), lh=get('leftHip'), rh=get('rightHip'); if(!(ls&&rs&&lh&&rh)) return;
  const cx=(ls.x+rs.x+lh.x+rh.x)/4, cy=(ls.y+rs.y+lh.y+rh.y)/4;
  const sx=(ls.x+rs.x)/2, sy=(ls.y+rs.y)/2, hx=(lh.x+rh.x)/2, hy=(lh.y+rh.y)/2; const ang=Math.atan2(hy-sy, hx-sx)-Math.PI/2;
  const shoulderW=Math.hypot(ls.x-rs.x, ls.y-rs.y); const baseline=220; const s=constrain(shoulderW/baseline, 0.6, 1.8);
  const L=TUNE.follow.lerp; poseTx=lerp(poseTx,cx,L.tx); poseTy=lerp(poseTy,cy,L.ty); poseRot=lerp(poseRot,ang,L.rot); poseSc=lerp(poseSc,s,L.sc); _poseSeenAt=millis();
}

function updatePoseAnchor(pose){
  if(!pose||!pose.keypoints) return; const get=part=>{ const k=pose.keypoints.find(p=>p.part===part); return (k && k.score>TUNE.velocity.kpMinScore)? k.position : null; };
  const ls=get('leftShoulder'), rs=get('rightShoulder'), lh=get('leftHip'), rh=get('rightHip'); if(!(ls&&rs&&lh&&rh)) return;
  const cx=(ls.x+rs.x+lh.x+rh.x)/4, cy=(ls.y+rs.y+lh.y+rh.y)/4; poseTx=lerp(poseTx,cx,0.25); poseTy=lerp(poseTy,cy,0.25); _poseSeenAt=millis();
}

function emitPoseToControl(pose){
  if (!window.EnergyBodiesDisplay || !pose?.keypoints?.length) return;
  const vw = video?.width  || 640;
  const vh = video?.height || 480;
  const pts = pose.keypoints.map(k => [k.part, k.position.x / vw, k.position.y / vh, k.score]);
  window.EnergyBodiesDisplay.pose({ keypoints: pts, vw, vh, t: millis() });
}

function drawSkeleton(){
  const cvs = document.getElementById('skelCanvas');
  if (!cvs || !latestPose?.keypoints) return;

  // Make the canvas match CSS size
  const rect = cvs.getBoundingClientRect();
  if (cvs.width  !== Math.floor(rect.width) ||
      cvs.height !== Math.floor(rect.height)) {
    cvs.width  = Math.floor(rect.width);
    cvs.height = Math.floor(rect.height);
  }

  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;

  ctx.clearRect(0, 0, W, H);

  // Build a map: part -> {x,y,score} scaled to canvas
  const pts = new Map();
  latestPose.keypoints.forEach(([part, nx, ny, s]) => {
    pts.set(part, { x: nx * W, y: ny * H, s });
  });

  // Draw bones (edges)
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(160,190,255,0.9)';
  ctx.beginPath();
  EDGES.forEach(([a,b]) => {
    const pa = pts.get(a), pb = pts.get(b);
    if (!pa || !pb) return;
    // (optional) skip if both confidences are very low
    if ((pa.s ?? 0) < 0.2 && (pb.s ?? 0) < 0.2) return;
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  });
  ctx.stroke();

  // Draw joints
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  pts.forEach(p => {
    if ((p.s ?? 0) < 0.15) return;         // hide very low confidence
    const r = 3 + 2 * Math.max(0, Math.min(1, p.s)); // size by confidence
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI*2);
    ctx.fill();
  });
}


function windowResized(){
  resizeCanvas(windowWidth, windowHeight);
  scene = createGraphics(width, height); scene.colorMode(RGB); scene.noFill(); scene.stroke(255); scene.strokeWeight(2);
  patternGraphics = createGraphics(width, height);
  shapeMask = createGraphics(width, height);
  emotionGraphics = createGraphics(width, height);
  originOffset = createVector(width/2, height/2);
}

// ---------------------- CONTROL PANEL INTEGRATION ----------------------
// 1) Apply incoming slider values from control (blended for stability)
function applySliders(emotion = {}, region = {}){
  const BLEND = 0.35; // 0=ignore incoming, 1=overwrite (tune as desired)
  for (const k in emotion){ if (emotionSliders[k]){ const cur = emotionSliders[k].value(); emotionSliders[k].value( lerp(cur, Number(emotion[k])||0, BLEND) ); } }
  for (const k in region){ if (regionSliders[k]){ const cur = regionSliders[k].value(); regionSliders[k].value( lerp(cur, Number(region[k])||0, BLEND) ); } }
  maybeEchoState();
}

// 🔧 DROP-IN PATCH — ensures Reset zeroes ALL sliders, stops PoseNet tracking,
// blocks incoming slider updates briefly, and echoes zeros to the iPad UI.
// 
// HOW TO INSTALL
// 1) Paste this whole block into sketch.js (near your CONTROL PANEL INTEGRATION).
// 2) In setup(), add:    window.resetAll = resetAll;
// 3) Wire your button to call:    window.resetAll();    (or dispatch event 'eb:reset')
//
// Optional: If you want to also pause the camera stream on reset, set PAUSE_CAMERA_ON_RESET=true.

// --- CONFIG -----------------------------------------------------------------
const PAUSE_CAMERA_ON_RESET = false;   // set true to pause webcam on reset
const RESET_INPUT_BLOCK_MS   = 600;    // ignore incoming slider updates for this many ms

// --- INTERNAL STATE ----------------------------------------------------------
let __blockIncomingUntil = 0;          // millis() until which applySliders ignores input

// ❶ Replace your applySliders() with this version (or add the guard lines at top)
function applySliders(emotion = {}, region = {}, opts = {}){
  // Guard: briefly ignore incoming control updates after a reset
  const now = millis ? millis() : 0;
  if (!opts.force && now < __blockIncomingUntil) return;

  const BLEND = 0.35; // 0=ignore incoming, 1=overwrite (tune as desired)
  for (const k in emotion){
    if (emotionSliders[k]){
      const cur = emotionSliders[k].value();
      emotionSliders[k].value( lerp(cur, Number(emotion[k])||0, BLEND) );
    }
  }
  for (const k in region){
    if (regionSliders[k]){
      const cur = regionSliders[k].value();
      regionSliders[k].value( lerp(cur, Number(region[k])||0, BLEND) );
    }
  }
  maybeEchoState();
}

// ❷ Add this resetAll() function
function resetAll({ echo = true, resetPoseCaches = true, stopTrackingNow = true } = {}) {
  // A) Stop PoseNet tracking (and optionally pause camera)
  if (stopTrackingNow) {
    try { if (typeof stopTracking === 'function') stopTracking(); } catch(err) { console.warn(err); }
    if (window.EnergyBodiesDisplay && typeof EnergyBodiesDisplay.tracking === 'function') {
      try { EnergyBodiesDisplay.tracking(false); } catch(err) { console.warn(err); }
    }
    if (PAUSE_CAMERA_ON_RESET && video?.elt && typeof video.elt.pause === 'function') {
      try { video.elt.pause(); } catch(err) { console.warn(err); }
    }
  }

  // B) Zero all emotion & region sliders (renderer-side state)
  for (const n of emotionNames) {
    if (emotionSliders[n]) emotionSliders[n].value(0);
  }
  for (const n of [...regionNames, 'spine']) {
    if (regionSliders[n]) regionSliders[n].value(0);
  }

  // C) Zero derived pose metrics so visuals immediately calm
  movementVelocity = 0;
  fastVel = 0;
  slowVel = 0;
  smoothedStructure = 0;
  smoothedBalance = 0;
  smoothedPostureLean = 0;
  smoothedAvgY = 0;

  // D) Reset pose-follow transform and flags
  followPose = false;
  followAxis = 'both';
  poseRot = 0;
  poseSc  = 1;
  const vw = video?.width || 640;
  const vh = video?.height || 480;
  poseTx = vw / 2;
  poseTy = vh / 2;
  _poseSeenAt = millis ? millis() : 0;

  // E) Clear motion caches so next frame re-seeds velocity deltas
  if (resetPoseCaches) {
    __prevKeypoints = null;
    if (__prevByPart?.clear) __prevByPart.clear();
    latestPose = null;
    poses = [];
  }

  // F) Clear offscreen layers immediately
  scene?.clear?.();
  patternGraphics?.clear?.();
  emotionGraphics?.clear?.();
  shapeMask?.clear?.();

  // G) Block incoming slider updates briefly so the zeros "stick"
  __blockIncomingUntil = (millis ? millis() : 0) + RESET_INPUT_BLOCK_MS;

  // H) Echo zeros so the iPad mirrors renderer truth
  if (echo && typeof maybeEchoState === 'function') {
    maybeEchoState();
  }

  console.log('[RESET] full zero + tracking stopped');
}



// 2) Emit pose metrics back to control at ~12 FPS
let __lastEmitMs = 0;
function emitPoseMetrics(){
  const now = millis();
  if (now - __lastEmitMs < 80) return; // ~12.5 fps throttle
  __lastEmitMs = now;
  if (window.EnergyBodiesDisplay){
    EnergyBodiesDisplay.pose({
      movementVelocity, fastVel, structure: smoothedStructure,
      balance: smoothedBalance, postureLean: smoothedPostureLean,
      avgY: smoothedAvgY
    });
  }
}

// 3) Echo current renderer slider state (optional; helps iPad mirror truth)
let __lastEcho = 0;
function maybeEchoState(){
  const t = millis();
  if (!window.EnergyBodiesDisplay) return;
  if (t - __lastEcho < 250) return; // 4 Hz
  __lastEcho = t;
  const emotion = {}; const region = {};
  for (const n of emotionNames) emotion[n] = Number(emotionSliders[n].value());
  for (const n of [...regionNames, 'spine']) region[n] = Number(regionSliders[n]?.value()||0);
  EnergyBodiesDisplay.echo({ emotion, region });
}
