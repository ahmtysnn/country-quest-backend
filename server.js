const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { COUNTRIES_AND_CITIES } = require('./CountriesAndCities');

const CLUE_DURATION = 15; // seconds per clue
const MAX_PLAYERS = 2;

// ============================================================================
// EXPRESS & SOCKET.IO SETUP
// ============================================================================
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'Country Quest Backend API', 
    status: 'running', 
    socket: true,
    mode: 'websocket-only'
  });
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io with HIGH PERFORMANCE settings
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all for smoother connectivity
    methods: ["GET", "POST"],
    credentials: true
  },
  // CRITICAL: Force WebSocket to avoid polling delays
  transports: ['websocket', 'polling'], 
  // Detect disconnects quickly (default is too slow)
  pingTimeout: 10000, 
  pingInterval: 10000,
  // Helper for mobile/bad connections
  connectionStateRecovery: {
    // the backup duration of the sessions and the packets
    maxDisconnectionDuration: 2 * 60 * 1000,
    // whether to skip middlewares upon successful recovery
    skipMiddlewares: true,
  }
});

// ============================================================================
// GAME STATE MANAGEMENT
// ============================================================================
class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = []; 
    this.gameActive = false;
    this.scores = { p1: 0, p2: 0 };
    this.currentCountry = null;
    this.clueIndex = 0;
    this.timer = CLUE_DURATION;
    this.interval = null;
    this.createdAt = Date.now();
    this.readyPlayers = new Set();
  }

  addPlayer(socketId) {
    if (this.players.length >= MAX_PLAYERS) return null;
    this.players.push(socketId);
    return this.players.length; 
  }

  removePlayer(socketId) {
    const index = this.players.indexOf(socketId);
    if (index > -1) {
      this.players.splice(index, 1);
    }
    this.readyPlayers.delete(socketId);
    return this.players.length;
  }

  setReady(socketId, isReady) {
    if (isReady) this.readyPlayers.add(socketId);
    else this.readyPlayers.delete(socketId);
  }

  areAllReady() {
    return this.players.length === MAX_PLAYERS && this.readyPlayers.size === MAX_PLAYERS;
  }

  startNewRound() {
    const randomIndex = Math.floor(Math.random() * COUNTRIES_AND_CITIES.length);
    this.currentCountry = COUNTRIES_AND_CITIES[randomIndex];
    this.clueIndex = 0;
    this.timer = CLUE_DURATION;
    this.gameActive = true;
    this.readyPlayers.clear();
  }

  stopGame() {
    this.gameActive = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

const rooms = new Map();

// Cleanup interval
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.players.length === 0 && now - room.createdAt > 30 * 60 * 1000) {
      room.stopGame();
      rooms.delete(roomId);
    }
  }
}, 5 * 60 * 1000);

// ============================================================================
// SOCKET.IO LOGIC
// ============================================================================
io.on('connection', (socket) => {
  console.log(`⚡ Fast Connect: ${socket.id}`);

  // JOIN ROOM
  socket.on('join_room', (roomId) => {
    if (!roomId) return;
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new GameRoom(roomId));
      console.log(`📦 Created room: ${roomId}`);
    }

    const room = rooms.get(roomId);

    // If player is already in this room (reconnection logic), don't add them again
    if (room.players.includes(socket.id)) {
        socket.emit('player_assigned', room.players.indexOf(socket.id) + 1);
        return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('error_message', 'Room is full!');
      return;
    }

    const playerNum = room.addPlayer(socket.id);
    socket.join(roomId);
    socket.emit('player_assigned', playerNum);

    console.log(`👤 Player ${socket.id} joined ${roomId} as P${playerNum}`);

    if (room.players.length === MAX_PLAYERS) {
      io.to(roomId).emit('room_ready'); 
    }
  });

  // TOGGLE READY 
  socket.on('toggle_ready', ({ roomId, isReady }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.setReady(socket.id, isReady);

    const p1Socket = room.players[0];
    const p2Socket = room.players[1];

    io.to(roomId).emit('ready_state_update', {
      p1: room.readyPlayers.has(p1Socket),
      p2: room.readyPlayers.has(p2Socket)
    });

    if (room.areAllReady()) {
      startGameLoop(room);
    }
  });

  // RESTART GAME 
  socket.on('restart_game', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.players[0] !== socket.id) {
        socket.emit('error_message', "Only the Host (Player 1) can restart.");
        return;
    }
    startGameLoop(room);
  });

  // GAME LOOP HELPER
  function startGameLoop(room) {
    room.stopGame();
    room.startNewRound();

    io.to(room.roomId).emit('game_started', {
      countryData: room.currentCountry,
      clueIndex: room.clueIndex
    });

    room.interval = setInterval(() => {
      if (!room.gameActive) {
        clearInterval(room.interval);
        return;
      }

      room.timer--;
      io.to(room.roomId).emit('timer_update', room.timer);

      if (room.timer <= 0) {
        if (room.clueIndex < 7) { // Hardcoded 7 based on frontend length
          room.clueIndex++;
          room.timer = CLUE_DURATION;
          io.to(room.roomId).emit('next_clue', room.clueIndex);
        } else {
          finishGame(room, 'draw');
        }
      }
    }, 1000);
  }

  // FINISH GAME HELPER
  function finishGame(room, winner) {
    room.stopGame();
    io.to(room.roomId).emit('game_over', {
      winner,
      correctCountry: room.currentCountry,
      scores: room.scores
    });
  }

  // GUESS HANDLING
  socket.on('send_guess', ({ roomId, guess, playerNum }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameActive) return;

    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalize(room.currentCountry.country);
    const attempt = normalize(guess);

    if (attempt === target) {
      const winner = playerNum === 1 ? 'player1' : 'player2';
      if (winner === 'player1') room.scores.p1++;
      else room.scores.p2++;
      
      finishGame(room, winner);
    } else {
      socket.to(roomId).emit('opponent_guess', guess);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        room.removePlayer(socket.id);
        
        io.to(roomId).emit('player_left');
        
        const p1Socket = room.players[0];
        
        io.to(roomId).emit('ready_state_update', {
            p1: p1Socket ? room.readyPlayers.has(p1Socket) : false,
            p2: false
        });

        if (room.players.length === 0) {
          room.stopGame();
          rooms.delete(roomId);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});