const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = [socketId, ...]
const rooms = {};

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join-room', (roomId, userName) => {
    if (!rooms[roomId]) rooms[roomId] = [];

    const existingUsers = rooms[roomId].filter(id => id !== socket.id);

    rooms[roomId].push(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    // Tell this user about everyone already in the room
    socket.emit('existing-users', existingUsers);

    // Tell everyone else a new user joined
    socket.to(roomId).emit('user-joined', socket.id, userName);

    console.log(`${userName} (${socket.id}) joined room ${roomId}. Total: ${rooms[roomId].length}`);
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

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
      if (rooms[roomId].length === 0) delete rooms[roomId];
      socket.to(roomId).emit('user-left', socket.id, socket.userName);
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥 FaceMeet server running at http://localhost:${PORT}\n`);
});
