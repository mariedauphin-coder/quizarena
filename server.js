'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { attachUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quizzes');
const attachLive = require('./realtime/live');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const PORT = process.env.PORT || 3000;

/* Security headers. CSP is relaxed just enough to allow the Socket.IO client
   and inline bootstrap; tighten further behind your own CDN if you wish. */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(attachUser);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizRoutes);

// static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA-ish fallback for clean routes (serves index which routes client-side)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

attachLive(io);

server.listen(PORT, () => {
  console.log(`\n  QuizArena running on http://localhost:${PORT}`);
  console.log(`  Demo teacher:  teacher@demo.edu / demo1234\n`);
});

module.exports = { app, server };
