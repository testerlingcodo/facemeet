// In production, point to your Render backend URL
const BACKEND = window.location.hostname === 'localhost'
  ? ''
  : 'https://REPLACE_WITH_YOUR_RENDER_URL.onrender.com';
const socket = io(BACKEND);

// ── STATE ──
let localStream = null;     // raw camera stream
let filteredStream = null;  // canvas-processed stream sent to peers
let myName = '';
let roomId = '';
let micOn = true;
let camOn = true;
let currentFilter = 'none';
let currentArFilter = 'none';
let filterAnimId = null;
let faceMesh = null;
let faceMeshReady = false;
let lastFaceLandmarks = null;
const peers = {}; // peerId -> RTCPeerConnection

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── DOM ──
const joinScreen      = document.getElementById('join-screen');
const meetingScreen   = document.getElementById('meeting-screen');
const nameInput       = document.getElementById('name-input');
const roomInput       = document.getElementById('room-input');
const joinBtn         = document.getElementById('join-btn');
const randomBtn       = document.getElementById('random-btn');
const videoGrid       = document.getElementById('video-grid');
const micBtn          = document.getElementById('mic-btn');
const camBtn          = document.getElementById('cam-btn');
const filterBtnToggle = document.getElementById('filter-btn-toggle');
const camSelectBtn    = document.getElementById('cam-select-btn');
const camPicker       = document.getElementById('cam-picker');
const camList         = document.getElementById('cam-list');
const leaveBtn        = document.getElementById('leave-btn');
const copyBtn         = document.getElementById('copy-btn');
const roomCodeDisplay = document.getElementById('room-code-display');
const countEl         = document.getElementById('count');
const toast           = document.getElementById('toast');
const filterPanel     = document.getElementById('filter-panel');
const filterBtns      = document.querySelectorAll('.filter-btn');

// ── HELPERS ──
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?';
}

function updateCount() {
  const n = Object.keys(peers).length + 1;
  countEl.textContent = n;
  videoGrid.className = '';
  videoGrid.classList.add(`count-${Math.min(n, 9)}`);
}

// ── FILTER ENGINE (canvas) ──
// Draws the raw camera video through a canvas with CSS filter,
// producing a filtered MediaStream that gets sent to peers.
let filterCanvas, filterCtx, filterSourceVideo;

function startFilterCanvas(rawStream) {
  filterCanvas = document.createElement('canvas');
  filterCanvas.width = 640;
  filterCanvas.height = 480;
  filterCtx = filterCanvas.getContext('2d');

  filterSourceVideo = document.createElement('video');
  filterSourceVideo.srcObject = rawStream;
  filterSourceVideo.autoplay = true;
  filterSourceVideo.playsInline = true;
  filterSourceVideo.muted = true;

  let lastFaceMeshSend = 0;

  function drawFrame() {
    if (filterSourceVideo.readyState >= 2) {
      const W = filterCanvas.width, H = filterCanvas.height;
      filterCtx.filter = currentFilter === 'none' ? 'none' : currentFilter;
      filterCtx.drawImage(filterSourceVideo, 0, 0, W, H);
      filterCtx.filter = 'none';

      // Draw AR overlay using last known landmarks
      if (currentArFilter !== 'none' && lastFaceLandmarks) {
        drawArOverlay(filterCtx, lastFaceLandmarks, W, H);
      }

      // Send frame to face mesh (throttled ~15fps)
      if (currentArFilter !== 'none' && faceMeshReady) {
        const now = performance.now();
        if (now - lastFaceMeshSend > 66) {
          lastFaceMeshSend = now;
          faceMesh.send({ image: filterSourceVideo }).catch(() => {});
        }
      }
    }
    filterAnimId = requestAnimationFrame(drawFrame);
  }
  filterSourceVideo.onloadedmetadata = drawFrame;

  // Combine canvas video track + original audio tracks
  const canvasStream = filterCanvas.captureStream(30);
  const audioTracks = rawStream.getAudioTracks();
  audioTracks.forEach(t => canvasStream.addTrack(t));
  return canvasStream;
}

