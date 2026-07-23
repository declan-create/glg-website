const db = require('./db');

/**
 * SCORING MODEL (v2 — category-matched)
 * ======================================
 * Scoring happens PER CATEGORY (Men's Singles, Women's Singles, Men's Doubles,
 * Women's Doubles, Mixed Doubles) — a team's Men's Singles athlete is compared
 * only against the opposing team's Men's Singles athlete, never against a
 * different category or the opposing team's best result across all categories.
 *
 * For doubles/mixed categories, the recorded raw_value is the PAIR'S single
 * combined performance for that exercise (e.g. "the pair did 62 total reps"),
 * exactly as a judge would call it on the day — not summed after the fact from
 * two separate entries. This avoids double-counting when team totals are summed.
 *
 * Gates 1-3 — per exercise, per category:
 *   +1 point if benchmark met/exceeded
 *   +1 additional point if they beat the opposing category's raw value that week
 *     (this bonus ONLY applies on top of hitting the benchmark — missing the
 *     benchmark is a hard zero, per spec: "potentially nil if I don't reach it")
 *   => max 2 points per exercise per category, 0 if benchmark not met
 *
 * Gate 4 (Sprint Finish) — per category, all 3 exercises combined as one sprint:
 *   +3 points for completing all 3 exercises
 *   +3 additional points for being the fastest category-vs-category (winner-take-all)
 *
 * DOUBLES/MIXED BENCHMARKS (confirmed by Declan, 23 Jul 2026):
 * Benchmarks are IDENTICAL regardless of singles or doubles — a pair still puts
 * up one combined score, but it's judged against the same benchmark as a
 * single. No summing of individual benchmarks.
 *   - Men's Doubles   = benchmark_m (same as Men's Singles)
 *   - Women's Doubles = benchmark_w (same as Women's Singles)
 *   - Mixed Doubles   = midpoint of benchmark_m and benchmark_w where they
 *     differ (only the Assault Bike does) — PROVISIONAL, confirm with Declan.
 */

const CATEGORIES = ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles'];

function benchmarkForCategory(exercise, category) {
  const m = exercise.benchmark_m;
  const w = exercise.benchmark_w;
  if (m == null || w == null) return null; // e.g. Gate 4 exercises have no per-exercise benchmark
  switch (category) {
    case 'mens_singles': return m;
    case 'womens_singles': return w;
    case 'mens_doubles': return m;
    case 'womens_doubles': return w;
    case 'mixed_doubles': return (m + w) / 2; // equals the single benchmark wherever m === w
    default: return null;
  }
}

function betterValue(a, b, lowerIsBetter) {
  if (a == null || b == null) return false;
  return lowerIsBetter ? a < b : a > b;
}

function meetsBenchmark(raw, benchmark, lowerIsBetter) {
  if (raw == null || benchmark == null) return false;
  return lowerIsBetter ? raw <= benchmark : raw >= benchmark;
}

/**
 * Compute points for one category's result in one exercise, given the
 * opposing category's raw value for the same exercise/week.
 */
function scoreExercise({ raw, opponentRaw, benchmark, lowerIsBetter }) {
  let points = 0;
  const benchmarkMet = meetsBenchmark(raw, benchmark, lowerIsBetter) ? 1 : 0;
  if (benchmarkMet) points += 1;

  // Bonus point only available on top of hitting the benchmark.
  const beatOpponent = (benchmarkMet && betterValue(raw, opponentRaw, lowerIsBetter)) ? 1 : 0;
  if (beatOpponent) points += 1;

  return { benchmarkMet, beatOpponent, points };
}

function scoreGate4({ completed, isFastest }) {
  let points = 0;
  if (completed) points += 3;
  if (completed && isFastest) points += 3;
  return points;
}

/**
 * Recompute all category-level scores for a fixture. Safe to call repeatedly —
 * always derives points fresh from the raw values on file, so out-of-order or
 * edited entries stay consistent.
 */
