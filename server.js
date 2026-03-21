const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = { members: [socketId,...], password: null|string }
const rooms = {};
// savedPasswords[roomId] = password — persists even after room empties so the
// same code can't be hijacked if the original creator rejoins
const savedPasswords = {};

function buildRoomsList() {
  return Object.entries(rooms).map(([id, r]) => {
    const names = r.members
      .map(sid => { const s = io.sockets.sockets.get(sid); return s ? s.userName : null; })
      .filter(Boolean);
    return { id, count: r.members.length, locked: !!r.password, names };
  });
}

function broadcastRoomsList() {
  io.emit('rooms-list', buildRoomsList());
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Send current rooms on connect AND on explicit request
  socket.emit('rooms-list', buildRoomsList());
  socket.on('get-rooms', () => socket.emit('rooms-list', buildRoomsList()));

  socket.on('join-room', (roomId, userName, password) => {
    // Check saved password for this room code (persists even when room is empty)
    if (savedPasswords[roomId]) {
      if (savedPasswords[roomId] !== password) {
        socket.emit('join-error', 'Wrong password');
        return;
      }
    } else if (password) {
      // First person sets the password for this room code
      savedPasswords[roomId] = password;
    }

    if (!rooms[roomId]) {
      rooms[roomId] = { members: [], password: savedPasswords[roomId] || null };
    }

    const existingUsers = rooms[roomId].members
      .filter(id => id !== socket.id)
      .map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, name: s ? s.userName : id };
      });

    rooms[roomId].members.push(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    socket.emit('existing-users', existingUsers);
    socket.to(roomId).emit('user-joined', socket.id, userName);

    console.log(`${userName} (${socket.id}) joined room ${roomId}. Total: ${rooms[roomId].members.length}`);
    broadcastRoomsList();
  });

  // WebRTC signaling relay
  socket.on('offer', (targetId, offer) => {
    io.to(targetId).emit('offer', socket.id, offer, socket.userName);
  });

  socket.on('answer', (targetId, answer) => {
    io.to(targetId).emit('answer', socket.id, answer);
  });

  socket.on('ice-candidate', (targetId, candidate) => {
    io.to(targetId).emit('ice-candidate', socket.id, candidate);
  });

  // Chat message relay
  socket.on('chat-message', (text) => {
    if (!socket.roomId || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    const payload = { from: socket.id, name: socket.userName || 'Guest', text: clean, ts: Date.now() };
    socket.to(socket.roomId).emit('chat-message', payload);
  });

  // Mic state broadcast
  socket.on('mic-toggle', (isMuted) => {
    if (socket.roomId) socket.to(socket.roomId).emit('peer-mic-toggle', socket.id, isMuted);
  });

  // Screen share signaling
  socket.on('screen-share-start', (userName) => {
    if (socket.roomId) socket.to(socket.roomId).emit('screen-share-started', socket.id, userName);
  });
  socket.on('screen-share-stop', () => {
    if (socket.roomId) socket.to(socket.roomId).emit('screen-share-stopped', socket.id, socket.userName);
  });
  socket.on('screen-share-notify-new', (targetId, userName) => {
    io.to(targetId).emit('screen-share-started', socket.id, userName);
  });

  // Dedicated screen-share WebRTC relay
  socket.on('screen-offer', (targetId, offer) => {
    io.to(targetId).emit('screen-offer', socket.id, offer, socket.userName);
  });
  socket.on('screen-answer', (targetId, answer) => {
    io.to(targetId).emit('screen-answer', socket.id, answer);
  });
  socket.on('screen-ice', (targetId, candidate) => {
    io.to(targetId).emit('screen-ice', socket.id, candidate);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].members = rooms[roomId].members.filter(id => id !== socket.id);
      if (rooms[roomId].members.length === 0) {
        delete rooms[roomId];
        delete savedPasswords[roomId]; // room is gone, so its password is gone too
      }
      socket.to(roomId).emit('user-left', socket.id, socket.userName);
      broadcastRoomsList();
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥 FaceMeet server running at http://localhost:${PORT}\n`);
});
