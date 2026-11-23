# QuizArena — Proctored Online Quiz System

A deployable web platform for any course or subject, with two modes:

- **Practice** — students browse subjects (computer science, maths, sciences, business, humanities, languages, or ones the teacher adds) and take self-paced quizzes with instant scoring.
- **Live proctored exam** — students join a room with their **numeric student ID**, wait in a lobby, and sit a **locked-down** exam. Leaving fullscreen, switching tabs, or shrinking the window is detected instantly, flags the student, ends the exam, and records an automatic **F**.

Built with Node.js + Express + Socket.IO + SQLite. No build step, no external database to provision — it runs anywhere Node runs and deploys in minutes.

---

## ⚠️ Read this first: what browser-based proctoring can and cannot do

You asked for the exam to **prevent** opening another window or shrinking the screen. An important, honest limitation:

> A website running in a normal browser **cannot forcibly block** alt-tab, a new window, or a screen resize. No website can — the browser sandbox does not allow a page to override the operating system. This is true of every web-based exam tool.

What QuizArena does instead is what real platforms (Google Forms locked mode, Canvas, etc.) do: it **detects the action the instant it happens and reacts** — flag the student, stop the exam, record an F, and notify the teacher live. That matches your rule *"once that happens, flag the student, stop his exam and give him an F."*

**True prevention** (physically blocking other apps) only exists in a **native lockdown browser** — a small desktop app the student installs, like Respondus LockDown Browser or Safe Exam Browser. If a university requires that level, the upgrade path is:

