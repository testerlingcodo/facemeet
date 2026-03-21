// In production, point to your Render backend URL
const BACKEND = window.location.hostname === 'localhost'
  ? ''
  : 'https://facemeet.onrender.com'; // ← change this to your actual Render URL
const socket = io(BACKEND);

// Register rooms-list handler immediately — BEFORE any socket events can fire
socket.on('rooms-list', (list) => {
  if (typeof renderRooms === 'function') renderRooms(list);
  else pendingRoomsList = list;  // store if renderRooms not defined yet (shouldn't happen)
});
let pendingRoomsList = null;

// Request current rooms list on every connect/reconnect
socket.on('connect', () => socket.emit('get-rooms'));

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
const remoteState  = {}; // id -> { muted, hidden, volume }
const audioCtxMap  = {}; // id -> { audioCtx, gainNode }
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
const passwordInput   = document.getElementById('password-input');
const pwHint          = document.getElementById('pw-hint');
const roomsList       = document.getElementById('rooms-list');
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
const chatBtn         = document.getElementById('chat-btn');
const chatBadge       = document.getElementById('chat-badge');
const chatPanel       = document.getElementById('chat-panel');
const chatClose       = document.getElementById('chat-close');
const chatMessages    = document.getElementById('chat-messages');
const chatInput       = document.getElementById('chat-input');
const chatSend        = document.getElementById('chat-send');
const copyBtn         = document.getElementById('copy-btn');
const roomCodeDisplay = document.getElementById('room-code-display');
const countEl         = document.getElementById('count');
const toast           = document.getElementById('toast');
const filterPanel     = document.getElementById('filter-panel');
const filterBtns      = document.querySelectorAll('.filter-btn');
const chatBanner      = document.getElementById('chat-banner');
const chatBannerText  = document.getElementById('chat-banner-text');
const chatBannerOpen  = document.getElementById('chat-banner-open');
const chatBannerDismiss = document.getElementById('chat-banner-dismiss');

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
  // Wait for the new tile to be in the DOM before measuring
  requestAnimationFrame(() => relayout(n));
}

function relayout(n) {
  if (!n) n = videoGrid.children.length || 1;
  if (n < 1) n = 1;

  // getBoundingClientRect is accurate even before the next paint
  const rect = videoGrid.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  // If still 0, the flex layout hasn't run yet — retry next frame
  if (W <= 0 || H <= 0) {
    requestAnimationFrame(() => relayout(n));
    return;
  }

  const GAP   = 6;
  const PAD   = 12;
  const aw    = W - PAD;
  const ah    = H - PAD;
  const RATIO = 16 / 9;
  let bestCols = 1, bestArea = 0;

  for (let cols = 1; cols <= n; cols++) {
    const rows  = Math.ceil(n / cols);
    const tileW = (aw - GAP * (cols - 1)) / cols;
    const tileH = (ah - GAP * (rows - 1)) / rows;
    const fitW  = Math.min(tileW, tileH * RATIO);
    const area  = fitW * (fitW / RATIO);
    if (area > bestArea) { bestArea = area; bestCols = cols; }
  }

  const bestRows = Math.ceil(n / bestCols);
  videoGrid.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
  videoGrid.style.gridTemplateRows    = `repeat(${bestRows}, 1fr)`;
}