function recomputeFixtureScores(fixtureId) {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(fixtureId);
  if (!fixture) return;

  const exercises = db.prepare(`
    SELECT e.*, g.number as gate_number, g.is_sprint_finish
    FROM exercises e JOIN gates g ON g.id = e.gate_id
    ORDER BY g.number, e.sort_order
  `).all();

  const updateStmt = db.prepare("UPDATE category_results SET benchmark_met=?, beat_opponent=?, points=? WHERE id=?");

  for (const ex of exercises) {
    if (ex.is_sprint_finish) continue;

    for (const category of CATEGORIES) {
      const rowA = db.prepare("SELECT * FROM category_results WHERE fixture_id=? AND exercise_id=? AND team_id=? AND category=?")
        .get(fixtureId, ex.id, fixture.team_a_id, category);
      const rowB = db.prepare("SELECT * FROM category_results WHERE fixture_id=? AND exercise_id=? AND team_id=? AND category=?")
        .get(fixtureId, ex.id, fixture.team_b_id, category);

      const benchmark = benchmarkForCategory(ex, category);

      if (rowA) {
        const scored = scoreExercise({ raw: rowA.raw_value, opponentRaw: rowB ? rowB.raw_value : null, benchmark, lowerIsBetter: ex.lower_is_better });
        updateStmt.run(scored.benchmarkMet, scored.beatOpponent, scored.points, rowA.id);
      }
      if (rowB) {
        const scored = scoreExercise({ raw: rowB.raw_value, opponentRaw: rowA ? rowA.raw_value : null, benchmark, lowerIsBetter: ex.lower_is_better });
        updateStmt.run(scored.benchmarkMet, scored.beatOpponent, scored.points, rowB.id);
      }
    }
  }

  // Gate 4 — per category, completion + fastest-wins
  const updateG4 = db.prepare("UPDATE category_gate4_results SET won_sprint=?, points=? WHERE id=?");
  for (const category of CATEGORIES) {
    const rowA = db.prepare("SELECT * FROM category_gate4_results WHERE fixture_id=? AND team_id=? AND category=?").get(fixtureId, fixture.team_a_id, category);
    const rowB = db.prepare("SELECT * FROM category_gate4_results WHERE fixture_id=? AND team_id=? AND category=?").get(fixtureId, fixture.team_b_id, category);

    if (rowA) {
      const isFastest = !!rowA.completed && (!rowB || !rowB.completed || rowA.total_time_sec < rowB.total_time_sec);
      const points = scoreGate4({ completed: !!rowA.completed, isFastest });
      updateG4.run(isFastest && rowA.completed ? 1 : 0, points, rowA.id);
    }
    if (rowB) {
      const isFastest = !!rowB.completed && (!rowA || !rowA.completed || rowB.total_time_sec < rowA.total_time_sec);
      const points = scoreGate4({ completed: !!rowB.completed, isFastest });
      updateG4.run(isFastest && rowB.completed ? 1 : 0, points, rowB.id);
    }
  }
}

function getTeamTotalPoints(fixtureId, teamId) {
  const exPts = db.prepare("SELECT COALESCE(SUM(points),0) s FROM category_results WHERE fixture_id=? AND team_id=?").get(fixtureId, teamId).s;
  const g4Pts = db.prepare("SELECT COALESCE(SUM(points),0) s FROM category_gate4_results WHERE fixture_id=? AND team_id=?").get(fixtureId, teamId).s;
  return exPts + g4Pts;
}

function getSeasonLeaderboard(regionId) {
  const teams = db.prepare("SELECT * FROM teams WHERE region_id=?").all(regionId);
  const fixtures = db.prepare("SELECT * FROM fixtures WHERE region_id=?").all(regionId);

  const standings = teams.map(t => {
    let points = 0, played = 0, wins = 0;
    for (const f of fixtures) {
      if (f.team_a_id !== t.id && f.team_b_id !== t.id) continue;
      if (f.status !== 'complete') continue;
      played++;
      const myPts = getTeamTotalPoints(f.id, t.id);
      const oppId = f.team_a_id === t.id ? f.team_b_id : f.team_a_id;
      const oppPts = getTeamTotalPoints(f.id, oppId);
      points += myPts;
      if (myPts > oppPts) wins++;
    }
    return { team: t, points, played, wins };
  });

  standings.sort((a,b) => b.points - a.points);
  return standings;
}

module.exports = {
  CATEGORIES,
  benchmarkForCategory,
  scoreExercise,
  scoreGate4,
  recomputeFixtureScores,
  getTeamTotalPoints,
  getSeasonLeaderboard,
  meetsBenchmark,
  betterValue,
};
