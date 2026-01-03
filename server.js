const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { COUNTRIES_AND_CITIES } = require('./CountriesAndCities');

const MAX_PLAYERS = 2;

// ============================================================================
// EXPRESS & SOCKET.IO SETUP
// ============================================================================
const app = express();
const PORT = process.env.PORT || 4000;

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'Country Quest Backend API',
    status: 'running',
    socket: true,
    timestamp: new Date().toISOString()
  });
});

app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 30000,
  pingInterval: 25000
});

// ============================================================================
// GAME STATE MANAGEMENT
// ============================================================================
class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    // FIX: Use an object for fixed slots instead of an array
    this.players = { 1: null, 2: null }; 
    this.host = null; // FIX: Explicitly track the host socket ID
    
    this.gameActive = false;
    this.scores = { p1: 0, p2: 0 };
    this.currentCountry = null;
    this.clueIndex = 0;
    this.timer = null;
    this.interval = null;
    this.createdAt = Date.now();
    this.readyPlayers = new Set();
    this.settings = null;
    this.clueSchedule = [];
    this.maxRounds = null;
    this.currentRound = 1;
  }

  // FIX: Assign to specific empty slot (1 or 2)
  addPlayer(socketId) {
    if (this.players[1] && this.players[2]) return null; // Room full

    let assignedNum = null;
    if (!this.players[1]) {
      this.players[1] = socketId;
      assignedNum = 1;
    } else {
      this.players[2] = socketId;
      assignedNum = 2;
    }

    // Assign host if none exists
    if (!this.host) {
      this.host = socketId;
    }

    return assignedNum;
  }

  removePlayer(socketId) {
    let playerNumToRemove = null;
    if (this.players[1] === socketId) playerNumToRemove = 1;
    else if (this.players[2] === socketId) playerNumToRemove = 2;

    if (playerNumToRemove) {
      this.players[playerNumToRemove] = null;
      this.readyPlayers.delete(socketId);

      // FIX: Host migration logic
      if (this.host === socketId) {
        // If host left, assign host to the other player if they exist
        const otherPlayerNum = playerNumToRemove === 1 ? 2 : 1;
        if (this.players[otherPlayerNum]) {
          this.host = this.players[otherPlayerNum];
        } else {
          this.host = null;
        }
      }
    }
  }

  getPlayerCount() {
    return (this.players[1] ? 1 : 0) + (this.players[2] ? 1 : 0);
  }

  setReady(socketId, isReady) {
    if (isReady) this.readyPlayers.add(socketId);
    else this.readyPlayers.delete(socketId);
  }

  areAllReady() {
    // Check if both slots are filled AND both are ready
    return this.players[1] && this.players[2] && this.readyPlayers.size === 2;
  }

  setSettings(settings) {
    this.settings = settings;
    this.timer = settings.clueTime;
    
    const DEFAULT_CLUE_SCHEDULE = [
      { key: 'region', label: 'Region' },
      { key: 'main_export', label: 'Main Export' },
      { key: 'population', label: 'Population' },
      { key: 'currency', label: 'Currency' },
      { key: 'language', label: 'Language' },
      { key: 'fun_fact', label: 'Fun Fact' },
      { key: 'cities', label: 'Major Cities' },
      { key: 'flag', label: 'Flag' }
    ];
    
    this.clueSchedule = DEFAULT_CLUE_SCHEDULE
      .filter(clue => settings.enableClues[clue.key])
      .slice(0, settings.cluesPerRound);
  }

  getRandomCountry() {
    let filteredCountries = COUNTRIES_AND_CITIES;
    
    if (this.settings && this.settings.enabledContinents.length > 0) {
      if (!this.settings.enabledContinents.includes('All')) {
        filteredCountries = COUNTRIES_AND_CITIES.filter(country => 
          this.settings.enabledContinents.includes(country.region)
        );
      }
    }
    
    if (filteredCountries.length === 0) {
      filteredCountries = COUNTRIES_AND_CITIES;
    }
    
    const randomIndex = Math.floor(Math.random() * filteredCountries.length);
    return filteredCountries[randomIndex];
  }

  startNewRound() {
    this.currentCountry = this.getRandomCountry();
    this.clueIndex = 0;
    this.timer = this.settings.clueTime;
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
    if (room.getPlayerCount() === 0 && now - room.createdAt > 30 * 60 * 1000) {
      room.stopGame();
      rooms.delete(roomId);
    }
  }
}, 5 * 60 * 1000);