function applyFilter(filterValue, label) {
  currentFilter = filterValue;

  // Update local preview CSS filter
  const localTile = document.getElementById('tile-local');
  if (localTile) {
    const video = localTile.querySelector('video');
    if (video) video.style.filter = filterValue === 'none' ? '' : filterValue;

    // Show/hide badge
    let badge = localTile.querySelector('.filter-badge');
    if (filterValue === 'none') {
      if (badge) badge.remove();
    } else {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'filter-badge';
        localTile.appendChild(badge);
      }
      badge.textContent = label;
    }
  }

  // The canvas already picks up the new currentFilter on next frame draw
}

// ── VIDEO TILES ──
function addVideoTile(id, name, stream, isLocal = false) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;
  tile.dataset.initials = initials(name);

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  if (stream) video.srcObject = stream;

  const nameTag = document.createElement('div');
  nameTag.className = 'name-tag';
  nameTag.textContent = isLocal ? `${name} (You)` : name;

  const micOffIcon = document.createElement('div');
  micOffIcon.className = 'mic-off';
  micOffIcon.textContent = '🔇';
  micOffIcon.id = `mic-off-${id}`;

  tile.appendChild(video);
  tile.appendChild(nameTag);
  tile.appendChild(micOffIcon);
  videoGrid.appendChild(tile);
  updateCount();
  return tile;
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  updateCount();
}

// ── ENTER MEETING ──
async function enterMeeting() {
  myName = nameInput.value.trim() || 'Guest';
  roomId = roomInput.value.trim().toUpperCase().replace(/\s+/g, '');
  if (!roomId) { showToast('Enter a room code'); return; }

  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting…';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      showToast('Camera not available — audio only');
    } catch {
      localStream = new MediaStream();
      showToast('No camera/mic found — joining without media');
    }
  }

  // Save active camera ID for the picker
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) activeCameraId = videoTrack.getSettings().deviceId;

  // Build filtered stream for sending to peers
  filteredStream = startFilterCanvas(localStream);

  // Switch screens
  joinScreen.classList.remove('active');
  meetingScreen.classList.add('active');
  roomCodeDisplay.textContent = roomId;
  videoGrid.className = 'count-1';

  // Local preview shows raw stream (filter applied via CSS in applyFilter)
  addVideoTile('local', myName, localStream, true);
  socket.emit('join-room', roomId, myName);
}

// ── WebRTC (use filteredStream for sending) ──
function getOutgoingStream() {
  return filteredStream || localStream;
}

async function createPeer(targetId, isInitiator, userName) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[targetId] = pc;

  getOutgoingStream().getTracks().forEach(track => pc.addTrack(track, getOutgoingStream()));

  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    const tile = document.getElementById(`tile-${targetId}`);
    if (tile) tile.querySelector('video').srcObject = remoteStream;
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', targetId, e.candidate);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeVideoTile(targetId);
      delete peers[targetId];
    }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', targetId, offer);
    addVideoTile(targetId, userName || targetId, remoteStream);
  }

  return pc;
}

// ── SOCKET EVENTS ──
socket.on('existing-users', async (userIds) => {
  for (const id of userIds) {
    await createPeer(id, true, id);
  }
});

socket.on('user-joined', (id, name) => {
  showToast(`${name} joined`);
});

socket.on('offer', async (fromId, offer, fromName) => {
  const remoteStream = new MediaStream();
  addVideoTile(fromId, fromName || fromId, remoteStream);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[fromId] = pc;

  getOutgoingStream().getTracks().forEach(track => pc.addTrack(track, getOutgoingStream()));

  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    const tile = document.getElementById(`tile-${fromId}`);
    if (tile) tile.querySelector('video').srcObject = remoteStream;
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', fromId, e.candidate);
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', fromId, answer);
});

socket.on('answer', async (fromId, answer) => {
  const pc = peers[fromId];
  if (pc) await pc.setRemoteDescription(answer);
});

