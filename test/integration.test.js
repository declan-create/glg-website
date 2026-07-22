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
const db = require('../db'); // same connection as the app (GLG_DB_PATH is already set above)

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

test('judge: assigned to a category via gym admin, then can log in and access only that category', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const assignRes = await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_email: 'judge1@gymleagueglobal.com.au', category: 'mens_singles',
  });
  assert.strictEqual(assignRes.status, 302);

  const judgeAgent = request.agent(app);
  await judgeAgent.post('/login').type('form').send({
    email: 'judge1@gymleagueglobal.com.au', password: 'Judge2026!', next: '/judge',
  });
  const dashboard = await judgeAgent.get('/judge');
  assert.strictEqual(dashboard.status, 200);
  assert.match(dashboard.text, /Men(&#39;|')s Singles/);

  const allowedCat = await judgeAgent.get('/judge/fixture/1/category/mens_singles');
  assert.strictEqual(allowedCat.status, 200);
  // their entry page covers ALL gates for their category
  assert.match(allowedCat.text, /Gate 1/);
  assert.match(allowedCat.text, /Gate 4/);

  const blockedCat = await judgeAgent.get('/judge/fixture/1/category/womens_singles');
  assert.strictEqual(blockedCat.status, 403);
});

test('judge: submitting a score for their assigned category works and other categories are blocked or ignored', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_email: 'judge2@gymleagueglobal.com.au', category: 'womens_singles',
  });

  const judgeAgent = request.agent(app);
  await judgeAgent.post('/login').type('form').send({
    email: 'judge2@gymleagueglobal.com.au', password: 'Judge2026!', next: '/judge',
  });

  const submitRes = await judgeAgent.post('/judge/fixture/1/category/womens_singles').type('form').send({
    result_1_1_womens_singles: '900', // benchmark 800, should score 2pts if it beats the opponent too
    result_2_1_womens_singles: '850',
    result_1_1_mens_singles: '999', // NOT their category — must be silently ignored, not written
  });
  assert.strictEqual(submitRes.status, 302);

  // the sneaky cross-category value must not have been written
  const crossRow = db.prepare(
    "SELECT * FROM category_results WHERE fixture_id=1 AND exercise_id=1 AND team_id=1 AND category='mens_singles' AND raw_value=999"
  ).get();
  assert.strictEqual(crossRow, undefined, 'A category judge must not be able to write another category\'s results');

  // blocked entirely from a category route they aren't assigned to
  const blockedSubmit = await judgeAgent.post('/judge/fixture/1/category/mens_singles').type('form').send({
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
    const runtime = await page.evaluate(() => ({
      stageCount: (typeof STAGES !== 'undefined') ? STAGES.length : -1,
      gate4Name: (typeof GATE4_NAME !== 'undefined') ? GATE4_NAME : null,
      gates123Sec: (typeof GATES123_SEC !== 'undefined') ? GATES123_SEC : -1,
    }));
    assert.strictEqual(runtime.stageCount, 9, `Expected 9 timed stages (Gates 1-3 only; Gate 4 is open-ended), got ${runtime.stageCount}`);
    assert.match(runtime.gate4Name || '', /Gate 4: Sprint Finish/, 'Gate 4 should exist as a separate open-ended stage');
    assert.strictEqual(runtime.gates123Sec, 9 * 5 * 60, 'Gates 1-3 should total 45 minutes of timed stages');
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

test('judge assignment: creates a new judge account on the fly and lets them log in immediately', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const assignRes = await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_first_name: 'Test', judge_last_name: 'Judge', judge_phone: '0400 000 111',
    judge_email: 'newjudgetest@example.com', category: 'mens_doubles',
  });
  assert.strictEqual(assignRes.status, 302);
  assert.match(assignRes.headers.location, /judgeAssigned=1/);

  const judgeAgent = request.agent(app);
  const loginRes = await judgeAgent.post('/login').type('form').send({
    email: 'newjudgetest@example.com', password: 'GLGWelcome2026!', next: '/judge',
  });
  assert.strictEqual(loginRes.status, 302);
  const dashRes = await judgeAgent.get('/judge');
  assert.match(dashRes.text, /Men(&#39;|')s Doubles/);
});

test('judge assignment: reassigning the same email does not create a duplicate account', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_first_name: 'Dup', judge_email: 'duplicatejudgetest@example.com', category: 'mens_singles',
  });
  const secondAssign = await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_email: 'duplicatejudgetest@example.com', category: 'womens_singles',
  });
  assert.strictEqual(secondAssign.status, 302);

  const dashRes = await gymAgent.get('/fixture/1/results');
  const occurrences = (dashRes.text.match(/duplicatejudgetest@example\.com/g) || []).length;
  assert.strictEqual(occurrences, 2, 'Should appear twice (once per category assignment), from one account — not a duplicate account');
});

