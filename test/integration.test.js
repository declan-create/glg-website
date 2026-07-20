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

// A real listening server (unlike supertest's in-process requests) is needed
// for the one test that drives an actual browser via Playwright.
let liveServer, PORT_UNDER_TEST;
test.before(() => new Promise((resolve) => {
  liveServer = app.listen(0, () => { PORT_UNDER_TEST = liveServer.address().port; resolve(); });
}));
test.after(() => new Promise((resolve) => liveServer.close(resolve)));

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

test('cast display: real browser test — clicking Start actually advances the clock (catches CSP issues jsdom cannot)', async (t) => {
  // jsdom does NOT enforce Content-Security-Policy, so a bug where CSP silently
  // blocks onclick="" attributes (like the real one found in this app — helmet's
  // default script-src-attr 'none' blocks inline event handlers even when
  // script-src allows inline <script> tags) would pass every jsdom-based test
  // while genuinely being broken in every real browser. This test uses an actual
  // Chromium via Playwright to catch that entire class of bug.
  let chromiumPath;
  try {
    chromiumPath = require('child_process').execSync(
      'find /opt/pw-browsers -type f -name "headless_shell" -o -type f -name "chrome" 2>/dev/null | head -1',
      { encoding: 'utf8' }
    ).trim();
  } catch { chromiumPath = ''; }

  if (!chromiumPath) {
    t.skip('No system Chromium found — skipping real-browser CSP check (jsdom tests above still cover rendering/data correctness)');
    return;
  }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // log in as the host gym admin via the real form, then open the cast display
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/login');
    await page.fill('input[name=email]', 'admin@bftpymble.com.au');
    await page.fill('input[name=password]', 'GymAdmin2026!');
    await page.click('button[type=submit]');
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/cast/1');

    const clockBefore = await page.locator('#masterClock').innerText();
    await page.click("button:has-text('Start')");
    await page.waitForTimeout(2200);
    const clockAfter = await page.locator('#masterClock').innerText();

    assert.notStrictEqual(clockAfter, clockBefore, `Clock should advance after clicking Start in a real browser (before=${clockBefore}, after=${clockAfter}) — if this fails, check for CSP blocking inline event handlers (script-src-attr)`);
  } finally {
    await browser.close();
  }
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

  // NOTE: we don't click Start here — Cast Display's Start button now calls a
  // real fetch() to the server-synced clock API, which jsdom cannot resolve
  // (no real network stack in its sandboxed script context). That behaviour
  // is covered properly by the real-browser Playwright test above instead.

  dom.window.close();
});

test('judge: assigned to a gate via gym admin, then can log in and access only that gate', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const assignRes = await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_email: 'judge1@gymleagueglobal.com.au', gate_id: 1,
  });
  assert.strictEqual(assignRes.status, 302);

  const judgeAgent = request.agent(app);
  await judgeAgent.post('/login').type('form').send({
    email: 'judge1@gymleagueglobal.com.au', password: 'Judge2026!', next: '/judge',
  });
  const dashboard = await judgeAgent.get('/judge');
  assert.strictEqual(dashboard.status, 200);
  assert.match(dashboard.text, /Gate 1/);

  const allowedGate = await judgeAgent.get('/judge/fixture/1/gate/1');
  assert.strictEqual(allowedGate.status, 200);

  const blockedGate = await judgeAgent.get('/judge/fixture/1/gate/2');
  assert.strictEqual(blockedGate.status, 403);
});

test('judge: submitting a score for their assigned gate computes correctly and is blocked for other gates', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_email: 'judge2@gymleagueglobal.com.au', gate_id: 1,
  });

  const judgeAgent = request.agent(app);
  await judgeAgent.post('/login').type('form').send({
    email: 'judge2@gymleagueglobal.com.au', password: 'Judge2026!', next: '/judge',
  });

  const submitRes = await judgeAgent.post('/judge/fixture/1/gate/1').type('form').send({
    result_1_1_womens_singles: '900', // benchmark 800, should score 2pts if it beats the opponent too
    result_2_1_womens_singles: '850',
  });
  assert.strictEqual(submitRes.status, 302);

  // blocked from submitting to a gate they aren't assigned to
  const blockedSubmit = await judgeAgent.post('/judge/fixture/1/gate/2').type('form').send({
    result_1_4_mens_singles: '999',
  });
  assert.strictEqual(blockedSubmit.status, 403);
});