// Recalculate on any resize
new ResizeObserver(() => requestAnimationFrame(() => relayout())).observe(videoGrid);

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
  filterSourceVideo.playsInline = true;
  filterSourceVideo.muted = true;
  filterSourceVideo.setAttribute('playsinline', '');
  // Append hidden to body so browsers allow autoplay on it
  filterSourceVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(filterSourceVideo);

  let lastFaceMeshSend = 0;
  let drawStarted = false;

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

  function startDraw() {
    if (drawStarted) return;
    drawStarted = true;
    filterSourceVideo.play().catch(() => {});
    drawFrame();
  }

  if (filterSourceVideo.readyState >= 1) {
    startDraw();
  } else {
    filterSourceVideo.onloadedmetadata = startDraw;
    filterSourceVideo.oncanplay = startDraw;
  }
  // Fallback: start after short delay regardless
  setTimeout(startDraw, 500);

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

  // Remote-muted badge
  const remoteMutedBadge = document.createElement('div');
  remoteMutedBadge.className = 'remote-muted-badge';
  remoteMutedBadge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="11" height="11"><rect x="9" y="2" width="6" height="11" rx="3" opacity="0.5"/><line x1="3" y1="3" x2="21" y2="21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg> Muted by you`;

  // Cam hidden overlay
  const camHiddenOverlay = document.createElement('div');
  camHiddenOverlay.className = 'cam-hidden-overlay';
  camHiddenOverlay.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="32" height="32"><rect x="2" y="6" width="14" height="12" rx="2" opacity="0.5"/><path d="M16 9l5-3v12l-5-3V9z" opacity="0.5"/><line x1="3" y1="3" x2="21" y2="21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg><span>Camera hidden</span>`;

  tile.appendChild(video);
  tile.appendChild(nameTag);
  tile.appendChild(micOffIcon);
  tile.appendChild(remoteMutedBadge);
  tile.appendChild(camHiddenOverlay);


  videoGrid.appendChild(tile);
  updateCount();
  return tile;
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) {
    tile.classList.add('leaving');
    tile.addEventListener('animationend', () => {
      tile.remove();
      updateCount();
    }, { once: true });
    // Fallback if animation doesn't fire
    setTimeout(() => { if (tile.parentNode) { tile.remove(); updateCount(); } }, 350);
  } else {
    updateCount();
  }
  delete remoteState[id];
  if (audioCtxMap[id]) { audioCtxMap[id].audioCtx.close(); delete audioCtxMap[id]; }
}

// ── ENTER MEETING ──
async function enterMeeting() {
  myName = nameInput.value.trim() || 'Guest';
  roomId = roomInput.value.trim().toUpperCase().replace(/\s+/g, '');
  if (!roomId) { showToast('Enter a room code'); return; }

  const password = passwordInput.value.trim();

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
  socket.emit('join-room', roomId, myName, password || null);
  // Broadcast initial mic state after joining
  socket.emit('mic-toggle', !micOn);
}

// Wrong password — go back to join screen and clean up everything
socket.on('join-error', (msg) => {
  // Stop media
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  if (filterAnimId) cancelAnimationFrame(filterAnimId);
  filteredStream = null;

  // Clean up any peer connections started
  Object.values(peers).forEach(pc => pc.close());
  for (const k in peers) delete peers[k];

  // Remove any tiles that were added
  videoGrid.innerHTML = '';

  // Restore join screen
  meetingScreen.classList.remove('active');
  joinScreen.classList.add('active');
  joinBtn.disabled = false;
  joinBtn.textContent = 'Join Meeting';

  showToast(msg || 'Could not join room', 3000);

  // Highlight password field so user can re-enter
  passwordInput.value = '';
  passwordInput.focus();
  passwordInput.style.borderColor = '#ef4444';
  setTimeout(() => passwordInput.style.borderColor = '', 2000);
});

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
socket.on('existing-users', async (users) => {
  for (const user of users) {
    await createPeer(user.id, true, user.name);
  }
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
  appendSystemMsg(`${name || 'Someone'} left the meeting`);
  removeVideoTile(id);
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  // Clean up screen share UI if they were sharing
  if (id === currentSharerId) closeScreenShareUI();
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
  // Notify everyone in the room
  socket.emit('mic-toggle', !micOn);
});

