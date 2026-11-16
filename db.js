'use strict';

/**
 * Database layer for QuizArena.
 * Uses better-sqlite3 (synchronous, fast, zero-config, file-backed).
 * The DB file lives at DATA_DIR/quizarena.db so it can be mounted on a
 * persistent disk in production (see render.yaml / Dockerfile).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'quizarena.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('teacher','student','admin')),
  full_name     TEXT NOT NULL,
  email         TEXT UNIQUE,                 -- teachers/admins log in with email
  student_id    TEXT UNIQUE,                 -- students identified by numeric ID
  password_hash TEXT NOT NULL,
  institution   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fields (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT,
  blurb      TEXT,
  category   TEXT DEFAULT 'General',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL  -- null = built-in subject
);

CREATE TABLE IF NOT EXISTS quizzes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_id       INTEGER REFERENCES fields(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  mode           TEXT NOT NULL DEFAULT 'practice' CHECK (mode IN ('practice','live')),
  duration_min   INTEGER NOT NULL DEFAULT 20,     -- total time limit in minutes
  shuffle_q      INTEGER NOT NULL DEFAULT 1,      -- shuffle questions
  shuffle_opts   INTEGER NOT NULL DEFAULT 1,      -- shuffle MCQ options
  max_violations INTEGER NOT NULL DEFAULT 0,      -- focus losses tolerated before auto-F (0 = zero tolerance)
  fail_on_violation INTEGER NOT NULL DEFAULT 1,   -- if 1, a violation ends the exam with F
  pass_pct       INTEGER NOT NULL DEFAULT 50,
  published      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  type        TEXT NOT NULL CHECK (type IN ('mcq','detailed')),
  prompt      TEXT NOT NULL,
  options     TEXT,        -- JSON array of strings (mcq only)
  correct     TEXT,        -- JSON: index for mcq, or model answer/keywords for detailed
  points      INTEGER NOT NULL DEFAULT 1
);

/* A "session" is a scheduled run of a LIVE quiz that students join. */
CREATE TABLE IF NOT EXISTS live_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  host_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  join_code   TEXT UNIQUE NOT NULL,            -- students type this to join
  status      TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','running','ended')),
  started_at  TEXT,
  ended_at    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* An "attempt" is one student's run of a quiz (practice OR one live session). */
CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id       INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  session_id    INTEGER REFERENCES live_sessions(id) ON DELETE CASCADE,  -- null for practice
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,          -- null if joined by ID only
  student_id    TEXT,                          -- the numeric ID they joined with
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','flagged','graded')),
  violations    INTEGER NOT NULL DEFAULT 0,
  score         REAL,
  max_score     REAL,
  grade         TEXT,                          -- letter grade or 'F' when flagged
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at  TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id   INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  response     TEXT,        -- JSON: chosen index (mcq) or text (detailed)
  is_correct   INTEGER,     -- 1/0/null(ungraded)
  awarded      REAL DEFAULT 0,
  UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);
