'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes.' },
});

/* Register — teachers use email, students may register with a numeric ID. */
router.post('/register', authLimiter, (req, res) => {
  const { role, full_name, email, student_id, password, institution } = req.body || {};
  if (!['teacher', 'student'].includes(role))
    return res.status(400).json({ error: 'Choose a valid role.' });
  if (!full_name || !password || password.length < 6)
    return res.status(400).json({ error: 'Name and a password of at least 6 characters are required.' });

  if (role === 'teacher' && !email)
    return res.status(400).json({ error: 'Teachers must register with an email.' });
  if (role === 'student' && !student_id)
    return res.status(400).json({ error: 'Students must register with a numeric student ID.' });
  if (role === 'student' && !/^\d+$/.test(String(student_id)))
    return res.status(400).json({ error: 'Student ID must contain digits only.' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db
      .prepare(
        `INSERT INTO users (role, full_name, email, student_id, password_hash, institution)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(role, full_name, email || null, role === 'student' ? String(student_id) : null, hash, institution || null);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE'))
      return res.status(409).json({ error: 'That email or student ID is already registered.' });
    res.status(500).json({ error: 'Could not create account.' });
  }
});

/* Login — identifier is email (teacher) or student_id (student). */
router.post('/login', authLimiter, (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password)
    return res.status(400).json({ error: 'Enter your email/ID and password.' });

  const user = db
    .prepare('SELECT * FROM users WHERE email = ? OR student_id = ?')
    .get(String(identifier), String(identifier));
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials.' });

  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: publicUser(user) });
});

function publicUser(u) {
  return {
    id: u.id,
    role: u.role,
    full_name: u.full_name,
    email: u.email,
    student_id: u.student_id,
    institution: u.institution,
  };
}

module.exports = router;