// Receive mic state from remote peers
socket.on('peer-mic-toggle', (peerId, isMuted) => {
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;
  const badge = tile.querySelector('.mic-off');
  if (badge) badge.style.display = isMuted ? 'block' : 'none';
  tile.dataset.muted = isMuted ? '1' : '0';
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

// ── CONTEXT MENU (right-click on remote tiles) ──
const ctxMenu        = document.getElementById('ctx-menu');
const ctxNameEl      = document.getElementById('ctx-name');
const ctxMuteBtn     = document.getElementById('ctx-mute');
const ctxMuteLabel   = document.getElementById('ctx-mute-label');
const ctxHideBtn     = document.getElementById('ctx-hide');
const ctxHideLabel   = document.getElementById('ctx-hide-label');
const ctxVolumeSlider = document.getElementById('ctx-volume');
const ctxVolumeVal   = document.getElementById('ctx-volume-val');

// Per-participant local state (declared at top of file)

function getState(id) {
  if (!remoteState[id]) remoteState[id] = { muted: false, hidden: false, volume: 100 };
  return remoteState[id];
}

function getRemoteVideo(id) {
  const tile = document.getElementById(`tile-${id}`);
  return tile ? tile.querySelector('video') : null;
}

let ctxTargetId = null;

function openCtxMenu(e, id, name) {
  ctxTargetId = id;
  const state = getState(id);

  ctxNameEl.textContent = name;
  ctxMuteLabel.textContent = state.muted  ? 'Unmute'      : 'Mute';
  ctxHideLabel.textContent = state.hidden ? 'Show Camera' : 'Hide Camera';
  ctxMuteBtn.classList.toggle('active-state', state.muted);
  ctxHideBtn.classList.toggle('active-state', state.hidden);
  ctxVolumeSlider.value = state.volume;
  ctxVolumeVal.textContent = state.volume + '%';

  // Temporarily show off-screen to measure real height
  ctxMenu.style.visibility = 'hidden';
  ctxMenu.style.left = '-9999px';
  ctxMenu.style.top  = '-9999px';
  ctxMenu.classList.add('open');

  const mW = ctxMenu.offsetWidth  || 220;
  const mH = ctxMenu.offsetHeight || 190;
  let x = e.clientX + 4;
  let y = e.clientY + 4;
  if (x + mW > window.innerWidth)  x = e.clientX - mW - 4;
  if (y + mH > window.innerHeight) y = e.clientY - mH - 4;

  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.style.visibility = '';
}

function closeCtxMenu() {
  ctxMenu.classList.remove('open');
  ctxTargetId = null;
}

ctxMuteBtn.addEventListener('click', () => {
  if (!ctxTargetId) return;
  const state = getState(ctxTargetId);
  state.muted = !state.muted;
  const video = getRemoteVideo(ctxTargetId);
  if (video) video.muted = state.muted;
  const tile = document.getElementById(`tile-${ctxTargetId}`);
  if (tile) tile.classList.toggle('remote-muted', state.muted);
  showToast(state.muted ? 'Muted for you' : 'Unmuted');
  closeCtxMenu();
});

ctxHideBtn.addEventListener('click', () => {
  if (!ctxTargetId) return;
  const state = getState(ctxTargetId);
  state.hidden = !state.hidden;
  const tile = document.getElementById(`tile-${ctxTargetId}`);
  if (tile) tile.classList.toggle('remote-cam-hidden', state.hidden);
  showToast(state.hidden ? 'Camera hidden for you' : 'Camera shown');
  closeCtxMenu();
});

ctxVolumeSlider.addEventListener('input', () => {
  if (!ctxTargetId) return;
  const vol = parseInt(ctxVolumeSlider.value);
  ctxVolumeVal.textContent = vol + '%';
  const state = getState(ctxTargetId);
  state.volume = vol;
  const video = getRemoteVideo(ctxTargetId);
  if (video) video.volume = Math.min(vol / 100, 1); // clamp to 1 max for volume prop
  // For amplification >100%, use AudioContext gain
  if (vol > 100) amplifyAudio(ctxTargetId, vol / 100);
});

// Audio amplification (for >100% volume) using Web Audio API

function amplifyAudio(id, gain) {
  const video = getRemoteVideo(id);
  if (!video) return;
  if (!audioCtxMap[id]) {
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(video);
    const gainNode = audioCtx.createGain();
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    audioCtxMap[id] = { audioCtx, gainNode };
    video.muted = false; // ensure not muted
  }
  audioCtxMap[id].gainNode.gain.value = gain;
}

// Right-click delegation — only fires on remote tiles inside the grid
videoGrid.addEventListener('contextmenu', (e) => {
  // Walk up from click target to find a video-tile
  const tile = e.target.closest('.video-tile');
  if (!tile) return;                          // clicked empty grid space
  if (tile.id === 'tile-local') return;       // clicked own tile — ignore
  e.preventDefault();
  const id   = tile.id.replace('tile-', '');
  const name = tile.querySelector('.name-tag')?.textContent || id;
  openCtxMenu(e, id, name);
});

// Prevent browser context menu on the grid entirely
videoGrid.addEventListener('contextmenu', (e) => { e.preventDefault(); });

// Double-click / double-tap any tile → open fullscreen overlay
videoGrid.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.video-tile');
  if (!tile) return;
  const video = tile.querySelector('video');
  const src = video?.srcObject;
  if (!src) return;
  const label = tile.querySelector('.name-tag, .ss-tile-badge')?.textContent?.trim() || '';
  ssOverlayName.textContent = label;
  ssOverlayVideo.srcObject = src;
  ssOverlayVideo.play().catch(() => {});
  ssOverlay.classList.add('open');
});