1. Ship QuizArena as-is (detect-and-fail). This is enough for most coursework.
2. For high-stakes exams, wrap the exam URL in [Safe Exam Browser](https://safeexambrowser.org) (free, open-source) or build a thin Electron kiosk app. QuizArena already emits the violation events those shells rely on, so no server changes are needed.

The detection built in today covers two tiers:

- **Auto-fail violations** — exiting fullscreen, tab/window switching (`visibilitychange`), window losing focus (`blur`), and window resize/shrink. Under the default rules these end the exam immediately with an F and notify the teacher.
- **Teacher-confirmed violations** — **copy, cut and paste are disabled entirely** (menu, right-click, or Ctrl/Cmd+C/X/V are all blocked). Each attempt flags the student and appears in the teacher's console under **"Flags awaiting your decision"**, where the teacher clicks **Confirm F** or **Dismiss**. The card shows a **live count of attempts** with a hint ("1 attempt — could be accidental" → "repeated, likely deliberate") so the teacher can judge intent. The student keeps working until the teacher decides; a confirmed F ends their exam, a dismissal lets them continue.

Right-click and other keyboard shortcut combos (Ctrl/Cmd/Alt, F5/F11/F12) are swallowed.

---

## Features

**Accounts & roles**
- Register/login. Teachers use **email**; students use a **digits-only student ID**.
- Passwords hashed with bcrypt; sessions via signed, HttpOnly JWT cookies.

**Student dashboard**
- 10 computer-science fields (Algorithms, AI/ML, Computer Vision, Cybersecurity, DBMS, Networking, Web, OS, Robotics, Programming Languages).
- Practice quizzes per field with instant scoring.

**Teacher console**
- Create quizzes; add **MCQ** and **written/detailed** questions.
- Set the rules: duration, pass mark, shuffle questions/options, **violations allowed before auto-F**, and whether a violation fails the student.
- Publish practice quizzes; host live sessions.

**Live proctored exam**
- Teacher starts a session → gets a 6-character **join code**.
- Students join by student ID and wait in a **live lobby**; the teacher sees the roster fill in real time.
- Teacher clicks **Start** → the lobby closes (no late joins) and every student's screen locks to fullscreen.
- **Keyboard rules exactly as specified:**
  - **MCQ questions:** only **Enter** and **arrow keys** work. Arrows move the highlight; Enter selects and advances. All other keys are blocked.
  - **Written questions:** the keyboard works normally — letters, digits and symbols — with no special action.
- Violations stream to the teacher's console live; auto-failed students turn red on the roster.
- Instant grading: MCQs auto-scored; written answers get a provisional keyword score and are **flagged for teacher review** (teacher can override any score).

---

## AI question generator

Teachers can have AI draft questions instead of writing them: in the quiz editor, open **Generate questions with AI**, give a subject, topic, number, type and difficulty, then tick the questions to keep. Nothing is saved until the teacher adds it, and AI-written questions and answers should always be checked before an exam.

The feature is off until the server has an API key:

- `AI_API_KEY` — an Anthropic API key (create one at console.anthropic.com; usage is billed to that account).
- `AI_MODEL` — optional, defaults to `claude-haiku-4-5-20251001`.

On Render: service -> **Environment** -> add `AI_API_KEY` -> save (it redeploys). Locally: put it in a `.env` file. Never commit the key to GitHub.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Demo teacher account is seeded automatically:

- **teacher@demo.edu** / ********* — owns a sample live quiz ("Web & Networking Fundamentals").
- A demo student ID **2417260** / **demo1234** also exists, though students can join live exams by ID without an account.

Run the automated end-to-end test suite:

```bash
npm test
```

---

## Deploy to a real `www` website

You need two things: a **host** to run the app and a **domain** to point at it.

### Option A — Render (easiest, has a free tier)

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New +** → **Blueprint** → select your repo. The included `render.yaml` configures everything (build, start, health check, a generated `JWT_SECRET`, and a 1 GB persistent disk for the database).
3. Deploy. You'll get a live URL like `https://quizarena.onrender.com`.
4. **Custom domain:** in the Render service → **Settings → Custom Domains**, add `www.yourschool-quizzes.com`. Render shows you the DNS records (a `CNAME`) to paste into your domain registrar. HTTPS is automatic.

### Option B — Docker (any VPS, Railway, Fly.io, etc.)

```bash
docker build -t quizarena .
docker run -d -p 80:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  -v quizarena-data:/var/data \
  quizarena
```

The `-v quizarena-data:/var/data` volume keeps the database across restarts.

### Option C — Plain VPS (Ubuntu)

```bash
sudo apt install -y nodejs npm
git clone <your-repo> && cd quiz-system
cp .env.example .env      # then edit JWT_SECRET and DATA_DIR
npm install --omit=dev
npm start                 # use pm2 or systemd to keep it running
```

Put Nginx or Caddy in front for HTTPS, or run behind Cloudflare.

### Getting a domain

Buy one at Namecheap, Cloudflare, GoDaddy, Porkbun, etc. (~$10/yr). Then point it at your host using the DNS records the host gives you (a `CNAME` for `www`, or an `A` record to a VPS IP). The `www` prefix is just a DNS record on your domain — nothing special in the app.

---

## Production checklist

- [ ] Set a strong `JWT_SECRET` (Render's blueprint generates one; otherwise use the command in `.env.example`).
- [ ] Set `NODE_ENV=production` so cookies are `Secure` (HTTPS-only).
- [ ] Point `DATA_DIR` at a **persistent disk/volume** so results aren't lost on redeploy.
- [ ] Serve over **HTTPS** (all the options above do this for you). Fullscreen and some proctoring APIs require a secure context.
- [ ] Back up the SQLite file in `DATA_DIR` periodically (it's a single file).

---

## Selling to universities — suggested next steps

The core is here and self-contained. To package it as a product, the natural additions are:

- **Multi-tenancy / per-institution branding** (logo, colours, subdomain per school).
- **Question bank import** (CSV / QTI) and export of results to CSV/Excel.
- **Move to Postgres** for large deployments (the data layer is isolated in `db.js`, so this is a contained change).
- **Analytics dashboard** (per-question difficulty, cohort performance).
- **Native lockdown shell** (Safe Exam Browser config or Electron kiosk) for high-stakes exams.
- **Webcam/screen recording proctoring** if a school requires human review.

---

## Project layout

```
server.js            Express + Socket.IO bootstrap
db.js                SQLite schema + CS fields + demo seed
grading.js           MCQ auto-grading, written-answer scoring, letter grades
middleware/auth.js   JWT cookie auth + role guards
routes/auth.js       register / login / logout / me
routes/ai.js         AI question generation (optional, needs AI_API_KEY)
routes/quizzes.js    subjects, quiz CRUD, questions, live sessions, results, practice
realtime/live.js     Socket.IO: lobby, start, answer autosave, violation→F, submit
public/              Frontend (vanilla JS SPA)
  index.html
  css/styles.css
  js/{api,ui,pages,exam,app}.js
Dockerfile           Production container
render.yaml          One-click Render blueprint
e2e-test.js          Automated end-to-end test suite (npm test)
```

## Tech notes

- **Database:** SQLite via `better-sqlite3` — zero-config, file-backed, fast. Swap to Postgres by reimplementing `db.js`.
- **Realtime:** Socket.IO rooms — `session:<id>` for students, `host:<id>` for the teacher.
- **Security:** Helmet headers with a CSP, rate-limited auth, bcrypt hashing, HttpOnly JWT cookies, server-side answer stripping so correct answers never reach the student's browser during a quiz.