test('live counter: page loads for assigned category and its save API writes + recomputes', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_first_name: 'Live', judge_email: 'livejudge@example.com', category: 'mixed_doubles',
  });

  const judgeAgent = request.agent(app);
  await judgeAgent.post('/login').type('form').send({
    email: 'livejudge@example.com', password: 'GLGWelcome2026!', next: '/judge',
  });

  const page = await judgeAgent.get('/judge/fixture/1/category/mixed_doubles/live');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /tap anywhere|FINISHED|Live/i);

  // blocked from another category's live page
  const blockedPage = await judgeAgent.get('/judge/fixture/1/category/mens_singles/live');
  assert.strictEqual(blockedPage.status, 403);

  // tap-save API writes a result and recompute assigns points
  const save = await judgeAgent
    .post('/api/judge/fixture/1/category/mixed_doubles/result')
    .send({ exercise_id: 2, team_id: 1, raw_value: 61 }); // TBDL, mixed benchmark 30+30=60 -> benchmark met
  assert.strictEqual(save.status, 200);
  assert.strictEqual(save.body.ok, true);
  assert.strictEqual(save.body.results['1'].benchmark_met, 1);

  // cross-category write through the API is rejected outright
  const blockedSave = await judgeAgent
    .post('/api/judge/fixture/1/category/mens_singles/result')
    .send({ exercise_id: 2, team_id: 1, raw_value: 999 });
  assert.strictEqual(blockedSave.status, 403);

  // sprint-finish exercises can't be written through the per-exercise endpoint
  const sprintEx = db.prepare(
    "SELECT e.id FROM exercises e JOIN gates g ON g.id=e.gate_id WHERE g.is_sprint_finish=1 LIMIT 1"
  ).get();
  const badEx = await judgeAgent
    .post('/api/judge/fixture/1/category/mixed_doubles/result')
    .send({ exercise_id: sprintEx.id, team_id: 1, raw_value: 10 });
  assert.strictEqual(badEx.status, 400);

  // clean up the score written above so later tests start from an empty board
  db.prepare("DELETE FROM category_results WHERE fixture_id=1 AND category='mixed_doubles'").run();
  require('../scoring').recomputeFixtureScores(1);
});

test('live counter: Gate 4 finish stamp records completion + time and undo clears it', async () => {
  const judgeAgent = request.agent(app);
  await judgeAgent.post('/login').type('form').send({
    email: 'livejudge@example.com', password: 'GLGWelcome2026!', next: '/judge',
  });

  const stamp = await judgeAgent
    .post('/api/judge/fixture/1/category/mixed_doubles/gate4')
    .send({ team_id: 1, completed: 1, total_time_sec: 512.4 });
  assert.strictEqual(stamp.status, 200);
  assert.strictEqual(stamp.body.gate4['1'].completed, 1);
  assert.strictEqual(stamp.body.gate4['1'].total_time_sec, 512.4);
  assert.strictEqual(stamp.body.gate4['1'].points, 6, 'Only completer so far: 3 for completing + 3 for fastest');

  const undo = await judgeAgent
    .post('/api/judge/fixture/1/category/mixed_doubles/gate4')
    .send({ team_id: 1, completed: 0, total_time_sec: null });
  assert.strictEqual(undo.status, 200);
  assert.strictEqual(undo.body.gate4['1'].completed, 0);
  assert.strictEqual(undo.body.gate4['1'].points, 0);

  // remove the row entirely so later tests see a completely untouched board
  db.prepare("DELETE FROM category_gate4_results WHERE fixture_id=1 AND category='mixed_doubles'").run();
  require('../scoring').recomputeFixtureScores(1);
});

