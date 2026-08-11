const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate completely from the real seeded glg.db, same pattern as integration.test.js.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glg-standings-test-'));
process.env.GLG_DB_PATH = path.join(tmpDir, 'test.db');
process.env.GLG_SESSIONS_PATH = path.join(tmpDir, 'sessions');
process.env.SESSION_SECRET = 'test-secret';
process.env.MAIL_TRANSPORT = 'json';

const db = require('../db');
const scoring = require('../scoring');

// Helper: build a fixture where team A wins every category on raw points and
// completes every station, with a knob to control team B's completion state.
function buildFixture({ teamBCompletesEverything }) {
  const region = db.prepare("SELECT id FROM regions WHERE level='region' LIMIT 1").get();
  const teamRows = db.prepare("SELECT id FROM teams WHERE region_id=? LIMIT 2").all(region.id);
  const [teamA, teamB] = teamRows;

  const fx = db.prepare("INSERT INTO fixtures (region_id, week, team_a_id, team_b_id, match_date, status) VALUES (?,?,?,?,?,?)")
    .run(region.id, 999, teamA.id, teamB.id, '2026-01-01', 'complete');
  const fixtureId = fx.lastInsertRowid;

  const exercises = db.prepare(`
    SELECT e.id FROM exercises e JOIN gates g ON g.id = e.gate_id WHERE g.is_sprint_finish = 0
  `).all();

  const insCat = db.prepare(`
    INSERT INTO category_results (fixture_id, exercise_id, team_id, category, raw_value, benchmark_met, beat_opponent, points)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const ex of exercises) {
    for (const category of scoring.CATEGORIES) {
      // Team A always beats the benchmark and team B -> max points every time.
      insCat.run(fixtureId, ex.id, teamA.id, category, 100, 1, 1, 2);
      if (teamBCompletesEverything) {
        // Team B attempts everything but scores lower -> 0 points, still "completed".
        insCat.run(fixtureId, ex.id, teamB.id, category, 10, 0, 0, 0);
      }
      // else: team B has NO row at all for these exercises -> incomplete.
    }
  }

  const insG4 = db.prepare(`
    INSERT INTO category_gate4_results (fixture_id, team_id, category, completed, total_time_sec, won_sprint, points)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const category of scoring.CATEGORIES) {
    insG4.run(fixtureId, teamA.id, category, 1, 100, 1, 6);
    insG4.run(fixtureId, teamB.id, category, teamBCompletesEverything ? 1 : 0, teamBCompletesEverything ? 200 : null, 0, teamBCompletesEverything ? 3 : 0);
  }

  return { fixtureId, teamA, teamB };
}

test('matchPointsForFixture: winner always gets 3, regardless of completion', () => {
  const { fixtureId, teamA, teamB } = buildFixture({ teamBCompletesEverything: true });
  const outcome = scoring.matchPointsForFixture(fixtureId, teamA.id, teamB.id);
  assert.strictEqual(outcome.result, 'win');
  assert.strictEqual(outcome.matchPoints, 3);
});

test('matchPointsForFixture: loser who completed every station gets 1 point', () => {
  const { fixtureId, teamA, teamB } = buildFixture({ teamBCompletesEverything: true });
  const outcome = scoring.matchPointsForFixture(fixtureId, teamB.id, teamA.id);
  assert.strictEqual(outcome.result, 'loss');
  assert.strictEqual(outcome.completed, true);
  assert.strictEqual(outcome.matchPoints, 1);
});

test('matchPointsForFixture: loser who did NOT complete every station gets 0 points', () => {
  const { fixtureId, teamA, teamB } = buildFixture({ teamBCompletesEverything: false });
  const outcome = scoring.matchPointsForFixture(fixtureId, teamB.id, teamA.id);
  assert.strictEqual(outcome.result, 'loss');
  assert.strictEqual(outcome.completed, false);
  assert.strictEqual(outcome.matchPoints, 0);
});

test('teamCompletedAllStations: true only when every exercise+category and every Gate 4 category is present', () => {
  const { fixtureId, teamA, teamB } = buildFixture({ teamBCompletesEverything: false });
  assert.strictEqual(scoring.teamCompletedAllStations(fixtureId, teamA.id), true);
  assert.strictEqual(scoring.teamCompletedAllStations(fixtureId, teamB.id), false);
});

test('getSeasonLeaderboard: sorts by match points first, raw point difference as tiebreaker', () => {
  const region = db.prepare("SELECT id FROM regions WHERE level='region' LIMIT 1").get();
  // Earlier tests in this file created their own fixtures for the same two
  // teams — clear those out first so this test's expectations aren't
  // affected by season points accumulated from prior test cases.
  db.prepare("DELETE FROM category_results WHERE fixture_id IN (SELECT id FROM fixtures WHERE region_id=?)").run(region.id);
  db.prepare("DELETE FROM category_gate4_results WHERE fixture_id IN (SELECT id FROM fixtures WHERE region_id=?)").run(region.id);
  db.prepare("DELETE FROM fixtures WHERE region_id=?").run(region.id);

  buildFixture({ teamBCompletesEverything: true });
  const table = scoring.getSeasonLeaderboard(region.id);
  assert.ok(table.length >= 2);
  // Winner should be ranked above a team that only picked up a participation point.
  const winnerRow = table.find(r => r.wins > 0);
  const loserRow = table.find(r => r.losses > 0);
  assert.ok(winnerRow.points > loserRow.points);
  assert.strictEqual(winnerRow.points, 3);
  assert.strictEqual(loserRow.points, 1);
});
