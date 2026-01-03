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

// Health check endpoints
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

// Optimized Socket.io configuration
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'], // Allow both but prefer websocket
  allowUpgrades: true,
  pingTimeout: 30000,
  pingInterval: 25000,
  connectTimeout: 10000,
  maxHttpBufferSize: 1e6,
  allowEIO3: true
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
    this.timer = null;
    this.interval = null;
    this.createdAt = Date.now();
    this.readyPlayers = new Set();
    this.settings = null;
    this.clueSchedule = [];
    this.maxRounds = null;
    this.currentRound = 1;
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

  setSettings(settings) {
    this.settings = settings;
    this.timer = settings.clueTime;
    
    // Build clue schedule based on enabled clues
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
    // Filter countries by enabled continents
    let filteredCountries = COUNTRIES_AND_CITIES;
    
    if (this.settings && this.settings.enabledContinents.length > 0) {
      // If "All" is not selected, filter by specific continents
      if (!this.settings.enabledContinents.includes('All')) {
        filteredCountries = COUNTRIES_AND_CITIES.filter(country => 
          this.settings.enabledContinents.includes(country.region)
        );
      }
    }
    
    // Ensure we have countries after filtering
    if (filteredCountries.length === 0) {
      filteredCountries = COUNTRIES_AND_CITIES; // Fallback to all countries
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
  console.log(`✅ Player connected: ${socket.id}`);

  // Send immediate confirmation
  socket.emit('connection_confirmed', { socketId: socket.id });

  // JOIN ROOM
  socket.on('join_room', (roomId) => {
    if (!roomId) {
      socket.emit('error_message', 'Room ID is required');
      return;
    }
    
    try {
      const isNewRoom = !rooms.has(roomId);
      if (isNewRoom) {
        rooms.set(roomId, new GameRoom(roomId));
        console.log(`📦 Created room: ${roomId}`);
      }

      const room = rooms.get(roomId);

      if (room.players.length >= MAX_PLAYERS) {
        socket.emit('error_message', 'Room is full!');
        return;
      }

      const playerNum = room.addPlayer(socket.id);
      socket.join(roomId);
      
      // Send player assignment with settings if they exist
      socket.emit('player_assigned', { 
        num: playerNum, 
        settings: room.settings,
        isHost: playerNum === 1 && isNewRoom
      });
      console.log(`👤 Player ${socket.id} joined ${roomId} as P${playerNum}`);

      if (room.players.length === MAX_PLAYERS) {
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
    if (!room) {
      socket.emit('error_message', 'Room not found');
      return;
    }

    // Only host (player 1) can submit settings
    if (room.players[0] !== socket.id) {
      socket.emit('error_message', 'Only the host can set game settings');
      return;
    }

    // Validate settings
    if (!settings || !settings.enableClues || !settings.enabledContinents) {
      socket.emit('error_message', 'Invalid settings');
      return;
    }

    // Validate at least 3 clues are enabled
    const enabledClueCount = Object.values(settings.enableClues).filter(Boolean).length;
    if (enabledClueCount < 3) {
      socket.emit('error_message', 'Please select at least 3 clues');
      return;
    }

    // Validate at least one continent is selected
    if (settings.enabledContinents.length === 0) {
      socket.emit('error_message', 'Please select at least one continent');
      return;
    }

    // Set the settings
    room.setSettings(settings);
    console.log(`⚙️ Settings updated for room ${roomId}`);

    // Notify both players about settings
    io.to(roomId).emit('player_assigned', { 
      num: 2, 
      settings: room.settings,
      isHost: false
    });
  });

  // TOGGLE READY
  socket.on('toggle_ready', ({ roomId, isReady }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error_message', 'Room not found');
      return;
    }

    // Check if settings are set before allowing ready
    if (room.players[0] === socket.id && !room.settings) {
      socket.emit('error_message', 'Please set game settings first');
      return;
    }

    room.setReady(socket.id, isReady);

    const p1Socket = room.players[0];
    const p2Socket = room.players[1];

    io.to(roomId).emit('ready_state_update', {
      p1: room.readyPlayers.has(p1Socket),
      p2: room.readyPlayers.has(p2Socket)
    });

    if (room.areAllReady()) {
      console.log(`🚀 All players ready in ${roomId}. Starting game...`);
      startGameLoop(room);
    }
  });

  // RESTART GAME
  socket.on('restart_game', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error_message', 'Room not found');
      return;
    }

    if (room.players[0] !== socket.id) {
      socket.emit('error_message', "Only the Host (Player 1) can restart.");
      return;
    }

    console.log(`🔄 Host restarted game in ${roomId}`);
    startGameLoop(room);
  });

  // GAME LOOP HELPER
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
          // Check if max rounds reached
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

  // FINISH GAME HELPER
  function finishGame(room, winner, finalGame = false) {
    room.stopGame();
    io.to(room.roomId).emit('game_over', {
      winner,
      correctCountry: room.currentCountry,
      scores: room.scores,
      finalGame
    });
    
    if (finalGame) {
      console.log(`🏁 Final game completed in ${room.roomId}`);
    }
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
        const p2Socket = room.players[1];
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

  // Heartbeat for connection health
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`✅ Socket.IO ready`);
});