// ============================================================================
// SOCKET.IO LOGIC
// ============================================================================
io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);

  socket.emit('connection_confirmed', { socketId: socket.id });

  // JOIN ROOM
  socket.on('join_room', (roomId) => {
    if (!roomId) {
      socket.emit('error_message', 'Room ID is required');
      return;
    }
    
    try {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new GameRoom(roomId));
        console.log(`📦 Created room: ${roomId}`);
      }

      const room = rooms.get(roomId);

      if (room.getPlayerCount() >= MAX_PLAYERS) {
        socket.emit('error_message', 'Room is full!');
        return;
      }

      const playerNum = room.addPlayer(socket.id);
      socket.join(roomId);
      
      // FIX: Send correct host status based on stored host
      socket.emit('player_assigned', { 
        num: playerNum, 
        settings: room.settings,
        isHost: room.host === socket.id
      });

      console.log(`👤 Player ${socket.id} joined ${roomId} as P${playerNum}`);

      // Notify others that ready state might have changed (or player rejoined)
      const p1Socket = room.players[1];
      const p2Socket = room.players[2];
      io.to(roomId).emit('ready_state_update', {
        p1: p1Socket ? room.readyPlayers.has(p1Socket) : false,
        p2: p2Socket ? room.readyPlayers.has(p2Socket) : false
      });

      if (room.getPlayerCount() === MAX_PLAYERS) {
        io.to(roomId).emit('room_ready');
      }

    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error_message', 'Failed to join room');
    }
  });

  // SUBMIT SETTINGS (Host only)
  socket.on('submit_settings', ({ roomId, settings }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // FIX: Verify against the stored host ID
    if (room.host !== socket.id) {
      socket.emit('error_message', 'Only the host can set game settings');
      return;
    }

    if (!settings || !settings.enableClues || !settings.enabledContinents) {
      socket.emit('error_message', 'Invalid settings');
      return;
    }

    const enabledClueCount = Object.values(settings.enableClues).filter(Boolean).length;
    if (enabledClueCount < 1) { // Changed to 1 based on your frontend request
      socket.emit('error_message', 'Please select at least 1 clue');
      return;
    }

    if (settings.enabledContinents.length === 0) {
      socket.emit('error_message', 'Please select at least one continent');
      return;
    }

    room.setSettings(settings);
    console.log(`⚙️ Settings updated for room ${roomId}`);

    // Notify everyone
    io.to(roomId).emit('settings_updated', room.settings);
  });

  // TOGGLE READY
  socket.on('toggle_ready', ({ roomId, isReady }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.host === socket.id && !room.settings) {
      socket.emit('error_message', 'Please set game settings first');
      return;
    }

    room.setReady(socket.id, isReady);

    const p1Socket = room.players[1];
    const p2Socket = room.players[2];

    io.to(roomId).emit('ready_state_update', {
      p1: p1Socket ? room.readyPlayers.has(p1Socket) : false,
      p2: p2Socket ? room.readyPlayers.has(p2Socket) : false
    });

    if (room.areAllReady()) {
      console.log(`🚀 All players ready in ${roomId}. Starting game...`);
      startGameLoop(room);
    }
  });

  // RESTART GAME
  socket.on('restart_game', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.host !== socket.id) {
      socket.emit('error_message', "Only the Host can restart.");
      return;
    }

    console.log(`🔄 Host restarted game in ${roomId}`);
    startGameLoop(room);
  });

  function startGameLoop(room) {
    room.stopGame();
    room.startNewRound();

    io.to(room.roomId).emit('game_started', {
      countryData: room.currentCountry,
      clueIndex: room.clueIndex,
      settings: room.settings
    });

    room.interval = setInterval(() => {
      if (!room.gameActive) {
        clearInterval(room.interval);
        return;
      }

      room.timer--;
      io.to(room.roomId).emit('timer_update', room.timer);

      if (room.timer <= 0) {
        if (room.clueIndex < room.clueSchedule.length - 1) {
          room.clueIndex++;
          room.timer = room.settings.clueTime;
          io.to(room.roomId).emit('next_clue', room.clueIndex);
        } else {
          if (room.settings.maxRounds && room.currentRound >= room.settings.maxRounds) {
            finishGame(room, 'draw', true);
          } else {
            room.currentRound++;
            finishGame(room, 'draw');
          }
        }
      }
    }, 1000);
  }

  function finishGame(room, winner, finalGame = false) {
    room.stopGame();
    io.to(room.roomId).emit('game_over', {
      winner,
      correctCountry: room.currentCountry,
      scores: room.scores,
      finalGame
    });
  }

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

  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    for (const [roomId, room] of rooms.entries()) {
      // Check if this socket was P1 or P2
      if (room.players[1] === socket.id || room.players[2] === socket.id) {
        room.removePlayer(socket.id);
        
        // Notify frontend player left
        io.to(roomId).emit('player_left');
        
        // If Host migrated, we need to tell the remaining player they might be host now
        // The easiest way is to re-emit assignment info or just let them know via update
        if (room.players[1] || room.players[2]) {
           const remainingPlayerNum = room.players[1] ? 1 : 2;
           const remainingSocketId = room.players[remainingPlayerNum];
           
           // Inform the remaining player if they are now host
           if (room.host === remainingSocketId) {
             io.to(remainingSocketId).emit('host_migration', true);
           }
        }

        const p1Socket = room.players[1];
        const p2Socket = room.players[2];
        io.to(roomId).emit('ready_state_update', {
          p1: p1Socket ? room.readyPlayers.has(p1Socket) : false,
          p2: p2Socket ? room.readyPlayers.has(p2Socket) : false
        });

        if (room.getPlayerCount() === 0) {
          room.stopGame();
          rooms.delete(roomId);
        }
      }
    }
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});