// Close on click outside or Escape
document.addEventListener('click',   (e) => { if (!ctxMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCtxMenu(); ssOverlay.classList.remove('open'); ssOverlayVideo.srcObject = null; } });

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

// ── SCREEN SHARE ──
const shareBtn         = document.getElementById('share-btn');
const shareLabel       = document.getElementById('share-label');
const sharePopover     = document.getElementById('share-popover');
const shareAudioCb     = document.getElementById('share-audio-cb');
const shareStartBtn    = document.getElementById('share-start-btn');
const shareCancelBtn   = document.getElementById('share-cancel-btn');
const ssBanner         = document.getElementById('ss-banner');
const ssBannerText     = document.getElementById('ss-banner-text');
const ssViewBtn        = document.getElementById('ss-view-btn');
const ssDismissBtn     = document.getElementById('ss-dismiss-btn');
const ssOverlay        = document.getElementById('ss-overlay');
const ssOverlayVideo   = document.getElementById('ss-overlay-video');
const ssOverlayName    = document.getElementById('ss-overlay-name');
const ssOverlayClose   = document.getElementById('ss-overlay-close');
const stopShareBar     = document.getElementById('stop-share-bar');
const stopShareBarBtn  = document.getElementById('stop-share-bar-btn');

let screenStream    = null;
let isSharingScreen = false;
let currentSharerId = null;
const screenPeers   = {}; // dedicated peer connections for screen share

// ── SCREEN TILE HELPERS ──
function addScreenShareTile(id, label, stream) {
  removeScreenShareTile(id); // avoid duplicates
  const tile = document.createElement('div');
  tile.id    = `stile-${id}`;
  tile.className = 'video-tile screen-share-tile';
  tile.dataset.initials = '🖥';

  const video = document.createElement('video');
  video.autoplay   = true;
  video.playsInline = true;
  video.muted      = true;
  if (stream) video.srcObject = stream;

  const badge = document.createElement('div');
  badge.className = 'ss-tile-badge';
  badge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>${label}`;

  tile.appendChild(video);
  tile.appendChild(badge);
  videoGrid.appendChild(tile);
  requestAnimationFrame(() => relayout(videoGrid.children.length));
}

function removeScreenShareTile(id) {
  const tile = document.getElementById(`stile-${id}`);
  if (!tile) return;
  tile.classList.add('leaving');
  tile.addEventListener('animationend', () => {
    tile.remove();
    requestAnimationFrame(() => relayout(videoGrid.children.length));
  }, { once: true });
  setTimeout(() => {
    if (tile.parentNode) { tile.remove(); requestAnimationFrame(() => relayout(videoGrid.children.length)); }
  }, 350);
}

// ── SCREEN PEER CONNECTION ──
async function createScreenPeer(targetId, isInitiator, sharerName) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  screenPeers[targetId] = pc;

  if (isInitiator && screenStream) {
    screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
  }

  pc.ontrack = (e) => {
    const tile = document.getElementById(`stile-${targetId}`);
    if (tile && e.streams[0]) tile.querySelector('video').srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('screen-ice', targetId, e.candidate);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      delete screenPeers[targetId];
    }
  };

  if (isInitiator) {
    // Sharer side: just send the offer — stile-local already shows our screen
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('screen-offer', targetId, offer);
  }
  return pc;
}

// ── START SCREEN SHARE ──
shareBtn.addEventListener('click', () => {
  if (isSharingScreen) { stopScreenShare(); return; }
  sharePopover.classList.toggle('open');
});
shareCancelBtn.addEventListener('click', () => sharePopover.classList.remove('open'));
shareStartBtn.addEventListener('click', () => {
  sharePopover.classList.remove('open');
  startScreenShare(shareAudioCb.checked);
});
document.addEventListener('click', (e) => {
  if (!sharePopover.contains(e.target) && e.target !== shareBtn)
    sharePopover.classList.remove('open');
});

async function startScreenShare(withAudio) {
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) { showToast('Screen share needs HTTPS or localhost', 4000); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { showToast('Not supported in this browser'); return; }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, cursor: 'always' },
      audio: withAudio ? { echoCancellation: false, noiseSuppression: false } : false
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') showToast('Screen share failed');
    return;
  }

  const screenTrack = screenStream.getVideoTracks()[0];
  if ('contentHint' in screenTrack) screenTrack.contentHint = 'detail';
  isSharingScreen = true;

  // Add local preview tile (sharer sees their own screen in the grid)
  addScreenShareTile('local', 'Your Screen', screenStream);

  // Create screen peer connections with all existing participants
  for (const peerId of Object.keys(peers)) {
    await createScreenPeer(peerId, true, myName);
  }

  // Notify everyone
  socket.emit('screen-share-start', myName);

  // Show stop bar
  shareBtn.classList.add('sharing');
  shareLabel.textContent = 'Stop Share';
  stopShareBar.classList.add('open');
  showToast('You are now sharing your screen');

  screenTrack.addEventListener('ended', stopScreenShare);
}

// ── STOP SCREEN SHARE ──
stopShareBarBtn.addEventListener('click', stopScreenShare);

async function stopScreenShare() {
  if (!isSharingScreen) return;
  isSharingScreen = false;

  socket.emit('screen-share-stop');

  // Close all screen peer connections
  Object.values(screenPeers).forEach(pc => pc.close());
  for (const k in screenPeers) delete screenPeers[k];

  // Stop tracks
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;

  // Remove local screen tile
  removeScreenShareTile('local');

  shareBtn.classList.remove('sharing');
  shareLabel.textContent = 'Share';
  stopShareBar.classList.remove('open');
  showToast('Screen sharing stopped');
}

// ── RECEIVE SCREEN SHARE SOCKET EVENTS ──
socket.on('screen-share-started', (sharerId, sharerName) => {
  currentSharerId = sharerId;
  ssBannerText.textContent = `${sharerName} is sharing their screen`;
  ssBanner.classList.add('open');
  showToast(`${sharerName} started sharing`, 3000);
});

socket.on('screen-share-stopped', (sharerId, sharerName) => {
  // Close screen peer
  if (screenPeers[sharerId]) { screenPeers[sharerId].close(); delete screenPeers[sharerId]; }
  removeScreenShareTile(sharerId);
  closeScreenShareUI();
  showToast(`${sharerName} stopped sharing`);
});

// Dedicated screen share WebRTC
socket.on('screen-offer', async (fromId, offer, fromName) => {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  screenPeers[fromId] = pc;

  // Create the tile first (no stream yet — ontrack will set srcObject)
  addScreenShareTile(fromId, `${fromName || fromId}'s Screen`, null);

  pc.ontrack = (e) => {
    const tile = document.getElementById(`stile-${fromId}`);
    if (tile && e.streams[0]) tile.querySelector('video').srcObject = e.streams[0];
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('screen-ice', fromId, e.candidate);
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('screen-answer', fromId, answer);
});

