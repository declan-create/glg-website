# Gym League Global — Web Platform

A real, working full-stack application for GLG: athlete/gym/league sign-up, region browsing,
6-week round-robin scheduling, a category-matched scoring engine, live results entry, a public
leaderboard, and a "Cast Display" screen gyms can project on match day.

**Version 2 — rebuilt 19 July 2026.** This version replaces an earlier draft that scored
"team's best result" against "team's best result." That was wrong: it could award a bonus
point by comparing across categories or genders rather than matching the actual head-to-head.
This version scores strictly **category vs. category** — Men's Singles only ever compares
against the opposing Men's Singles athlete — and comes with an automated test suite proving it.

---

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3000**. The database (`glg.db`) is a single SQLite file, pre-seeded
with the Sydney North Shore pilot. Do not manually delete `glg.db` while the server is running.

### Running the tests

```bash
npm test
```

26 automated tests: 14 unit tests on the scoring engine (every rule, including the doubles
benchmark math and the hard-zero-on-missed-benchmark rule), and 12 integration tests that hit
the real HTTP routes — signup flows, role-based access control, and the full submit-results
→ scoring → leaderboard pipeline running against a temporary, isolated database.

---

## Login Credentials (seeded accounts)

**GLG Admin (3 seats):**
| Email | Password |
|---|---|
| declan@gymleagueglobal.com.au | GLGadmin2026! |
| glynn@gymleagueglobal.com.au | GLGadmin2026! |
| matthew@gymleagueglobal.com.au | GLGadmin2026! |

**Gym Admin (host gym for the trial — fields both Gadigal and Wangal):**
| Email | Password |
|---|---|
| admin@bftpymble.com.au | GymAdmin2026! |

**Judges (unassigned by default — assign each to a gate from the fixture's "Assign Judges" section):**
| Email | Password |
|---|---|
| judge1@gymleagueglobal.com.au | Judge2026! |
| judge2@gymleagueglobal.com.au | Judge2026! |

**Sample roster:** each team (Gadigal, Wangal) is seeded with a full 8-slot roster covering
all 5 categories (1 Men's Singles, 1 Women's Singles, 2 Men's Doubles, 2 Women's Doubles,
1 Mixed Doubles pair) — every slot is a **"TBA" placeholder**, not a fabricated name, since
real athletes haven't signed up yet. All use password `Athlete2026!` — e.g. `tba1@example.com`.
Full list in `db.js`.

**Gym admins can now manage members directly**, not just via self-signup: on a team's page,
every member's name/email/gender/category is editable in place, and there's an "Add a New
Member" form for anyone who hasn't signed up themselves — they log in with the email you
enter and the default password `GLGWelcome2026!` (worth telling them directly, since there's
no automatic email sent yet — see the known gaps below).

---

## Judges, the Live Match Board, and the Public Watch Page

**Judges** are a separate account type that can only enter scores for the specific gate
they're assigned to:
1. A gym admin (or GLG Admin) goes to a fixture's Results page and assigns a judge's email
   to a gate.
2. The judge logs in at the normal `/login` page and lands on their own dashboard listing
   only their assigned gate(s).
3. Opening a gate shows just that gate's exercises — the judge enters scores as each
   exercise finishes rather than waiting to fill in one giant form at the end.
4. A judge who isn't assigned to a gate gets a clear "Access Denied," both for viewing and
   for submitting — verified with automated tests.

**The clock is server-synced**, not local to one browser. Starting, pausing, or resetting the
timer from the Cast Display updates the server; every viewer — the controller and anyone on
the public watch page — reads from that same server state, so they always agree on the time.

**Two views of the same match:**
- **`/cast/:fixtureId`** — the controller's screen (requires login as a gym admin from one of
  the two competing teams, or a GLG Admin). Has the Start/Pause/Reset buttons.
- **`/watch/:fixtureId`** — public, no login required. Same live board and same clock, but
  with no controls — safe to share with spectators, family, or other gyms. Also polls for
  live scores as judges enter them.

Both pages have a **Fullscreen** button (top right) using the browser's real Fullscreen API —
hides the browser's address bar and tabs for a cleaner display on a TV or projector. Browsers
require a real click to trigger this (a security rule), so it can't happen automatically on
page load.

---

## The Scoring Model (v2 — category-matched)

Scoring happens **per category** (Men's Singles, Women's Singles, Men's Doubles, Women's
Doubles, Mixed Doubles) — never team-vs-team-best. This was a real bug in the first draft,
caught and rebuilt before this version.

**Gates 1–3**, per exercise, per category:
- **+1 point** if the benchmark is met or exceeded
- **+1 more point** if they beat the *same category* on the opposing team that week —
  this bonus only applies on top of hitting the benchmark; missing the benchmark is a hard
  zero, even if the opponent did worse (per spec: "potentially nil if I don't reach it")
- Max **2 points** per exercise per category

**Gate 4 (Sprint Finish)**, per category, all 3 exercises combined into one sprint:
- **+3 points** for completing all three exercises
- **+3 more points** for being the fastest category-vs-category (winner-take-all)
- Max **6 points**

### Doubles/Mixed — how a pair's result is recorded and scored

For Doubles and Mixed categories, the number entered is the **pair's single combined
performance** for that exercise (e.g. "the pair did 62 total reps"), exactly as a judge would
call it on the day — not two separate entries summed afterward. This avoids double-counting
when team totals are calculated.

**Benchmark assumption (flagged for Declan to confirm before the first real season):** since
two athletes contribute to one combined number, the doubles benchmark is the sum of the two
individual benchmarks that make up the pair:
- Men's Doubles = 2 × men's individual benchmark
- Women's Doubles = 2 × women's individual benchmark
- Mixed Doubles = men's benchmark + women's benchmark