`);

/* Lightweight migrations for databases created before these columns existed. */
function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
addColumnIfMissing('fields', 'category', "TEXT DEFAULT 'General'");
addColumnIfMissing('fields', 'created_by', 'INTEGER');

/* ------------------------------------------------------------------ */
/* Seed data: CS fields + a demo teacher + a sample quiz               */
/* ------------------------------------------------------------------ */

// [slug, name, icon, blurb, category] — any discipline, not just computer science.
const FIELDS = [
  // Computer Science
  ['algorithms', 'Algorithms & Data Structures', '🧩', 'Sorting, graphs, complexity, recursion.', 'Computer Science'],
  ['ai-ml', 'Artificial Intelligence & ML', '🤖', 'Learning, neural nets, model training.', 'Computer Science'],
  ['cybersecurity', 'Cybersecurity', '🔐', 'Cryptography, attacks, defense, network security.', 'Computer Science'],
  ['databases', 'Databases (DBMS)', '🗄️', 'SQL, normalization, transactions, indexing.', 'Computer Science'],
  ['networking', 'Computer Networking', '🌐', 'TCP/IP, routing, HTTP, the OSI model.', 'Computer Science'],
  ['web', 'Web Application Development', '🕸️', 'HTTP, REST, front-end, back-end, sessions.', 'Computer Science'],
  // Mathematics
  ['calculus', 'Calculus', '∫', 'Limits, derivatives, integrals, series.', 'Mathematics'],
  ['linear-algebra', 'Linear Algebra', '➗', 'Vectors, matrices, eigenvalues, transforms.', 'Mathematics'],
  ['statistics', 'Statistics & Probability', '📊', 'Distributions, inference, hypothesis testing.', 'Mathematics'],
  // Natural Sciences
  ['physics', 'Physics', '🔭', 'Mechanics, electricity, waves, thermodynamics.', 'Natural Sciences'],
  ['chemistry', 'Chemistry', '⚗️', 'Atoms, bonding, reactions, organic chemistry.', 'Natural Sciences'],
  ['biology', 'Biology', '🧬', 'Cells, genetics, ecology, physiology.', 'Natural Sciences'],
  // Engineering
  ['robotics', 'Robotics', '🦾', 'Control, kinematics, sensors, actuation.', 'Engineering'],
  ['electronics', 'Electronics', '🔌', 'Circuits, signals, microcontrollers.', 'Engineering'],
  // Business & Economics
  ['economics', 'Economics', '📈', 'Micro, macro, markets, policy.', 'Business & Economics'],
  ['accounting', 'Accounting & Finance', '💰', 'Statements, ratios, budgeting, valuation.', 'Business & Economics'],
  ['management', 'Management & Marketing', '📋', 'Strategy, operations, marketing, HR.', 'Business & Economics'],
  // Humanities & Social Sciences
  ['history', 'History', '🏛️', 'Eras, events, causes and consequences.', 'Humanities'],
  ['geography', 'Geography', '🗺️', 'Physical, human and economic geography.', 'Humanities'],
  ['psychology', 'Psychology', '🧠', 'Cognition, behavior, development, disorders.', 'Social Sciences'],
  ['law', 'Law', '⚖️', 'Principles, rights, contracts, procedure.', 'Social Sciences'],
  // Languages
  ['english', 'English', '📖', 'Grammar, comprehension, writing, literature.', 'Languages'],
  ['general-knowledge', 'General Knowledge', '💡', 'Mixed topics for any course or quiz.', 'General'],
];

const insertField = db.prepare(
  `INSERT OR IGNORE INTO fields (slug, name, icon, blurb, category) VALUES (?, ?, ?, ?, ?)`
);
const seedFields = db.transaction(() => {
  for (const f of FIELDS) insertField.run(...f);
});
seedFields();

function ensureDemoData() {
  const demoEmail = 'teacher@demo.edu';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(demoEmail);
  if (existing) return;

  const hash = bcrypt.hashSync('demo1234', 10);
  const teacher = db
    .prepare(
      `INSERT INTO users (role, full_name, email, password_hash, institution)
       VALUES ('teacher', ?, ?, ?, ?)`
    )
    .run('Demo Instructor', demoEmail, hash, 'Kyungdong University');
  const teacherId = teacher.lastInsertRowid;

  // demo student account (optional — students can also join live by ID only)
  const sHash = bcrypt.hashSync('demo1234', 10);
  db.prepare(
    `INSERT OR IGNORE INTO users (role, full_name, student_id, password_hash, institution)
     VALUES ('student', ?, ?, ?, ?)`
  ).run('Demo Student', '2417260', sHash, 'Kyungdong University');

  const webField = db.prepare('SELECT id FROM fields WHERE slug = ?').get('web');

  const quiz = db
    .prepare(
      `INSERT INTO quizzes (owner_id, field_id, title, description, mode, duration_min,
        shuffle_q, shuffle_opts, max_violations, fail_on_violation, pass_pct, published)
       VALUES (?, ?, ?, ?, 'live', 15, 1, 1, 0, 1, 50, 1)`
    )
    .run(
      teacherId,
      webField.id,
      'Web & Networking Fundamentals',
      'A sample proctored quiz covering HTTP, REST and the basics of computer networking.'
    );
  const quizId = quiz.lastInsertRowid;

  const q = db.prepare(
    `INSERT INTO questions (quiz_id, ordinal, type, prompt, options, correct, points)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  q.run(quizId, 1, 'mcq', 'Which HTTP method is idempotent and used to retrieve a resource?',
    JSON.stringify(['POST', 'GET', 'PATCH', 'CONNECT']), JSON.stringify(1), 1);
  q.run(quizId, 2, 'mcq', 'Which layer of the OSI model does TCP operate at?',
    JSON.stringify(['Network', 'Transport', 'Session', 'Data Link']), JSON.stringify(1), 1);
  q.run(quizId, 3, 'mcq', 'What status code means "Not Found"?',
    JSON.stringify(['200', '301', '404', '500']), JSON.stringify(2), 1);
  q.run(quizId, 4, 'detailed',
    'In two or three sentences, explain the difference between TCP and UDP and give one use case for each.',
    null, JSON.stringify({ keywords: ['reliable', 'connection', 'ordered', 'connectionless', 'faster', 'stream', 'datagram'] }), 3);

  console.log('[db] Seeded demo teacher (teacher@demo.edu / demo1234) and sample live quiz.');
}
ensureDemoData();

module.exports = db;