socket.on('screen-answer', async (fromId, answer) => {
  if (screenPeers[fromId]) await screenPeers[fromId].setRemoteDescription(answer);
});

socket.on('screen-ice', async (fromId, candidate) => {
  if (screenPeers[fromId]) {
    try { await screenPeers[fromId].addIceCandidate(candidate); } catch (_) {}
  }
});

// When a new user joins while we are sharing, create a screen peer with them
socket.on('user-joined', (id, name) => {
  showToast(`${name} joined`);
  appendSystemMsg(`${name} joined the meeting`);
  if (isSharingScreen) {
    socket.emit('screen-share-notify-new', id, myName);
    setTimeout(() => createScreenPeer(id, true, myName), 800);
  }
});

function closeScreenShareUI() {
  currentSharerId = null;
  ssBanner.classList.remove('open');
  ssOverlay.classList.remove('open');
  ssOverlayVideo.srcObject = null;
}

ssViewBtn.addEventListener('click', () => {
  if (!currentSharerId) return;
  const tile = document.getElementById(`stile-${currentSharerId}`);
  if (!tile) return;
  const src = tile.querySelector('video')?.srcObject;
  if (!src) return;
  ssOverlayName.textContent = ssBannerText.textContent;
  ssOverlayVideo.srcObject = src;
  ssOverlayVideo.play().catch(() => {});
  ssOverlay.classList.add('open');
});

ssDismissBtn.addEventListener('click', () => ssBanner.classList.remove('open'));
ssOverlayClose.addEventListener('click', () => {
  ssOverlay.classList.remove('open');
  ssOverlayVideo.srcObject = null;
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
  requestAnimationFrame(() => relayout());
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
  // Notify room about screen share ending before disconnecting
  if (isSharingScreen) {
    isSharingScreen = false;
    socket.emit('screen-share-stop');
    Object.values(screenPeers).forEach(pc => pc.close());
  }
  if (filterAnimId) cancelAnimationFrame(filterAnimId);
  if (filterSourceVideo && filterSourceVideo.parentNode) filterSourceVideo.parentNode.removeChild(filterSourceVideo);
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
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
  pwHint.textContent = '';
  passwordInput.placeholder = 'Password (optional — leave blank for public)';
});

