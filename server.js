require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');

const authRoutes = require('./routes/auth');
const searchRoutes = require('./routes/search');
const uploadRoutes = require('./routes/upload');

const app = express();

// HTTP or HTTPS server
let server;
if (process.env.USE_HTTPS === 'true' && process.env.SSL_KEY && process.env.SSL_CERT) {
  const sslOptions = {
    key: fs.readFileSync(process.env.SSL_KEY),
    cert: fs.readFileSync(process.env.SSL_CERT)
  };
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dmh-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.USE_HTTPS === 'true' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Session store ────────────────────────────────────────────────────────────
// Map<sessionId, Session>
const sessions = new Map();
// Map<socketId, sessionId>
const socketToSession = new Map();

function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return 'DMH-' + code;
}

function sanitizeSession(session) {
  return {
    id: session.id,
    queue: session.queue,
    currentTrackIndex: session.currentTrackIndex,
    isPlaying: session.isPlaying,
    position: session.position,
    lastPositionUpdate: session.lastPositionUpdate,
    settings: session.settings,
    participants: Array.from(session.participants.values()),
    hostUsername: Array.from(session.participants.values()).find(p => p.isHost)?.username || 'Host'
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes(sessions));
app.use('/search', searchRoutes);
app.use('/upload', uploadRoutes(sessions));

// Expose session existence check
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    id: session.id,
    participantCount: session.participants.size,
    allowJoin: session.settings.allowJoin
  });
});