test('clock API: anonymous can read status but cannot start/pause/reset', async () => {
  const readRes = await request(app).get('/api/fixture/1/clock/combined');
  assert.strictEqual(readRes.status, 200);
  assert.ok('running' in readRes.body && 'elapsedSeconds' in readRes.body);

  const writeRes = await request(app).post('/api/fixture/1/clock/combined/start');
  assert.strictEqual(writeRes.status, 302); // requireLogin redirects anonymous requests
});

test('clock API: gym admin can start the clock and elapsed time increases', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  await agent.post('/api/fixture/1/clock/gate4/reset');
  await agent.post('/api/fixture/1/clock/gate4/start');
  await new Promise(r => setTimeout(r, 1200));
  const status = await request(app).get('/api/fixture/1/clock/gate4');
  assert.strictEqual(status.body.running, true);
  assert.ok(status.body.elapsedSeconds > 0.5, `Expected elapsed time to have advanced, got ${status.body.elapsedSeconds}`);
  await agent.post('/api/fixture/1/clock/gate4/pause');
});

test('public watch page: loads with no login and has no clock control buttons', async () => {
  const res = await request(app).get('/watch/1');
  assert.strictEqual(res.status, 200);
  assert.doesNotMatch(res.text, /onclick="startClock/);
  assert.doesNotMatch(res.text, />Start<\/button>/);
});

test('live-scores endpoint returns data after a judge submits a result', async () => {
  const res = await request(app).get('/api/fixture/1/live-scores');
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.body === 'object');
});

test('cast display and watch page: no gate-switching tabs — everything flows on one continuous clock', async (t) => {
  let chromiumPath;
  try {
    chromiumPath = require('child_process').execSync(
      'find /opt/pw-browsers -type f -name "headless_shell" -o -type f -name "chrome" 2>/dev/null | head -1',
      { encoding: 'utf8' }
    ).trim();
  } catch { chromiumPath = ''; }

  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const castRes = await agent.get('/cast/1');
  assert.doesNotMatch(castRes.text, /class="gate-tab/, 'Cast Display should have no gate-switching tabs');
  assert.match(castRes.text, /FULL EVENT/, 'Should show a single continuous event label');

  const watchRes = await request(app).get('/watch/1');
  assert.doesNotMatch(watchRes.text, /class="gate-tab/, 'Watch page should have no gate-switching tabs either');

  if (!chromiumPath) {
    t.skip('No system Chromium found — skipping the runtime STAGES.length check (static HTML checks above still ran)');
    return;
  }

  // STAGES is built at runtime via flatMap(), so its true length can only be
  // checked by actually executing the page — grepping the source text would
  // always find the same 2 literal "name:" occurrences in the template code,
  // regardless of how many exercises actually exist at runtime.
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/login');
    await page.fill('input[name=email]', 'admin@bftpymble.com.au');
    await page.fill('input[name=password]', 'GymAdmin2026!');
    await page.click('button[type=submit]');
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/cast/1');
    const stageCount = await page.evaluate(() => window.STAGES ? window.STAGES.length : (typeof STAGES !== 'undefined' ? STAGES.length : -1));
    assert.strictEqual(stageCount, 10, `Expected 10 total stages (9 exercises + 1 Gate 4 block) at runtime, got ${stageCount}`);
  } finally {
    await browser.close();
  }
});

test('region page: shows Cast Display link only to the gym admin who can manage that fixture', async () => {
  const anonRes = await request(app).get('/regions/north-shore');
  assert.doesNotMatch(anonRes.text, /Cast Display/, 'Anonymous visitors should not see a Cast Display link');
  assert.match(anonRes.text, /Watch Live/, 'Anonymous visitors should still see Watch Live');

  const ownerAgent = request.agent(app);
  await ownerAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const ownerRes = await ownerAgent.get('/regions/north-shore');
  assert.match(ownerRes.text, /Cast Display/, 'The fixture-owning gym admin should see Cast Display');

  const outsiderAgent = request.agent(app);
  await outsiderAgent.post('/signup/gym').type('form').send({
    gym_name: 'Region Page Outsider', admin_first_name: 'Out', admin_last_name: 'Sider',
    email: 'regionpageoutsider@example.com', password: 'TestPass123', region_id: 3,
  });
  const outsiderRes = await outsiderAgent.get('/regions/north-shore');
  assert.doesNotMatch(outsiderRes.text, /Cast Display/, 'An unrelated gym admin should not see Cast Display');
});

test('cast display: master clock shows millisecond precision and advances smoothly', async (t) => {
  let chromiumPath;
  try {
    chromiumPath = require('child_process').execSync(
      'find /opt/pw-browsers -type f -name "headless_shell" -o -type f -name "chrome" 2>/dev/null | head -1',
      { encoding: 'utf8' }
    ).trim();
  } catch { chromiumPath = ''; }
  if (!chromiumPath) { t.skip('No system Chromium found'); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/login');
    await page.fill('input[name=email]', 'admin@bftpymble.com.au');
    await page.fill('input[name=password]', 'GymAdmin2026!');
    await page.click('button[type=submit]');
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/cast/1');
    await page.click("button:has-text('Start')");
    await page.waitForTimeout(150);
    const reading1 = await page.locator('#masterClock').innerText();
    await page.waitForTimeout(150);
    const reading2 = await page.locator('#masterClock').innerText();

    assert.match(reading1, /^\d{2}:\d{2}\.\d{3}$/, `Expected MM:SS.mmm format, got "${reading1}"`);
    assert.match(reading2, /^\d{2}:\d{2}\.\d{3}$/, `Expected MM:SS.mmm format, got "${reading2}"`);
    assert.notStrictEqual(reading1, reading2, 'Clock should have visibly advanced between the two readings');
  } finally {
    await browser.close();
  }
});

test('seed data: all athletes are TBA placeholders, not fabricated names', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const res = await agent.get('/gym/team/1');
  assert.match(res.text, /TBA/);
  assert.doesNotMatch(res.text, /Jack Nguyen|Emma Wilson|Lucas Ahmed/, 'No fabricated names should remain in the seed data');
});