[nameInput, roomInput, passwordInput].forEach(el => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterMeeting(); });
});

roomInput.addEventListener('input', () => {
  roomInput.value = roomInput.value.toUpperCase();
});

// ── ROOMS BROWSER ──
function renderRooms(list) {
  if (list.length === 0) {
    roomsList.innerHTML = '<div class="rooms-empty">No active rooms yet.<br/>Be the first to start one!</div>';
    return;
  }

  roomsList.innerHTML = '';
  list.forEach(r => {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-card-icon">
        ${r.locked
          ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="18" height="18"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`
        }
      </div>
      <div class="room-card-info">
        <div class="room-card-code">${r.id}</div>
        <div class="room-card-meta">
          <span>👥 ${r.count} participant${r.count !== 1 ? 's' : ''}</span>
          ${r.locked ? '<span class="room-card-lock">🔒 Password required</span>' : ''}
        </div>
        ${r.names && r.names.length ? `<div class="room-card-names">${r.names.map(n => `<span class="room-card-avatar">${n.charAt(0).toUpperCase()}</span><span>${escapeHtml(n)}</span>`).join('<span class="room-card-sep">·</span>')}</div>` : ''}
      </div>
      <button class="room-card-join">Join</button>
    `;

    const doSelect = () => {
      roomInput.value = r.id;
      passwordInput.value = '';
      if (r.locked) {
        pwHint.textContent = '🔒 This room requires a password';
        pwHint.style.color = '#f59e0b';
        passwordInput.placeholder = 'Enter room password';
        passwordInput.focus();
      } else {
        pwHint.textContent = '';
        passwordInput.placeholder = 'Password (optional — leave blank for public)';
        if (!nameInput.value.trim()) nameInput.focus();
      }
    };

    card.addEventListener('click', doSelect);
    card.querySelector('.room-card-join').addEventListener('click', (e) => {
      e.stopPropagation();
      doSelect();
    });

    roomsList.appendChild(card);
  });
}

// If a rooms-list arrived before renderRooms was defined, apply it now
if (pendingRoomsList) { renderRooms(pendingRoomsList); pendingRoomsList = null; }

// ── CHAT ──
let chatOpen = false;
let unreadCount = 0;

function openChat() {
  chatOpen = true;
  chatPanel.classList.add('open');
  meetingScreen.classList.add('chat-open');
  chatBtn.classList.add('active');
  unreadCount = 0;
  chatBadge.classList.remove('show');
  chatBanner.classList.remove('open');
  requestAnimationFrame(() => relayout());
  setTimeout(() => chatInput.focus(), 260);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function closeChat() {
  chatOpen = false;
  chatPanel.classList.remove('open');
  meetingScreen.classList.remove('chat-open');
  chatBtn.classList.remove('active');
  requestAnimationFrame(() => relayout());
}

chatBtn.addEventListener('click', () => chatOpen ? closeChat() : openChat());
chatClose.addEventListener('click', closeChat);

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage({ from, name, text, ts }, isSelf) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSelf ? ' self' : '');
  div.innerHTML = `
    <div class="chat-msg-meta">
      <span class="chat-msg-name">${isSelf ? 'You' : escapeHtml(name)}</span>
      <span>${formatTime(ts)}</span>
    </div>
    <div class="chat-msg-bubble">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-system-msg';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  const ts = Date.now();
  socket.emit('chat-message', text);
  appendMessage({ from: 'local', name: myName, text, ts }, true);
  chatInput.value = '';
}

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});

socket.on('chat-message', (msg) => {
  appendMessage(msg, false);
  if (!chatOpen) {
    unreadCount++;
    chatBadge.classList.add('show');
    // Show banner with sender name + preview
    chatBannerText.textContent = `${msg.name}: ${msg.text.slice(0, 80)}${msg.text.length > 80 ? '…' : ''}`;
    chatBanner.classList.add('open');
  }
});

chatBannerOpen.addEventListener('click', () => {
  chatBanner.classList.remove('open');
  openChat();
});
chatBannerDismiss.addEventListener('click', () => chatBanner.classList.remove('open'));
