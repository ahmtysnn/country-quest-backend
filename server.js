const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// ============================================================================
// GAME DATA
// ============================================================================
const COUNTRIES_AND_CITIES = [
  {
    country: "Turkey",
    cities: ["Istanbul", "Ankara", "Izmir", "Antalya", "Bursa"],
    region: "Eurasia",
    population: "85M",
    currency: "Turkish Lira (₺)",
    language: "Turkish",
    fun_fact: "Home to the ancient city of Troy",
    iso_code: "TR",
    main_export: "Textiles & Automotive",
    flag: "🇹🇷"
  },
  {
    country: "France",
    cities: ["Paris", "Marseille", "Lyon", "Toulouse", "Nice"],
    region: "Western Europe",
    population: "67M",
    currency: "Euro (€)",
    language: "French",
    fun_fact: "Most visited country in the world",
    iso_code: "FR",
    main_export: "Aircraft & Machinery",
    flag: "🇫🇷"
  },
  {
    country: "Japan",
    cities: ["Tokyo", "Osaka", "Kyoto", "Yokohama", "Nagoya"],
    region: "East Asia",
    population: "125M",
    currency: "Japanese Yen (¥)",
    language: "Japanese",
    fun_fact: "Has over 6,800 islands",
    iso_code: "JP",
    main_export: "Vehicles & Electronics",
    flag: "🇯🇵"
  },
  {
    country: "Brazil",
    cities: ["São Paulo", "Rio de Janeiro", "Brasília", "Salvador", "Fortaleza"],
    region: "South America",
    population: "215M",
    currency: "Brazilian Real (R$)",
    language: "Portuguese",
    fun_fact: "Amazon rainforest covers 60% of the country",
    iso_code: "BR",
    main_export: "Soybeans & Iron Ore",
    flag: "🇧🇷"
  },
  {
    country: "Egypt",
    cities: ["Cairo", "Alexandria", "Giza", "Luxor", "Aswan"],
    region: "North Africa",
    population: "104M",
    currency: "Egyptian Pound (E£)",
    language: "Arabic",
    fun_fact: "Home to the Great Pyramids",
    iso_code: "EG",
    main_export: "Petroleum & Natural Gas",
    flag: "🇪🇬"
  },
  {
    country: "Australia",
    cities: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"],
    region: "Oceania",
    population: "26M",
    currency: "Australian Dollar (A$)",
    language: "English",
    fun_fact: "Has more kangaroos than people",
    iso_code: "AU",
    main_export: "Iron Ore & Coal",
    flag: "🇦🇺"
  },
  {
    country: "Germany",
    cities: ["Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne"],
    region: "Central Europe",
    population: "83M",
    currency: "Euro (€)",
    language: "German",
    fun_fact: "Invented the printing press and automobile",
    iso_code: "DE",
    main_export: "Vehicles & Machinery",
    flag: "🇩🇪"
  },
  {
    country: "Mexico",
    cities: ["Mexico City", "Guadalajara", "Monterrey", "Cancún", "Puebla"],
    region: "North America",
    population: "128M",
    currency: "Mexican Peso (MX$)",
    language: "Spanish",
    fun_fact: "Invented chocolate, corn and chilies",
    iso_code: "MX",
    main_export: "Vehicles & Electronics",
    flag: "🇲🇽"
  },
  {
    country: "India",
    cities: ["Mumbai", "Delhi", "Bangalore", "Kolkata", "Chennai"],
    region: "South Asia",
    population: "1.4B",
    currency: "Indian Rupee (₹)",
    language: "Hindi & English",
    fun_fact: "Birthplace of yoga and chess",
    iso_code: "IN",
    main_export: "Refined Petroleum & Gems",
    flag: "🇮🇳"
  },
  {
    country: "Canada",
    cities: ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa"],
    region: "North America",
    population: "39M",
    currency: "Canadian Dollar (C$)",
    language: "English & French",
    fun_fact: "Has the longest coastline in the world",
    iso_code: "CA",
    main_export: "Crude Petroleum & Cars",
    flag: "🇨🇦"
  }
];