This is a reasonable default, not an official ruling — easy to change in one place
(`benchmarkForCategory` in `scoring.js`) if the real rule differs.

### Worked example (from a real submitted test — see `test/integration.test.js`)

Ski Erg, benchmark 800m individual / 1600m doubles:
- **Men's Singles:** Jack (Pymble) rows 850m, Lucas (Turramurra) rows 820m. Both clear the
  benchmark. Jack's 850 beats Lucas's 820 → **Jack: 2pts, Lucas: 1pt.**
- **Women's Doubles:** Pymble's pair combines for 1,550m — *misses* the 1,600m doubles
  benchmark → **0 points**, full stop, even though Turramurra's pair (1,620m, benchmark met)
  is compared to *them*, not the other way around.
- **Mixed Doubles:** Pymble's pair hits 1,700m, Turramurra's 1,650m. Both clear the
  benchmark; Pymble's total is higher → **Pymble: 2pts, Turramurra: 1pt** (benchmark met,
  didn't beat the opposing pair).
- Every one of these numbers was verified by hand against what the running app actually
  computed — not just asserted.

---

## What's Verified vs. What's a Known Gap

### ✅ Verified end-to-end (not just code-reviewed)
- Athlete sign-up (assign-me pool path, and pick-a-team path)
- Gym sign-up with multiple teams from one signup
- League Franchise Operator application → pending → blocked login → admin approval → unlock
- Gym Admin: create teams, view/assign the region's unassigned pool, remove athletes,
  **assign each athlete's competition category** (new — this is what makes category-matched
  scoring possible)
- Full results entry → category-matched scoring → public leaderboard, hand-verified against
  real submitted numbers across all 5 categories plus Gate 4
- Access control: a gym admin can only manage results for fixtures involving their own team;
  a GLG Admin can manage any fixture. (This was a real gap found and fixed while writing the
  integration tests — flagging it, not hiding it.)
- Sessions survive a full server process restart (file-backed session store, not the default
  in-memory store — the first draft would have logged everyone out on every redeploy)
- Input validation on every sign-up/login route: email format, password length, region
  existence, name/string length caps — with automated tests proving malformed input is
  rejected without crashing the server
- Rate limiting on login and all sign-up forms (20 attempts / 15 minutes per IP)
- Security headers via `helmet` (CSP, X-Frame-Options, X-Content-Type-Options)
- Cast Display now shows category-grouped lineups (Men's Singles: Jack Nguyen vs Lucas Ahmed,
  etc.) instead of a flat roster list

### ⚠️ Known gaps — not yet built, not hidden
- **Payments** — not needed until Sept/Oct per your instruction. Data model is ready to wire
  up when it's time.
- **Password reset / email verification** — no SMTP configured in this environment, so this
  wasn't built rather than half-built. Needs an email service (e.g. Postmark, SES) wired in
  before this matters for real users.
- **CSRF tokens** — not yet implemented. Lower priority than the fixes above for a controlled
  Friday trial with known accounts, but should be added before this is open to the public.
- **Multiple divisions by fitness level/age group** — the `division` field exists on `teams`
  (defaults to "Open") but there's no UI to manage multiple divisions within a region yet.
- **Doubles benchmark rule** — see above; a reasonable default, not an official ruling.
- **Railway deployment** — written up below, but only run and verified in this sandbox, not
  actually deployed to Railway. Native modules (`better-sqlite3`) occasionally need a build
  step on a new host; worth doing a test deploy before relying on it for Friday.

---

## Architecture

- **Backend:** Node.js + Express
- **Views:** EJS templates, server-rendered
- **Database:** SQLite via `better-sqlite3` — single file, zero external services
- **Sessions:** `express-session` + `session-file-store` (file-backed, survives restarts —
  not the default in-memory store)
- **Auth:** `bcryptjs` password hashing, session-based
- **Security:** `helmet` (headers), `express-rate-limit` (login/signup throttling), custom
  input validation on every form
- **Scoring:** isolated in `scoring.js`, fully unit-tested (`test/scoring.test.js`)
- **Tests:** Node's built-in test runner (`node --test`) — no extra test framework dependency
  beyond `supertest` for HTTP-level integration tests
- **Brand:** Forest & Limelight design system throughout

### File structure
```
glg-app/
  server.js              — all routes, auth, validation, access control
  db.js                  — schema + seed data (configurable DB path via GLG_DB_PATH env var)
  scoring.js              — the category-matched scoring engine
  test/
    scoring.test.js        — 14 unit tests on scoring rules
    integration.test.js    — 12 HTTP integration tests (signup, auth, access control, full pipeline)
  views/                  — EJS templates
  public/css/style.css     — full brand design system
  public/fonts/            — Forest & Limelight brand fonts (self-hosted)
  glg.db                  — pre-seeded SQLite database
```

---

## Deploying to Railway

1. Push this folder to your `gym-league-global` GitHub repo (or a new repo).
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Set environment variable `SESSION_SECRET` to a long random string.
4. Railway auto-detects Node and runs `npm start`.
5. **Attach a persistent volume** for `glg.db` and the `sessions/` directory — Railway's
   filesystem is ephemeral on redeploy otherwise, and you'll lose all season data. This
   matters more the longer the season runs; for a single Friday trial it's a lower-stakes gap,
   but don't run a full 6-week season without it.
6. This hasn't been deployed to Railway from this environment (no network access to verify).
   Do a test deploy and confirm `better-sqlite3`'s native module builds cleanly before relying
   on it for Friday — if the build fails, Railway's Nixpacks may need a build-tools override.

---

## Resetting the Database

```bash
# stop the server first
rm glg.db
npm start   # reseeds automatically on startup
```

Do not delete `glg.db` while the server is running.
