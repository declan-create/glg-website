const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

// ============================================================================
// EVENT CONFIG — edit THIS block for any future change to teams/event format.
// Nothing else in this file needs to change for a team-name swap, adding a
// team, or switching between "one-off trial" and "season" mode.
// ============================================================================
const EVENT_CONFIG = {
  regionName: "Sydney North Shore",
  regionSlug: "north-shore",
  regionStatusLabel: "Live Trial",   // badge text shown on the site (e.g. "Live Trial", "Live", "Live Season")
  eventMode: "trial",                // "trial" = single one-off fixture · "season" = full round robin
  eventDate: "2026-07-24",           // used as the fixture date in trial mode

  hostGym: {
    name: "BFT Pymble",
    address: "Pymble, NSW",
    adminEmail: "admin@bftpymble.com.au",
  },

  // Add or remove team names here — everything downstream (athletes, roster
  // categories, fixtures) is generated automatically to match this list.
  teamNames: ["Gadigal", "Wangal"],
};
// ============================================================================

// ============================================================================

const dbPath = process.env.GLG_DB_PATH || path.join(__dirname, 'glg.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// ============ SCHEMA ============
db.exec(`
CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  level TEXT NOT NULL, -- 'country' | 'state' | 'region'
  parent_id INTEGER REFERENCES regions(id),
  status TEXT DEFAULT 'active', -- 'active' | 'coming_soon'
  status_label TEXT -- overrides the default "Live" badge text, e.g. "Live Trial"
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL, -- 'athlete' | 'gym_admin' | 'league_operator' | 'admin'
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  dob TEXT,
  gender TEXT, -- 'M' | 'F'
  bio TEXT,
  approved INTEGER DEFAULT 1, -- for league_operator applications: 0 = pending
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  region_id INTEGER REFERENCES regions(id),
  admin_user_id INTEGER REFERENCES users(id),
  address TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  gym_id INTEGER REFERENCES gyms(id),
  region_id INTEGER REFERENCES regions(id),
  division TEXT DEFAULT 'Open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS athletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  region_id INTEGER REFERENCES regions(id),
  team_id INTEGER REFERENCES teams(id), -- NULL = unassigned pool
  wants_team INTEGER DEFAULT 0, -- 1 = "assign me to a team"
  category TEXT, -- 'mens_singles'|'womens_singles'|'mens_doubles'|'womens_doubles'|'mixed_doubles' — the athlete's competing category for the season. NULL until a gym admin assigns it.
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_sprint_finish INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_id INTEGER REFERENCES gates(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL, -- 'm' | 'kg_reps' | 'cal' | 'reps' | 'sec'
  benchmark_m REAL, -- men's individual benchmark
  benchmark_w REAL, -- women's individual benchmark
  benchmark_desc TEXT,
  lower_is_better INTEGER DEFAULT 0, -- 1 for time-based (faster=better)
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id INTEGER REFERENCES regions(id),
  week INTEGER NOT NULL,
  team_a_id INTEGER REFERENCES teams(id),
  team_b_id INTEGER REFERENCES teams(id),
  match_date TEXT,
  status TEXT DEFAULT 'scheduled' -- 'scheduled' | 'live' | 'complete'
);

-- Scoring happens at the (fixture, exercise, category) level — one row per team
-- per category per exercise. For doubles/mixed categories, raw_value is the pair's
-- single combined performance (e.g. total reps counted for the pair), not summed
-- after the fact — this avoids double-counting and matches how a judge actually
-- calls a doubles set on the day.
CREATE TABLE IF NOT EXISTS category_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  exercise_id INTEGER REFERENCES exercises(id),
  team_id INTEGER REFERENCES teams(id),
  category TEXT NOT NULL,
  raw_value REAL,
  benchmark_met INTEGER DEFAULT 0,
  beat_opponent INTEGER DEFAULT 0,
  points INTEGER DEFAULT 0,
  recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fixture_id, exercise_id, team_id, category)
);

CREATE TABLE IF NOT EXISTS category_gate4_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  team_id INTEGER REFERENCES teams(id),
  category TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  total_time_sec REAL,
  won_sprint INTEGER DEFAULT 0,
  points INTEGER DEFAULT 0,
  UNIQUE(fixture_id, team_id, category)
);
`);

// ============ SEED (idempotent) ============
function seed() {
  const already = db.prepare("SELECT COUNT(*) c FROM regions").get().c;
  if (already > 0) return;

  const insRegion = db.prepare("INSERT INTO regions (name, slug, level, parent_id, status, status_label) VALUES (?,?,?,?,?,?)");
  const au = insRegion.run("Australia", "australia", "country", null, "active", null).lastInsertRowid;
  const nsw = insRegion.run("New South Wales", "nsw", "state", au, "active", null).lastInsertRowid;

  const regionDefs = [
    [EVENT_CONFIG.regionName, EVENT_CONFIG.regionSlug, "active", EVENT_CONFIG.regionStatusLabel],
    ["Sydney Eastern Suburbs", "eastern-suburbs", "coming_soon", null],
    ["Sydney Northern Beaches", "northern-beaches", "coming_soon", null],
    ["Sydney Inner West", "inner-west", "coming_soon", null],
    ["Sydney South", "sydney-south", "coming_soon", null],
  ];
  const regionIds = {};
  for (const [name, slug, status, statusLabel] of regionDefs) {
    regionIds[slug] = insRegion.run(name, slug, "region", nsw, status, statusLabel).lastInsertRowid;
  }
  // other states, coming soon, no regions yet (placeholder for nav breadth)
  insRegion.run("Victoria", "vic", "state", au, "coming_soon", null);
  insRegion.run("Queensland", "qld", "state", au, "coming_soon", null);

  const northShore = regionIds[EVENT_CONFIG.regionSlug];

  // Admin users (3 seats)
  const insUser = db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,approved) VALUES (?,?,?,?,?,1)`);
  const hash = (p) => bcrypt.hashSync(p, 10);
  insUser.run("declan@gymleagueglobal.com.au", hash("GLGadmin2026!"), "admin", "Declan", "Murphy");
  insUser.run("glynn@gymleagueglobal.com.au", hash("GLGadmin2026!"), "admin", "Glynn", "Pearman");
  insUser.run("matthew@gymleagueglobal.com.au", hash("GLGadmin2026!"), "admin", "Matthew", "Murphy");

  // Host gym + one team per name in EVENT_CONFIG.teamNames — add/remove a
  // name in that config block to change the team count, nothing else here needs editing.
  const insGym = db.prepare("INSERT INTO gyms (name, region_id, admin_user_id, address) VALUES (?,?,?,?)");
  const insTeam = db.prepare("INSERT INTO teams (name, gym_id, region_id, division) VALUES (?,?,?,?)");

  const hostAdminUid = insUser.run(EVENT_CONFIG.hostGym.adminEmail, hash("GymAdmin2026!"), "gym_admin", EVENT_CONFIG.hostGym.name.split(" ")[0], "Admin").lastInsertRowid;
  const hostGymId = insGym.run(EVENT_CONFIG.hostGym.name, northShore, hostAdminUid, EVENT_CONFIG.hostGym.address).lastInsertRowid;

  const teamIds = EVENT_CONFIG.teamNames.map(name =>
    insTeam.run(name, hostGymId, northShore, "Open").lastInsertRowid
  );

  // Athletes: 8 per team, covering all 5 categories exactly —
  // 1 Men's Singles, 1 Women's Singles, 2 Men's Doubles, 2 Women's Doubles,
  // 1 Men's + 1 Women's for Mixed Doubles = 4 men, 4 women, 8 total per team.
  const insAthlete = db.prepare("INSERT INTO athletes (user_id, region_id, team_id, wants_team, category) VALUES (?,?,?,?,?)");

  const categoryTemplate = [
    ["mens_singles", "M"], ["womens_singles", "F"],
    ["mens_doubles", "M"], ["mens_doubles", "M"],
    ["womens_doubles", "F"], ["womens_doubles", "F"],
    ["mixed_doubles", "M"], ["mixed_doubles", "F"],
  ];

  // Name pools sized generously so this keeps working even if more teams are added later
  const malePool = ["Jack","Liam","Noah","Ethan","Lucas","Mason","Ryan","Oliver","Henry","James","Leo","Sam","Tom","Ben","Max","Cody"];
  const femalePool = ["Emma","Olivia","Ava","Mia","Chloe","Zoe","Grace","Sophie","Isla","Ruby","Ella","Amy","Lucy","Kate","Nina","Jade"];
  const surnamePool = ["Nguyen","Wilson","Chen","Baker","Singh","Thompson","Kelly","Roberts","Ahmed","Ferguson","Davies","Campbell","Reid","Walsh","Turner","Hughes"];

  let mIdx = 0, fIdx = 0, surIdx = 0;
  for (const teamId of teamIds) {
    for (const [category, gender] of categoryTemplate) {
      const fn = gender === 'M' ? malePool[mIdx++] : femalePool[fIdx++];
      const ln = surnamePool[surIdx++ % surnamePool.length];
      const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${surIdx}@example.com`;
      const uid = insUser.run(email, hash("Athlete2026!"), "athlete", fn, ln).lastInsertRowid;
      db.prepare("UPDATE users SET gender=? WHERE id=?").run(gender, uid);
      insAthlete.run(uid, northShore, teamId, 0, category);
    }
  }

  // 2 unassigned athletes wanting a team (no category yet — assigned once picked up)
  for (const [fn,ln,gender] of [["Finn","Foster","M"],["Sienna","Mitchell","F"]]) {
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`;
    const uid = insUser.run(email, hash("Athlete2026!"), "athlete", fn, ln).lastInsertRowid;
    db.prepare("UPDATE users SET gender=? WHERE id=?").run(gender, uid);
    insAthlete.run(uid, northShore, null, 1, null);
  }

  // Gates + exercises (matches the GLG exercise sheet)
  const insGate = db.prepare("INSERT INTO gates (number, name, is_sprint_finish) VALUES (?,?,?)");
  const g1 = insGate.run(1, "Posterior Chain", 0).lastInsertRowid;
  const g2 = insGate.run(2, "Lower Body", 0).lastInsertRowid;
  const g3 = insGate.run(3, "Upper Body", 0).lastInsertRowid;
  const g4 = insGate.run(4, "Core — Sprint Finish", 1).lastInsertRowid;

  const insEx = db.prepare(`INSERT INTO exercises (gate_id,name,unit,benchmark_m,benchmark_w,benchmark_desc,lower_is_better,sort_order) VALUES (?,?,?,?,?,?,?,?)`);
  // Gate 1
  insEx.run(g1,"Ski Erg","m",800,800,"800 m",0,1);
  insEx.run(g1,"Trap Bar Deadlift","reps",30,30,"84kg(M)/54kg(W) x 30 reps benchmark",0,2);
  insEx.run(g1,"Sandbag Lunge Ladder","m",20,20,"20 m per weight rung",0,3);
  // Gate 2
  insEx.run(g2,"Bike (Stationary)","m",2000,2000,"2 km",0,1);
  insEx.run(g2,"Goblet Squat (DB)","reps",30,30,"25kg(M)/17.5kg(W) x 30 reps",0,2);
  insEx.run(g2,"Burpee Box Jump","reps",40,40,"60cm box x 40 reps",0,3);
  // Gate 3
  insEx.run(g3,"Assault Bike","cal",80,50,"80cal(M)/50cal(W)",0,1);
  insEx.run(g3,"DB Push Press","reps",30,30,"15kg(M)/10kg(W) x 30 reps",0,2);
  insEx.run(g3,"DB Snatch","reps",30,30,"20kg(M)/15kg(W) x 30 reps alternating",0,3);
  // Gate 4 (sprint finish - completion + win based, not per-exercise points)
  insEx.run(g4,"Wall Balls","reps",50,50,"6kg(M)/4kg(W) x 50 reps",0,1);
  insEx.run(g4,"Russian Twist","reps",30,30,"6kg(M)/4kg(W) x 30 each side",0,2);
  insEx.run(g4,"Row 500m","sec",null,null,"500m row, first to finish wins",1,3);

  // Fixture schedule — driven by EVENT_CONFIG.eventMode:
  //   "trial"  -> one single fixture on EVENT_CONFIG.eventDate (current setting)
  //   "season" -> full round robin, one week per unique pairing
  const insFixture = db.prepare("INSERT INTO fixtures (region_id, week, team_a_id, team_b_id, match_date, status) VALUES (?,?,?,?,?,?)");

  if (EVENT_CONFIG.eventMode === "trial") {
    // Trial mode expects exactly 2 teams — one fixture, one date.
    insFixture.run(northShore, 1, teamIds[0], teamIds[1], EVENT_CONFIG.eventDate, "scheduled");
  } else {
    const pairs = [];
    for (let i = 0; i < teamIds.length; i++) for (let j = i + 1; j < teamIds.length; j++) pairs.push([teamIds[i], teamIds[j]]);
    const startDate = new Date(EVENT_CONFIG.eventDate);
    pairs.forEach(([a, b], idx) => {
      const week = idx + 1;
      const d = new Date(startDate); d.setDate(d.getDate() + (week - 1) * 7);
      insFixture.run(northShore, week, a, b, d.toISOString().slice(0, 10), "scheduled");
    });
  }

  console.log("Seed complete.");
}

seed();

module.exports = db;