test('password fields ship with the show/hide (eye) toggle script', async () => {
  const res = await request(app).get('/login');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Show password/, 'Login page should include the password visibility toggle');
});

test('judge assignment: rejects assigning an email that belongs to a non-judge account', async () => {
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  // Use the gym admin's own email — guaranteed to exist and stay non-judge
  // throughout the run, unlike a TBA placeholder another test might rename.
  const res = await gymAgent.post('/fixture/1/assign-judge').type('form').send({
    judge_first_name: 'Should', judge_email: 'admin@bftpymble.com.au', category: 'mens_singles',
  });
  assert.match(res.headers.location, /judgeError=notjudge/);
});

test('phone number: captured correctly on athlete sign-up and editable via gym admin member management', async () => {
  const athleteAgent = request.agent(app);
  const signupRes = await athleteAgent.post('/signup/athlete').type('form').send({
    first_name: 'Phone', last_name: 'CheckTest', email: 'phonechecktest@example.com',
    password: 'TestPass123', gender: 'F', phone: '0455 999 888', region_id: 3, team_choice: 'assign',
  });
  assert.strictEqual(signupRes.status, 302);
  const profileRes = await athleteAgent.get('/profile');
  assert.match(profileRes.text, /0455 999 888/);

  // gym admin editing a member's phone
  const gymAgent = request.agent(app);
  await gymAgent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const teamPage = await gymAgent.get('/gym/team/1');
  const athleteIdMatch = teamPage.text.match(/name="athlete_id" value="(\d+)"/);
  const athleteId = athleteIdMatch[1];
  const updateRes = await gymAgent.post('/gym/team/1/update-member').type('form').send({
    athlete_id: athleteId, first_name: 'Phone', last_name: 'Edited',
    email: 'phoneeditedtest@example.com', phone: '0466 777 555', gender: 'M', category: 'mens_singles',
  });
  assert.strictEqual(updateRes.status, 302);
  const afterRes = await gymAgent.get('/gym/team/1');
  assert.match(afterRes.text, /0466 777 555/);
});

test('account page: gym admin can update their own phone number', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
  });
  const res = await agent.post('/account/update-details').type('form').send({
    first_name: 'BFT', last_name: 'Admin', phone: '0499 222 333',
  });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /detailsSaved=1/);
  const accountRes = await agent.get('/account');
  assert.match(accountRes.text, /0499 222 333/);
});

test('live scores: an already-open watch page picks up a newly submitted score without reloading', async (t) => {
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
    await page.goto('http://localhost:' + PORT_UNDER_TEST + '/watch/1');
    await page.waitForTimeout(500);

    const before = await page.locator('.cat-scores[data-cat="mixed_doubles"]').innerText();

    const agent = request.agent(app);
    await agent.post('/login').type('form').send({
      email: 'admin@bftpymble.com.au', password: 'GymAdmin2026!', next: '/gym',
    });
    await agent.post('/fixture/1/results').type('form').send({
      result_1_1_mixed_doubles: '1700', result_2_1_mixed_doubles: '1650',
    });

    await page.waitForTimeout(4000); // longer than the 3s poll interval — no reload
    const after = await page.locator('.cat-scores[data-cat="mixed_doubles"]').innerText();

    assert.strictEqual(before, '', 'Should show no score before the result is submitted');
    assert.notStrictEqual(after, '', 'Should show a live score after the result is submitted, without reloading');
    assert.match(after, /\d+\s*–\s*\d+/, `Expected a "points – points" score line, got "${after}"`);
  } finally {
    await browser.close();
  }
});