socket.on('ice-candidate', async (fromId, candidate) => {
  const pc = peers[fromId];
  if (pc) {
    try { await pc.addIceCandidate(candidate); } catch {}
  }
});

socket.on('user-left', (id, name) => {
  showToast(`${name || 'Someone'} left`);
  removeVideoTile(id);
  if (peers[id]) {
    peers[id].close();
    delete peers[id];
  }
});

// ── CONTROLS ──
micBtn.addEventListener('click', () => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  document.getElementById('mic-icon-on').style.display  = micOn ? '' : 'none';
  document.getElementById('mic-icon-off').style.display = micOn ? 'none' : '';
  micBtn.classList.toggle('off', !micOn);
  document.getElementById('mic-label').textContent = micOn ? 'Mute' : 'Unmute';
  document.getElementById('mic-off-local').style.display = micOn ? 'none' : 'block';
});

camBtn.addEventListener('click', () => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  document.getElementById('cam-icon-on').style.display  = camOn ? '' : 'none';
  document.getElementById('cam-icon-off').style.display = camOn ? 'none' : '';
  camBtn.classList.toggle('off', !camOn);
  document.getElementById('cam-label').textContent = camOn ? 'Stop Video' : 'Start Video';
  const tile = document.getElementById('tile-local');
  if (tile) tile.classList.toggle('cam-off', !camOn);
});

// ── AR FILTERS ──
async function initFaceMesh() {
  if (faceMesh) return;
  faceMesh = new window.FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  faceMesh.onResults((results) => {
    lastFaceLandmarks = results.multiFaceLandmarks?.[0] || null;
  });
  await faceMesh.initialize();
  faceMeshReady = true;
}

function lm(landmarks, i, w, h) {
  return { x: landmarks[i].x * w, y: landmarks[i].y * h };
}

function drawArOverlay(ctx, landmarks, w, h) {
  switch (currentArFilter) {
    case 'dog':     drawDogAr(ctx, landmarks, w, h);     break;
    case 'cat':     drawCatAr(ctx, landmarks, w, h);     break;
    case 'bunny':   drawBunnyAr(ctx, landmarks, w, h);   break;
    case 'glasses': drawGlassesAr(ctx, landmarks, w, h); break;
    case 'crown':   drawCrownAr(ctx, landmarks, w, h);   break;
  }
}

