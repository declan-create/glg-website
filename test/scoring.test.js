const test = require('node:test');
const assert = require('node:assert');
const { scoreExercise, scoreGate4, benchmarkForCategory, CATEGORIES } = require('../scoring');

test('benchmarkForCategory: singles use individual benchmark directly', () => {
  const ex = { benchmark_m: 30, benchmark_w: 20 };
  assert.strictEqual(benchmarkForCategory(ex, 'mens_singles'), 30);
  assert.strictEqual(benchmarkForCategory(ex, 'womens_singles'), 20);
});

test('benchmarkForCategory: doubles use the SAME benchmark as singles (no summing)', () => {
  const ex = { benchmark_m: 30, benchmark_w: 20 };
  assert.strictEqual(benchmarkForCategory(ex, 'mens_doubles'), 30);
  assert.strictEqual(benchmarkForCategory(ex, 'womens_doubles'), 20);
});

test('benchmarkForCategory: mixed doubles takes the midpoint where m/w differ, the shared value where equal', () => {
  assert.strictEqual(benchmarkForCategory({ benchmark_m: 80, benchmark_w: 50 }, 'mixed_doubles'), 65);
  assert.strictEqual(benchmarkForCategory({ benchmark_m: 30, benchmark_w: 30 }, 'mixed_doubles'), 30);
});

test('benchmarkForCategory: returns null when exercise has no per-gender benchmark (Gate 4 style)', () => {
  const ex = { benchmark_m: null, benchmark_w: null };
  assert.strictEqual(benchmarkForCategory(ex, 'mens_singles'), null);
});

test('scoreExercise: meets benchmark + beats opponent category = 2pts', () => {
  const r = scoreExercise({ raw: 35, opponentRaw: 30, benchmark: 30, lowerIsBetter: false });
  assert.deepStrictEqual(r, { benchmarkMet: 1, beatOpponent: 1, points: 2 });
});

test('scoreExercise: meets benchmark exactly but loses head-to-head = 1pt', () => {
  const r = scoreExercise({ raw: 30, opponentRaw: 35, benchmark: 30, lowerIsBetter: false });
  assert.deepStrictEqual(r, { benchmarkMet: 1, beatOpponent: 0, points: 1 });
});

test('scoreExercise: fails benchmark = 0pts EVEN IF opponent category did worse (hard zero rule)', () => {
  const r = scoreExercise({ raw: 20, opponentRaw: 15, benchmark: 30, lowerIsBetter: false });
  assert.deepStrictEqual(r, { benchmarkMet: 0, beatOpponent: 0, points: 0 });
});

test('scoreExercise: time-based (lower is better) works correctly', () => {
  const r = scoreExercise({ raw: 110, opponentRaw: 120, benchmark: 115, lowerIsBetter: true });
  assert.deepStrictEqual(r, { benchmarkMet: 1, beatOpponent: 1, points: 2 });
});

test('scoreExercise: no opponent category result yet — no crash, no bonus point', () => {
  const r = scoreExercise({ raw: 40, opponentRaw: null, benchmark: 30, lowerIsBetter: false });
  assert.deepStrictEqual(r, { benchmarkMet: 1, beatOpponent: 0, points: 1 });
});

test('scoreExercise: doubles pair combined value against the SAME benchmark as singles', () => {
  // Benchmark 30 for singles AND doubles. Pair scores 62 combined, opposing pair 28.
  const benchmark = 30;
  const home = scoreExercise({ raw: 62, opponentRaw: 28, benchmark, lowerIsBetter: false });
  const away = scoreExercise({ raw: 28, opponentRaw: 62, benchmark, lowerIsBetter: false });
  assert.strictEqual(home.points, 2); // met benchmark + beat opponent
  assert.strictEqual(away.points, 0); // 28 < 30 — benchmark missed, win bonus hard-zeroed
});

test('scoreGate4: completed and fastest = 6pts', () => {
  assert.strictEqual(scoreGate4({ completed: true, isFastest: true }), 6);
});

test('scoreGate4: completed but not fastest = 3pts', () => {
  assert.strictEqual(scoreGate4({ completed: true, isFastest: false }), 3);
});

test('scoreGate4: did not complete = 0pts regardless of time', () => {
  assert.strictEqual(scoreGate4({ completed: false, isFastest: false }), 0);
});

test('CATEGORIES: exactly the 5 expected categories, no more, no less', () => {
  assert.deepStrictEqual(CATEGORIES, ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles']);
});