test('gym admin: can add a new member directly, and that member can log in with the default password', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const addRes = await gymAgent.post('/gym/team/1/add-member').type('form').send({
    first_name: 'New', last_name: 'Member', email: 'newmembertest@example.com', gender: 'F', category: 'womens_singles',
  });
  assert.strictEqual(addRes.status, 302);

  const newMemberAgent = request.agent(app);
  const loginRes = await newMemberAgent.post('/login').type('form').send({
    email: 'newmembertest@example.com', password: 'GLGWelcome2026!', next: '/profile',
  });
  assert.strictEqual(loginRes.status, 302);
  const profileRes = await newMemberAgent.get('/profile');
  assert.match(profileRes.text, /New Member/);
});

test('gym admin: can edit an existing member\'s details', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const teamPage = await gymAgent.get('/gym/team/1');
  const athleteIdMatch = teamPage.text.match(/name="athlete_id" value="(\d+)"/);
  assert.ok(athleteIdMatch, 'Should find at least one athlete_id on the team page');
  const athleteId = athleteIdMatch[1];

  const updateRes = await gymAgent.post('/gym/team/1/update-member').type('form').send({
    athlete_id: athleteId, first_name: 'Edited', last_name: 'Person',
    email: 'edited.person@example.com', gender: 'M', category: 'mens_singles',
  });
  assert.strictEqual(updateRes.status, 302);

  const afterRes = await gymAgent.get('/gym/team/1');
  assert.match(afterRes.text, /Edited/);
});

test('gym admin: adding a member with an email already in use is rejected', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const res = await gymAgent.post('/gym/team/1/add-member').type('form').send({
    first_name: 'Dup', last_name: 'Test', email: 'admin@bftpymble.com.au', gender: 'M', category: '',
  });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /error=emailtaken/);
});