const CLUE_SCHEDULE_KEYS = [
  'region',
  'main_export',
  'population',
  'currency',
  'language',
  'fun_fact',
  'cities',
  'flag'
];

const CLUE_DURATION = 15; // seconds per clue
const MAX_PLAYERS = 2;

// ============================================================================
// EXPRESS & SOCKET.IO SETUP
// ============================================================================
const app = express();
const PORT = process.env.PORT || 4000;

// Add these endpoints FIRST
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

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// ============================================================================
// GAME STATE MANAGEMENT
// ============================================================================
class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = []; // Array of socket IDs. Index 0 is Player 1 (Host)
    this.gameActive = false;
    this.scores = { p1: 0, p2: 0 };
    this.currentCountry = null;
    this.clueIndex = 0;
    this.timer = CLUE_DURATION;
    this.interval = null;
    this.createdAt = Date.now();
    this.readyPlayers = new Set(); // Track which socket IDs are ready
  }

  addPlayer(socketId) {
    if (this.players.length >= MAX_PLAYERS) return null;
    this.players.push(socketId);
    return this.players.length; // Returns 1 or 2
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
    
    // Clear ready status so they have to ready up again if they go back to lobby
    // (Though for 'Restart' we bypass this check)
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

  // JOIN ROOM
  socket.on('join_room', (roomId) => {
    if (!roomId) return;
    
    if (!rooms.has(roomId)) {
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
    socket.emit('player_assigned', playerNum);

    console.log(`👤 Player ${socket.id} joined ${roomId} as P${playerNum}`);

    if (room.players.length === MAX_PLAYERS) {
      io.to(roomId).emit('room_ready'); // Moves users to "Waiting" screen
    }
  });

  // TOGGLE READY (Lobby Phase)
  socket.on('toggle_ready', ({ roomId, isReady }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.setReady(socket.id, isReady);

    // Send updated statuses to everyone in room
    // Map socket IDs to P1/P2 ready booleans
    const p1Socket = room.players[0];
    const p2Socket = room.players[1];

    io.to(roomId).emit('ready_state_update', {
      p1: room.readyPlayers.has(p1Socket),
      p2: room.readyPlayers.has(p2Socket)
    });

    // Check if game should start
    if (room.areAllReady()) {
      console.log(`🚀 All players ready in ${roomId}. Starting game...`);
      startGameLoop(room);
    }
  });

  // RESTART GAME (Game Over Phase)
  socket.on('restart_game', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Only Player 1 (index 0) is allowed to restart
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

    // Notify clients game started
    io.to(room.roomId).emit('game_started', {
      countryData: room.currentCountry,
      clueIndex: room.clueIndex
    });

    // Timer Loop
    room.interval = setInterval(() => {
      if (!room.gameActive) {
        clearInterval(room.interval);
        return;
      }

      room.timer--;
      io.to(room.roomId).emit('timer_update', room.timer);

      if (room.timer <= 0) {
        // Move to next clue
        if (room.clueIndex < CLUE_SCHEDULE_KEYS.length - 1) {
          room.clueIndex++;
          room.timer = CLUE_DURATION;
          io.to(room.roomId).emit('next_clue', room.clueIndex);
        } else {
          // Game Over (Draw)
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
      // Correct!
      const winner = playerNum === 1 ? 'player1' : 'player2';
      if (winner === 'player1') room.scores.p1++;
      else room.scores.p2++;
      
      finishGame(room, winner);
    } else {
      // Incorrect - show bubble
      socket.to(roomId).emit('opponent_guess', guess);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        room.removePlayer(socket.id);
        
        // Notify clients to reset UI if someone leaves
        io.to(roomId).emit('player_left');
        
        // Broadcast new ready states (in case the ready person left)
        const p1Socket = room.players[0];
        const p2Socket = room.players[1]; // likely undefined now
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
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`✅ Socket.IO ready`);
});