// ── DOG ──
function drawDogAr(ctx, L, w, h) {
  const faceL = lm(L, 234, w, h);
  const faceR = lm(L, 454, w, h);
  const nose  = lm(L, 4, w, h);
  const faceW = faceR.x - faceL.x;
  const earW  = faceW * 0.38, earH = faceW * 0.55;

  // Left ear
  ctx.save();
  ctx.translate(faceL.x + faceW * 0.04, faceL.y + faceW * 0.04);
  ctx.rotate(0.28);
  drawFlopEar(ctx, earW, earH, '#7B4F2E', '#C49A6C');
  ctx.restore();

  // Right ear (mirrored)
  ctx.save();
  ctx.translate(faceR.x - faceW * 0.04, faceR.y + faceW * 0.04);
  ctx.rotate(-0.28);
  ctx.scale(-1, 1);
  drawFlopEar(ctx, earW, earH, '#7B4F2E', '#C49A6C');
  ctx.restore();

  // Dog nose
  const nR = faceW * 0.1;
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(nose.x, nose.y, nR * 1.4, nR, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.ellipse(nose.x - nR * 0.45, nose.y - nR * 0.3, nR * 0.4, nR * 0.28, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlopEar(ctx, w, h, outer, inner) {
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-w * 0.6, -h * 0.25, -w * 0.8, -h * 0.85, -w * 0.28, -h);
  ctx.bezierCurveTo(w * 0.22, -h * 1.15, w * 0.62, -h * 0.78, w * 0.5, -h * 0.28);
  ctx.bezierCurveTo(w * 0.38, 0, w * 0.18, 0, 0, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.15);
  ctx.bezierCurveTo(-w * 0.32, -h * 0.38, -w * 0.42, -h * 0.75, -w * 0.12, -h * 0.88);
  ctx.bezierCurveTo(w * 0.12, -h * 0.98, w * 0.36, -h * 0.68, w * 0.26, -h * 0.32);
  ctx.bezierCurveTo(w * 0.18, -h * 0.14, w * 0.08, -h * 0.1, 0, -h * 0.15);
  ctx.closePath();
  ctx.fill();
}

// ── CAT ──
function drawCatAr(ctx, L, w, h) {
  const faceL = lm(L, 234, w, h);
  const faceR = lm(L, 454, w, h);
  const top   = lm(L, 10, w, h);
  const nose  = lm(L, 4, w, h);
  const faceW = faceR.x - faceL.x;
  const eS    = faceW * 0.21;

  drawCatEar(ctx, faceL.x + faceW * 0.22, top.y - faceW * 0.02, eS, -0.14, '#FF9500', '#FFD7A8');
  drawCatEar(ctx, faceR.x - faceW * 0.22, top.y - faceW * 0.02, eS,  0.14, '#FF9500', '#FFD7A8');

  // Cat nose triangle
  const nR = faceW * 0.042;
  ctx.fillStyle = '#FF69B4';
  ctx.beginPath();
  ctx.moveTo(nose.x, nose.y - nR * 0.9);
  ctx.lineTo(nose.x - nR * 1.3, nose.y + nR * 0.8);
  ctx.lineTo(nose.x + nR * 1.3, nose.y + nR * 0.8);
  ctx.closePath();
  ctx.fill();

  // Whiskers
  const wL = faceW * 0.33;
  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.lineWidth = Math.max(1.5, faceW * 0.007);
  ctx.lineCap = 'round';
  [[-1, 0], [0, 0], [1, 0.018]].forEach(([row, slant]) => {
    const offY = row * faceW * 0.026;
    ctx.beginPath();
    ctx.moveTo(nose.x - faceW * 0.06, nose.y + offY);
    ctx.lineTo(nose.x - faceW * 0.06 - wL, nose.y + offY - slant * faceW);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nose.x + faceW * 0.06, nose.y + offY);
    ctx.lineTo(nose.x + faceW * 0.06 + wL, nose.y + offY - slant * faceW);
    ctx.stroke();
  });
}

function drawCatEar(ctx, x, y, size, tilt, outerColor, innerColor) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.fillStyle = outerColor;
  ctx.beginPath();
  ctx.moveTo(-size, size * 0.1);
  ctx.lineTo(0, -size * 2.1);
  ctx.lineTo(size, size * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = innerColor;
  ctx.beginPath();
  ctx.moveTo(-size * 0.48, size * 0.05);
  ctx.lineTo(0, -size * 1.5);
  ctx.lineTo(size * 0.48, size * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── BUNNY ──
function drawBunnyAr(ctx, L, w, h) {
  const faceL = lm(L, 234, w, h);
  const faceR = lm(L, 454, w, h);
  const top   = lm(L, 10, w, h);
  const nose  = lm(L, 4, w, h);
  const faceW = faceR.x - faceL.x;
  const eW = faceW * 0.13, eH = faceW * 0.88;

  ctx.save();
  ctx.translate(top.x - faceW * 0.19, top.y + faceW * 0.06);
  ctx.rotate(-0.11);
  drawBunnyEar(ctx, eW, eH);
  ctx.restore();

  ctx.save();
  ctx.translate(top.x + faceW * 0.19, top.y + faceW * 0.06);
  ctx.rotate(0.11);
  drawBunnyEar(ctx, eW, eH);
  ctx.restore();

  // Bunny nose
  const nR = faceW * 0.052;
  ctx.fillStyle = '#FFB6C1';
  ctx.beginPath();
  ctx.ellipse(nose.x, nose.y, nR, nR * 0.68, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBunnyEar(ctx, w, h) {
  ctx.fillStyle = '#f0f0f0';
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.ellipse(0, -h / 2, w, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#FFB6C1';
  ctx.beginPath();
  ctx.ellipse(0, -h / 2, w * 0.48, h * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ── SUNGLASSES ──
function drawGlassesAr(ctx, L, w, h) {
  const lOuter = lm(L, 133, w, h);
  const lInner = lm(L,  33, w, h);
  const rOuter = lm(L, 362, w, h);
  const rInner = lm(L, 263, w, h);
  const lCx = (lOuter.x + lInner.x) / 2, lCy = (lOuter.y + lInner.y) / 2;
  const rCx = (rOuter.x + rInner.x) / 2, rCy = (rOuter.y + rInner.y) / 2;
  const lensR = Math.abs(rOuter.x - lOuter.x) * 0.29;

  function drawLens(cx, cy) {
    const g = ctx.createRadialGradient(cx - lensR * 0.3, cy - lensR * 0.3, lensR * 0.05, cx, cy, lensR);
    g.addColorStop(0, 'rgba(50,70,120,0.82)');
    g.addColorStop(1, 'rgba(8,15,35,0.95)');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(2, lensR * 0.09);
    ctx.beginPath();
    ctx.ellipse(cx, cy, lensR, lensR * 0.74, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.ellipse(cx - lensR * 0.28, cy - lensR * 0.28, lensR * 0.28, lensR * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLens(lCx, lCy);
  drawLens(rCx, rCy);

  // Bridge
  const midY = (lCy + rCy) / 2;
  ctx.strokeStyle = '#222';
  ctx.lineWidth = Math.max(2, lensR * 0.07);
  ctx.beginPath();
  ctx.moveTo(lCx + lensR * 0.88, midY);
  ctx.lineTo(rCx - lensR * 0.88, midY);
  ctx.stroke();

  // Arms
  const faceL = lm(L, 234, w, h), faceR = lm(L, 454, w, h);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = Math.max(2, lensR * 0.08);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(lCx - lensR * 0.95, lCy);
  ctx.lineTo(faceL.x, lCy + lensR * 0.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rCx + lensR * 0.95, rCy);
  ctx.lineTo(faceR.x, rCy + lensR * 0.1);
  ctx.stroke();
}

// ── CROWN ──
function drawCrownAr(ctx, L, w, h) {
  const faceL = lm(L, 234, w, h);
  const faceR = lm(L, 454, w, h);
  const top   = lm(L, 10, w, h);
  const faceW = faceR.x - faceL.x;
  const cW = faceW * 0.72, cH = faceW * 0.38;
  const cx = top.x - cW / 2, cy = top.y;

  const grad = ctx.createLinearGradient(cx, cy, cx, cy - cH);
  grad.addColorStop(0, '#B8860B');
  grad.addColorStop(0.5, '#FFD700');
  grad.addColorStop(1, '#FFF5A0');
  ctx.fillStyle = grad;
  ctx.strokeStyle = '#A0740A';
  ctx.lineWidth = Math.max(1.5, faceW * 0.005);

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - cH * 0.52);
  ctx.lineTo(cx + cW * 0.14, cy - cH * 0.22);
  ctx.lineTo(cx + cW * 0.29, cy - cH);
  ctx.lineTo(cx + cW * 0.44, cy - cH * 0.32);
  ctx.lineTo(cx + cW * 0.5, cy - cH * 1.18);
  ctx.lineTo(cx + cW * 0.56, cy - cH * 0.32);
  ctx.lineTo(cx + cW * 0.71, cy - cH);
  ctx.lineTo(cx + cW * 0.86, cy - cH * 0.22);
  ctx.lineTo(cx + cW, cy - cH * 0.52);
  ctx.lineTo(cx + cW, cy);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Gems
  [
    { rx: 0.29, ry: 0.88, r: 0.036, color: '#FF3333' },
    { rx: 0.5,  ry: 1.1,  r: 0.042, color: '#3388FF' },
    { rx: 0.71, ry: 0.88, r: 0.036, color: '#33FF88' },
  ].forEach(g => {
    const gx = cx + cW * g.rx, gy = cy - cH * g.ry, gr = faceW * g.r;
    ctx.fillStyle = g.color;
    ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(gx - gr * 0.3, gy - gr * 0.3, gr * 0.38, 0, Math.PI * 2); ctx.fill();
  });
}

// ── AR BUTTON EVENTS ──
document.querySelectorAll('.ar-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const ar = btn.dataset.ar;
    document.querySelectorAll('.ar-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentArFilter = ar;

    if (ar !== 'none' && !faceMeshReady) {
      showToast('Loading AR engine…');
      await initFaceMesh();
      showToast('AR ready!');
    }
    if (ar === 'none') lastFaceLandmarks = null;
  });
});

// ── CAMERA SELECTION ──
let activeCameraId = null;

async function loadCameraList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(d => d.kind === 'videoinput');
  camList.innerHTML = '';
  cameras.forEach((cam, i) => {
    const li = document.createElement('li');
    const isActive = cam.deviceId === activeCameraId;
    if (isActive) li.classList.add('active');
    li.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="flex-shrink:0;opacity:0.7">
        <rect x="2" y="6" width="14" height="12" rx="2"/>
        <path d="M16 9l5-3v12l-5-3V9z"/>
      </svg>
      <span>${cam.label || `Camera ${i + 1}`}</span>
      <span class="cam-check">✓</span>
    `;
    li.addEventListener('click', () => switchCamera(cam.deviceId));
    camList.appendChild(li);
  });
}

async function switchCamera(deviceId) {
  if (deviceId === activeCameraId) { camPicker.style.display = 'none'; return; }
  activeCameraId = deviceId;

  // Get new video stream from selected camera
  const newVideoStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false
  });
  const newVideoTrack = newVideoStream.getVideoTracks()[0];

  // Replace in localStream
  const oldVideoTrack = localStream.getVideoTracks()[0];
  if (oldVideoTrack) { localStream.removeTrack(oldVideoTrack); oldVideoTrack.stop(); }
  localStream.addTrack(newVideoTrack);

  // Update local preview
  const localVideo = document.querySelector('#tile-local video');
  if (localVideo) localVideo.srcObject = localStream;

  // Restart canvas filter source
  if (filterSourceVideo) filterSourceVideo.srcObject = localStream;

  // Replace track in all peer connections
  Object.values(peers).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(newVideoTrack);
  });

  // Refresh list UI
  camPicker.style.display = 'none';
  showToast(`Camera switched`);
  await loadCameraList();
}

camSelectBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const isOpen = camPicker.style.display !== 'none';
  if (isOpen) { camPicker.style.display = 'none'; return; }
  await loadCameraList();
  camPicker.style.display = 'block';
});

// Close picker when clicking outside
document.addEventListener('click', (e) => {
  if (!camPicker.contains(e.target) && e.target !== camSelectBtn) {
    camPicker.style.display = 'none';
  }
});

filterBtnToggle.addEventListener('click', () => {
  filterPanel.classList.toggle('open');
  filterBtnToggle.classList.toggle('active', filterPanel.classList.contains('open'));
});

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filterVal = btn.dataset.filter;
    const label = btn.querySelector('span:last-child').textContent;
    applyFilter(filterVal, label);
    showToast(`Filter: ${label}`);
  });
});

leaveBtn.addEventListener('click', () => {
  if (filterAnimId) cancelAnimationFrame(filterAnimId);
  localStream.getTracks().forEach(t => t.stop());
  Object.values(peers).forEach(pc => pc.close());
  socket.disconnect();
  location.reload();
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Room code copied!'));
});

// ── JOIN FORM ──
joinBtn.addEventListener('click', enterMeeting);
randomBtn.addEventListener('click', () => {
  roomInput.value = randomCode();
});

[nameInput, roomInput].forEach(el => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterMeeting(); });
});

roomInput.addEventListener('input', () => {
  roomInput.value = roomInput.value.toUpperCase();
});