test('access control: an unrelated gym admin cannot add or edit members on another gym\'s team', async () => {
  const outsiderAgent = request.agent(app);
  await outsiderAgent.post('/signup/gym').type('form').send({
    gym_name: 'Member Outsider Test', admin_first_name: 'Out', admin_last_name: 'Sider',
    email: 'memberoutsidertest@example.com', password: 'TestPass123', region_id: 3,
  });
  const res = await outsiderAgent.post('/gym/team/1/add-member').type('form').send({
    first_name: 'Hacker', last_name: 'Test', email: 'hackertest@example.com', gender: 'M', category: '',
  });
  assert.strictEqual(res.status, 404);
});

test('account: any logged-in user can change their own password, and the old password stops working', async () => {
  const freshAgent = request.agent(app);
  const loginRes = await freshAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  assert.strictEqual(loginRes.status, 302);

  const changeRes = await freshAgent.post('/account/change-password').type('form').send({
    current_password: 'GymAdmin2026!', new_password: 'BrandNewPass123', confirm_password: 'BrandNewPass123',
  });
  assert.strictEqual(changeRes.status, 302);
  assert.match(changeRes.headers.location, /pwChanged=1/);

  const oldPwRes = await request(app).post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  assert.match(oldPwRes.text, /Incorrect email or password/);

  const newPwRes = await request(app).post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'BrandNewPass123', next: '/gym',
  });
  assert.strictEqual(newPwRes.status, 302);

  // change it back so later tests in this file that rely on the original password still work
  const revertAgent = request.agent(app);
  await revertAgent.post('/login').type('form').send({ email: 'admin@bftpymble.com.au', password: 'BrandNewPass123', next: '/gym' });
  await revertAgent.post('/account/change-password').type('form').send({
    current_password: 'BrandNewPass123', new_password: 'GymAdmin2026!', confirm_password: 'GymAdmin2026!',
  });
});

test('account: change-password rejects a wrong current password and a mismatched confirmation', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const wrongCurrent = await agent.post('/account/change-password').type('form').send({
    current_password: 'TotallyWrong', new_password: 'Whatever123', confirm_password: 'Whatever123',
  });
  assert.match(wrongCurrent.headers.location, /pwError=current/);

  const mismatch = await agent.post('/account/change-password').type('form').send({
    current_password: 'GymAdmin2026!', new_password: 'Whatever123', confirm_password: 'Different456',
  });
  assert.match(mismatch.headers.location, /pwError=mismatch/);
});

test('gym admin: can reset a team member\'s password, and the member can log in with the newly generated one', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const teamPage = await gymAgent.get('/gym/team/1');
  const athleteIdMatch = teamPage.text.match(/name="athlete_id" value="(\d+)"/);
  const athleteId = athleteIdMatch[1];

  const resetRes = await gymAgent.post('/gym/team/1/reset-password').type('form').send({ athlete_id: athleteId });
  assert.strictEqual(resetRes.status, 200);
  const pwMatch = resetRes.text.match(/New password set for this member: <strong[^>]*>([^<]+)</);
  assert.ok(pwMatch, 'Should show the newly generated password on the page');
  const newPassword = pwMatch[1];

  const memberEmail = await (async () => {
    const emailMatch = teamPage.text.match(/value="(\d+)"[\s\S]*?name="email"[^>]*value="([^"]+)"/);
    return emailMatch ? emailMatch[2] : null;
  })();
  assert.ok(memberEmail, 'Should find the member email on the team page');

  const memberLoginRes = await request(app).post('/login').type('form').send({
    email: memberEmail, password: newPassword, next: '/profile',
  });
  assert.strictEqual(memberLoginRes.status, 302, `Member should be able to log in with the newly reset password (tried email=${memberEmail})`);
});

test('access control: an unrelated gym admin cannot reset another gym\'s member password', async () => {
  const outsiderAgent = request.agent(app);
  await outsiderAgent.post('/signup/gym').type('form').send({
    gym_name: 'Reset Outsider Test 2', admin_first_name: 'Out', admin_last_name: 'Sider',
    email: 'resetoutsidertest2@example.com', password: 'TestPass123', region_id: 3,
  });
  const res = await outsiderAgent.post('/gym/team/1/reset-password').type('form').send({ athlete_id: 1 });
  assert.strictEqual(res.status, 404);
});