// QR code for joining a session
app.get('/api/session/:id/qr', async (req, res) => {
  const sess = sessions.get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'Session not found' });

  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const joinUrl = `${proto}://${host}/?code=${sess.id}`;

  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: { dark: '#f0eef8', light: '#0e0d14' }
    });
    res.json({ dataUrl, joinUrl });
  } catch (err) {
    console.error('[QR] Error:', err);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[DMH] Client connected:', socket.id);

  // ── Create Session ──────────────────────────────────────────────────────────
  socket.on('create_session', ({ username }) => {
    if (!username?.trim()) {
      return socket.emit('error', { message: 'Username required' });
    }
    const sessionId = generateSessionCode();
    const newSession = {
      id: sessionId,
      hostSocketId: socket.id,
      participants: new Map(),
      queue: [],
      currentTrackIndex: -1,
      isPlaying: false,
      position: 0,
      lastPositionUpdate: Date.now(),
      settings: {
        allowJoin: true,
        allowGuestAdd: true
      }
    };
    newSession.participants.set(socket.id, {
      username: username.trim(),
      isHost: true,
      socketId: socket.id
    });
    sessions.set(sessionId, newSession);
    socketToSession.set(socket.id, sessionId);
    socket.join(sessionId);
    socket.emit('session_created', { sessionId, state: sanitizeSession(newSession) });
    console.log(`[DMH] Session ${sessionId} created by ${username}`);
  });

  // ── Join Session ────────────────────────────────────────────────────────────
  socket.on('join_session', ({ sessionId, username }) => {
    const sess = sessions.get(sessionId?.toUpperCase());
    if (!sess) {
      return socket.emit('error', { message: 'Session not found. Check the code and try again.' });
    }
    if (!sess.settings.allowJoin && sess.hostSocketId !== socket.id) {
      return socket.emit('error', { message: 'Session is locked. No new participants allowed.' });
    }
    if (!username?.trim()) {
      return socket.emit('error', { message: 'Username required' });
    }
    sess.participants.set(socket.id, {
      username: username.trim(),
      isHost: false,
      socketId: socket.id
    });
    socketToSession.set(socket.id, sess.id);
    socket.join(sess.id);
    socket.emit('session_joined', { sessionId: sess.id, state: sanitizeSession(sess) });
    socket.to(sess.id).emit('participant_joined', {
      username: username.trim(),
      participants: Array.from(sess.participants.values())
    });
    console.log(`[DMH] ${username} joined session ${sess.id}`);
  });

  // ── Add to Queue ────────────────────────────────────────────────────────────
  socket.on('queue_add', ({ track }) => {
    const sess = getSession(socket.id);
    if (!sess) return;
    const participant = sess.participants.get(socket.id);
    if (!participant?.isHost && !sess.settings.allowGuestAdd) {
      return socket.emit('error', { message: 'Host has disabled adding songs for guests.' });
    }
    track.id = uuidv4();
    track.addedBy = participant?.username || 'Unknown';
    sess.queue.push(track);
    if (sess.currentTrackIndex === -1) {
      sess.currentTrackIndex = 0;
    }
    io.to(sess.id).emit('queue_updated', {
      queue: sess.queue,
      currentTrackIndex: sess.currentTrackIndex
    });
  });

  // ── Remove from Queue (host only) ───────────────────────────────────────────
  socket.on('queue_remove', ({ trackIndex }) => {
    const sess = getSession(socket.id);
    if (!sess || !isHost(socket.id, sess)) return;
    if (trackIndex < 0 || trackIndex >= sess.queue.length) return;

    sess.queue.splice(trackIndex, 1);

    if (sess.queue.length === 0) {
      sess.currentTrackIndex = -1;
      sess.isPlaying = false;
    } else if (trackIndex < sess.currentTrackIndex) {
      sess.currentTrackIndex--;
    } else if (trackIndex === sess.currentTrackIndex) {
      sess.isPlaying = false;
      if (sess.currentTrackIndex >= sess.queue.length) {
        sess.currentTrackIndex = sess.queue.length - 1;
      }
    }

    io.to(sess.id).emit('queue_updated', { queue: sess.queue, currentTrackIndex: sess.currentTrackIndex });
    io.to(sess.id).emit('playback_updated', {
      currentTrackIndex: sess.currentTrackIndex,
      isPlaying: sess.isPlaying,
      position: 0,
      timestamp: Date.now()
    });
  });

  // ── Reorder Queue (host only) ───────────────────────────────────────────────
  socket.on('queue_reorder', ({ fromIndex, toIndex }) => {
    const sess = getSession(socket.id);
    if (!sess || !isHost(socket.id, sess)) return;
    if (fromIndex < 0 || fromIndex >= sess.queue.length) return;
    if (toIndex < 0 || toIndex >= sess.queue.length) return;
    if (fromIndex === toIndex) return;

    const [moved] = sess.queue.splice(fromIndex, 1);
    sess.queue.splice(toIndex, 0, moved);

    // Adjust currentTrackIndex
    if (sess.currentTrackIndex === fromIndex) {
      sess.currentTrackIndex = toIndex;
    } else if (fromIndex < sess.currentTrackIndex && toIndex >= sess.currentTrackIndex) {
      sess.currentTrackIndex--;
    } else if (fromIndex > sess.currentTrackIndex && toIndex <= sess.currentTrackIndex) {
      sess.currentTrackIndex++;
    }

    io.to(sess.id).emit('queue_updated', { queue: sess.queue, currentTrackIndex: sess.currentTrackIndex });
  });

  // ── Playback Control (host only) ────────────────────────────────────────────
  socket.on('playback_control', ({ action, position }) => {
    const sess = getSession(socket.id);
    if (!sess || !isHost(socket.id, sess)) return;

    switch (action) {
      case 'play':
        sess.isPlaying = true;
        if (position !== undefined) sess.position = position;
        break;
      case 'pause':
        sess.isPlaying = false;
        if (position !== undefined) sess.position = position;
        break;
      case 'seek':
        sess.position = position || 0;
        break;
      case 'next':
        if (sess.currentTrackIndex < sess.queue.length - 1) {
          sess.currentTrackIndex++;
          sess.isPlaying = true;
          sess.position = 0;
        }
        break;
      case 'prev':
        if (sess.currentTrackIndex > 0) {
          sess.currentTrackIndex--;
          sess.isPlaying = true;
          sess.position = 0;
        }
        break;
    }
    sess.lastPositionUpdate = Date.now();
    io.to(sess.id).emit('playback_updated', {
      currentTrackIndex: sess.currentTrackIndex,
      isPlaying: sess.isPlaying,
      position: sess.position,
      timestamp: sess.lastPositionUpdate
    });
  });

  // ── Progress Sync (host → guests) ───────────────────────────────────────────
  socket.on('playback_progress', ({ position }) => {
    const sess = getSession(socket.id);
    if (!sess || !isHost(socket.id, sess)) return;
    sess.position = position;
    sess.lastPositionUpdate = Date.now();
    socket.to(sess.id).emit('playback_progress', {
      position,
      timestamp: sess.lastPositionUpdate
    });
  });

  // ── Track Ended (host reports) ──────────────────────────────────────────────
  socket.on('track_ended', () => {
    const sess = getSession(socket.id);
    if (!sess || !isHost(socket.id, sess)) return;

    if (sess.currentTrackIndex < sess.queue.length - 1) {
      sess.currentTrackIndex++;
      sess.isPlaying = true;
      sess.position = 0;
      sess.lastPositionUpdate = Date.now();
      io.to(sess.id).emit('playback_updated', {
        currentTrackIndex: sess.currentTrackIndex,
        isPlaying: true,
        position: 0,
        timestamp: sess.lastPositionUpdate
      });
    } else {
      sess.isPlaying = false;
      io.to(sess.id).emit('playback_updated', {
        currentTrackIndex: sess.currentTrackIndex,
        isPlaying: false,
        position: 0,
        timestamp: Date.now()
      });
    }
  });

  // ── Settings (host only) ────────────────────────────────────────────────────
  socket.on('settings_update', ({ allowJoin, allowGuestAdd }) => {
    const sess = getSession(socket.id);
    if (!sess || !isHost(socket.id, sess)) return;
    if (allowJoin !== undefined) sess.settings.allowJoin = !!allowJoin;
    if (allowGuestAdd !== undefined) sess.settings.allowGuestAdd = !!allowGuestAdd;
    io.to(sess.id).emit('settings_updated', { settings: sess.settings });
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const sessId = socketToSession.get(socket.id);
    if (sessId) {
      const sess = sessions.get(sessId);
      if (sess) {
        const participant = sess.participants.get(socket.id);
        sess.participants.delete(socket.id);
        socketToSession.delete(socket.id);

        if (sess.participants.size === 0) {
          sessions.delete(sessId);
          console.log(`[DMH] Session ${sessId} ended (empty)`);
        } else if (sess.hostSocketId === socket.id) {
          // Transfer host to next participant
          const [newHostSocketId, newHostData] = sess.participants.entries().next().value;
          sess.hostSocketId = newHostSocketId;
          newHostData.isHost = true;
          io.to(sessId).emit('host_transferred', {
            newHostUsername: newHostData.username,
            participants: Array.from(sess.participants.values())
          });
          console.log(`[DMH] Host transferred to ${newHostData.username} in ${sessId}`);
        } else {
          io.to(sessId).emit('participant_left', {
            username: participant?.username,
            participants: Array.from(sess.participants.values())
          });
        }
      }
    }
    console.log('[DMH] Client disconnected:', socket.id);
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function getSession(socketId) {
    const sessId = socketToSession.get(socketId);
    return sessId ? sessions.get(sessId) : null;
  }

  function isHost(socketId, sess) {
    return sess.hostSocketId === socketId;
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  const proto = process.env.USE_HTTPS === 'true' ? 'https' : 'http';
  console.log(`\n🔥 DemonicMusicHost running at ${proto}://localhost:${PORT}\n`);
});
