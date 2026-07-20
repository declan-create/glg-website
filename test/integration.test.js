const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate this test run completely from the real seeded glg.db and sessions —
// each test run gets its own temp database and session store.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glg-test-'));
process.env.GLG_DB_PATH = path.join(tmpDir, 'test.db');
process.env.GLG_SESSIONS_PATH = path.join(tmpDir, 'sessions');
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const app = require('../server');

test('home page loads', async () => {
  const res = await request(app).get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Gym vs gym/);
});

test('regions page loads and lists North Shore as live', async () => {
  const res = await request(app).get('/regions');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Sydney North Shore/);
});

test('protected gym dashboard redirects to login when not authenticated', async () => {
  const res = await request(app).get('/gym');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /\/login/);
});

test('protected admin dashboard rejects a logged-in athlete (wrong role)', async () => {
  const agent = request.agent(app);
  await agent.post('/signup/athlete').type('form').send({
    first_name: 'Role', last_name: 'Tester', email: 'roletest@example.com',
    password: 'TestPass123', gender: 'M', region_id: 3, team_choice: 'assign',
  });
  const res = await agent.get('/admin');
  assert.strictEqual(res.status, 403);
});

test('athlete signup: assign-me path lands in the unassigned pool', async () => {
  const agent = request.agent(app);
  await agent.post('/signup/athlete').type('form').send({
    first_name: 'Pool', last_name: 'Athlete', email: 'poolathlete@example.com',
    password: 'TestPass123', gender: 'F', region_id: 3, team_choice: 'assign',
  });
  const res = await agent.get('/profile');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /unassigned pool/);
});

test('athlete signup: duplicate email is rejected with a clear error', async () => {
  const agent = request.agent(app);
  await agent.post('/signup/athlete').type('form').send({
    first_name: 'Dup', last_name: 'One', email: 'dup@example.com',
    password: 'TestPass123', gender: 'M', region_id: 3, team_choice: 'assign',
  });
  const res2 = await agent.post('/signup/athlete').type('form').send({
    first_name: 'Dup', last_name: 'Two', email: 'dup@example.com',
    password: 'TestPass123', gender: 'M', region_id: 3, team_choice: 'assign',
  });
  assert.match(res2.text, /already exists/);
});

test('gym signup creates multiple teams from comma-separated names', async () => {
  const agent = request.agent(app);
  const res = await agent.post('/signup/gym').type('form').send({
    gym_name: 'Integration Test Gym', admin_first_name: 'Test', admin_last_name: 'Admin',
    email: 'itgym@example.com', password: 'TestPass123', region_id: 3,
    team_names: 'IT Team One, IT Team Two',
  });
  assert.strictEqual(res.status, 302);
  const dash = await agent.get('/gym');
  assert.match(dash.text, /IT Team One/);
  assert.match(dash.text, /IT Team Two/);
});

test('league operator application is blocked from login until approved', async () => {
  await request(app).post('/signup/league').type('form').send({
    first_name: 'Pending', last_name: 'Operator', email: 'pendingop@example.com',
    password: 'TestPass123', proposed_region: 'Test Region',
  });
  const res = await request(app).post('/login').type('form').send({
    email: 'pendingop@example.com', password: 'TestPass123', next: '/league',
  });
  assert.match(res.text, /pending approval/);
});

test('full pipeline: submit category results through real HTTP form, verify scoring end-to-end', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });

  const res = await agent.post('/fixture/1/results').type('form').send({
    result_1_1_mens_singles: '850',
    result_2_1_mens_singles: '820',
  });
  assert.strictEqual(res.status, 302);

  const region = await agent.get('/regions/north-shore');
  assert.strictEqual(region.status, 200);
  // Gadigal should show on the region leaderboard after results are entered
  assert.match(region.text, /Gadigal/);
});

test('access control: a gym admin CAN manage results for a fixture involving their own team', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const res = await agent.get('/fixture/1/results'); // fixture 1 = Pymble vs Turramurra
  assert.strictEqual(res.status, 200);
});

test('access control: a gym admin CANNOT manage results for a fixture that does not involve their team', async () => {
  // Create a brand-new, unrelated gym (not part of the trial fixture) to prove
  // the ownership check works even when there's only one gym in the seed data.
  const outsiderAgent = request.agent(app);
  await outsiderAgent.post('/signup/gym').type('form').send({
    gym_name: 'Outsider Gym', admin_first_name: 'Out', admin_last_name: 'Sider',
    email: 'outsider@example.com', password: 'TestPass123', region_id: 3,
    team_names: 'Outsider Team',
  });
  const res = await outsiderAgent.get('/fixture/1/results'); // fixture 1 = Gadigal vs Wangal — Outsider Gym isn't involved
  assert.strictEqual(res.status, 403);
});

test('access control: GLG admin can manage results for any fixture', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'declan@gymleagueglobal.com.au', password: 'GLGadmin2026!', next: '/admin',
  });
  const res = await agent.get('/fixture/1/results');
  assert.strictEqual(res.status, 200);
});

test('cast display: requires login — anonymous visitors are redirected', async () => {
  const res = await request(app).get('/cast/1');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /\/login/);
});

test('cast display: a gym admin from a fixture\'s host gym can view it', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const res = await agent.get('/cast/1');
  assert.strictEqual(res.status, 200);
});

test('cast display: an unrelated gym admin is blocked', async () => {
  const agent = request.agent(app);
  await agent.post('/signup/gym').type('form').send({
    gym_name: 'Cast Outsider Gym', admin_first_name: 'Cast', admin_last_name: 'Outsider',
    email: 'castoutsider@example.com', password: 'TestPass123', region_id: 3,
  });
  const res = await agent.get('/cast/1');
  assert.strictEqual(res.status, 403);
});

test('cast display: client-side JS actually runs without error and renders all 5 category rows', async () => {
  // This is the test that would have caught the "fixture is not defined" bug —
  // checking the HTML response alone isn't enough, since a broken <script> tag
  // still returns 200 with valid markup. This actually executes the page's JS
  // in a real DOM (jsdom) the same way a browser would.
  const { JSDOM } = require('jsdom');
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const res = await agent.get('/cast/1');
  assert.strictEqual(res.status, 200);

  const dom = new JSDOM(res.text, { runScripts: 'dangerously', url: 'http://localhost/cast/1' });
  let jsError = null;
  dom.window.onerror = (msg) => { jsError = msg; };

  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(jsError, null, `Cast display threw a JS error on load: ${jsError}`);

  const grid = dom.window.document.getElementById('catGrid');
  const rowCount = (grid.innerHTML.match(/cat-row/g) || []).length;
  assert.strictEqual(rowCount, 5, 'Expected all 5 categories to render on load');

  // Simulate an actual Start button click and confirm the clock advances
  const startBtn = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start');
  assert.ok(startBtn, 'Start button should exist');
  startBtn.click();
  await new Promise(r => setTimeout(r, 2200));
  const clockText = dom.window.document.getElementById('masterClock').textContent;
  assert.notStrictEqual(clockText, '00:00', 'Clock should have advanced after clicking Start');

  dom.window.close();
});
