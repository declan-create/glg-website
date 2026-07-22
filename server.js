const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const scoring = require('./scoring');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers. CSP relaxed for inline styles/scripts used throughout the
// EJS views (no external script sources are loaded, so this stays reasonably tight).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // allows onclick/onchange/onsubmit attributes used throughout the views —
                                          // helmet blocks these by default even when scriptSrc allows inline <script> tags,
                                          // which silently broke every button on the Cast Display and several other pages.
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
    },
  },
}));

// Rate limit login and every sign-up form to blunt credential-stuffing / spam
// sign-ups. Generous enough not to bother a genuine user who mistypes a
// password a couple of times.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // generous enough for many people signing up/logging in from the same shared venue WiFi during a live event
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts from this device — please wait 15 minutes and try again.',
});

// ---- lightweight input validation (no external dependency needed for this scope) ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) { return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim()); }
function isReasonableLength(str, max = 200) { return typeof str === 'string' && str.trim().length > 0 && str.trim().length <= max; }
function isOptionalReasonableLength(str, max = 200) { return typeof str === 'string' && str.trim().length <= max; } // allows empty (e.g. single-name people)
function isValidPassword(pw) { return typeof pw === 'string' && pw.length >= 6 && pw.length <= 200; }

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const fs = require('fs');

app.use(session({
  store: (() => {
    const sessionsPath = process.env.GLG_SESSIONS_PATH || path.join(__dirname, 'sessions');
    fs.mkdirSync(sessionsPath, { recursive: true }); // ensure it exists on any host — empty folders don't survive git
    return new FileStore({ path: sessionsPath });
  })(),
  secret: process.env.SESSION_SECRET || 'glg-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
}));

// ---- make current user + flash-ish messages available in all views ----
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.query = req.query;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { title: 'Access Denied', message: "You don't have permission to view this page.", layout: 'layout' });
    }
    next();
  };
}

const CATEGORY_LABEL = {
  mens_singles: "Men's Singles", womens_singles: "Women's Singles",
  mens_doubles: "Men's Doubles", womens_doubles: "Women's Doubles", mixed_doubles: "Mixed Doubles",
};

// ============ PUBLIC ROUTES ============

app.get('/', (req, res) => {
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' ORDER BY status='active' DESC, name").all();
  res.render('home', { title: 'Gym League Global', regions });
});

app.get('/regions', (req, res) => {
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' ORDER BY status='active' DESC, name").all();
  res.render('regions', { title: 'Find Your Region', regions });
});

app.get('/regions/:slug', (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE slug=?").get(req.params.slug);
  if (!region) return res.status(404).render('error', { title: 'Not Found', message: 'Region not found.' });
  const teams = db.prepare("SELECT t.*, g.name as gym_name FROM teams t JOIN gyms g ON g.id=t.gym_id WHERE t.region_id=?").all(region.id);
  const fixtures = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
    WHERE f.region_id=? ORDER BY f.week`).all(region.id);
  fixtures.forEach(f => { f.canManage = canManageFixture(req.session.user, f); });
  const leaderboard = scoring.getSeasonLeaderboard(region.id);
  res.render('region-detail', { title: region.name, region, teams, fixtures, leaderboard });
});

// ---- Guides ----
app.get('/guide/participant', (req, res) => res.render('guide-participant', { title: 'Participant Guide' }));
app.get('/guide/gym', (req, res) => res.render('guide-gym', { title: 'Gym Operator Guide' }));
app.get('/guide/league', (req, res) => res.render('guide-league', { title: 'League Franchise Guide' }));

// ============ AUTH ============

app.get('/login', (req, res) => res.render('login', { title: 'Log In', error: null, next: req.query.next || '/' }));

app.post('/login', authLimiter, (req, res) => {
  const { email, password, next } = req.body;
  if (!isValidEmail(email) || typeof password !== 'string' || password.length === 0) {
    return res.render('login', { title: 'Log In', error: 'Please enter a valid email and password.', next: next || '/' });
  }
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { title: 'Log In', error: 'Incorrect email or password.', next: next || '/' });
  }
  if (user.role === 'league_operator' && !user.approved) {
    return res.render('login', { title: 'Log In', error: 'Your league operator application is still pending approval.', next: '/' });
  }
  req.session.user = { id: user.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name };
  const dest = next && next !== 'undefined' ? next : roleHome(user.role);
  res.redirect(dest);
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

function roleHome(role) {
  if (role === 'admin') return '/admin';
  if (role === 'gym_admin') return '/gym';
  if (role === 'league_operator') return '/league';
  if (role === 'judge') return '/judge';
  return '/profile';
}

// ---- Athlete signup ----
app.get('/signup/athlete', (req, res) => {
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' AND status='active'").all();
  res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: null, step: 1 });
});

app.post('/signup/athlete', authLimiter, (req, res) => {
  const { first_name, last_name, email, password, gender, dob, phone, region_id, team_choice, team_id } = req.body;
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' AND status='active'").all();

  if (!isReasonableLength(first_name, 80) || !isReasonableLength(last_name, 80)) {
    return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'Please enter a valid first and last name.', step: 1 });
  }
  if (!isValidEmail(email)) {
    return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'Please enter a valid email address.', step: 1 });
  }
  if (!isValidPassword(password)) {
    return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'Password must be at least 6 characters.', step: 1 });
  }
  if (gender !== 'M' && gender !== 'F') {
    return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'Please select a gender.', step: 1 });
  }
  const regionValid = regions.some(r => String(r.id) === String(region_id));
  if (!regionValid) {
    return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'Please select a valid region.', step: 1 });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email.trim().toLowerCase());
  if (existing) {
    return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'An account with that email already exists.', step: 1 });
  }

  const hash = bcrypt.hashSync(password, 10);
  const uid = db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,gender,dob,phone) VALUES (?,?,?,?,?,?,?,?)`)
    .run(email.trim().toLowerCase(), hash, 'athlete', first_name.trim(), last_name.trim(), gender, dob || null, (phone || '').trim() || null).lastInsertRowid;

  const wantsTeam = team_choice === 'assign' ? 1 : 0;
  const chosenTeamId = team_choice === 'pick' && team_id ? team_id : null;
  db.prepare(`INSERT INTO athletes (user_id, region_id, team_id, wants_team) VALUES (?,?,?,?)`)
    .run(uid, region_id, chosenTeamId, wantsTeam);

  req.session.user = { id: uid, email: email.trim().toLowerCase(), role: 'athlete', first_name: first_name.trim(), last_name: last_name.trim() };
  res.redirect('/profile?welcome=1');
});

// endpoint used by the signup form to load teams for a chosen region (AJAX)
app.get('/api/regions/:id/teams', (req, res) => {
  const teams = db.prepare("SELECT id, name FROM teams WHERE region_id=? ORDER BY name").all(req.params.id);
  res.json(teams);
});

// ---- Gym signup ----
app.get('/signup/gym', (req, res) => {
  const regions = db.prepare("SELECT * FROM regions WHERE level='region'").all();
  res.render('signup-gym', { title: 'Gym / Club Sign Up', regions, error: null });
});

app.post('/signup/gym', authLimiter, (req, res) => {
  const { gym_name, admin_first_name, admin_last_name, email, password, phone, region_id, address, team_names } = req.body;
  const regions = db.prepare("SELECT * FROM regions WHERE level='region'").all();

  if (!isReasonableLength(gym_name, 120)) {
    return res.render('signup-gym', { title: 'Gym / Club Sign Up', regions, error: 'Please enter your gym or club name.' });
  }
  if (!isValidEmail(email)) {
    return res.render('signup-gym', { title: 'Gym / Club Sign Up', regions, error: 'Please enter a valid email address.' });
  }
  if (!isValidPassword(password)) {
    return res.render('signup-gym', { title: 'Gym / Club Sign Up', regions, error: 'Password must be at least 6 characters.' });
  }
  const regionValid = regions.some(r => String(r.id) === String(region_id));
  if (!regionValid) {
    return res.render('signup-gym', { title: 'Gym / Club Sign Up', regions, error: 'Please select a valid region.' });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email.trim().toLowerCase());
  if (existing) {
    return res.render('signup-gym', { title: 'Gym / Club Sign Up', regions, error: 'An account with that email already exists.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const uid = db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,phone) VALUES (?,?,?,?,?,?)`)
    .run(email.trim().toLowerCase(), hash, 'gym_admin', (admin_first_name || gym_name).trim().slice(0,80), (admin_last_name || '').trim().slice(0,80), (phone || '').trim() || null).lastInsertRowid;

  const gymId = db.prepare(`INSERT INTO gyms (name, region_id, admin_user_id, address) VALUES (?,?,?,?)`)
    .run(gym_name.trim().slice(0,120), region_id, uid, address ? address.trim().slice(0,200) : null).lastInsertRowid;

  // Allow comma-separated team names, creating 1+ teams at signup (flexibility: 1 gym -> many teams).
  // Capped at 20 teams and 80 chars per name at signup time to prevent abuse — more can be added later from the dashboard.
  const names = (team_names || gym_name + ' Team A').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  for (const n of names) {
    db.prepare(`INSERT INTO teams (name, gym_id, region_id) VALUES (?,?,?)`).run(n.slice(0,80), gymId, region_id);
  }

  req.session.user = { id: uid, email: email.trim().toLowerCase(), role: 'gym_admin', first_name: admin_first_name, last_name: admin_last_name };
  res.redirect('/gym?welcome=1');
});

// ---- League Franchise Operator application ----
app.get('/signup/league', (req, res) => {
  res.render('signup-league', { title: 'Apply to Run a Region', error: null, success: false });
});

app.post('/signup/league', authLimiter, (req, res) => {
  const { first_name, last_name, email, password, phone, proposed_region, pitch } = req.body;
  if (!isReasonableLength(first_name, 80) || !isReasonableLength(last_name, 80)) {
    return res.render('signup-league', { title: 'Apply to Run a Region', error: 'Please enter a valid first and last name.', success: false });
  }
  if (!isValidEmail(email)) {
    return res.render('signup-league', { title: 'Apply to Run a Region', error: 'Please enter a valid email address.', success: false });
  }
  if (!isValidPassword(password)) {
    return res.render('signup-league', { title: 'Apply to Run a Region', error: 'Password must be at least 6 characters.', success: false });
  }
  if (!isReasonableLength(proposed_region, 120)) {
    return res.render('signup-league', { title: 'Apply to Run a Region', error: 'Please tell us which region you\'re proposing.', success: false });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email.trim().toLowerCase());
  if (existing) {
    return res.render('signup-league', { title: 'Apply to Run a Region', error: 'An account with that email already exists.', success: false });
  }
  const hash = bcrypt.hashSync(password, 10);
  const safePitch = (pitch || '').trim().slice(0, 2000);
  db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,phone,bio,approved) VALUES (?,?,?,?,?,?,?,0)`)
    .run(email.trim().toLowerCase(), hash, 'league_operator', first_name.trim().slice(0,80), last_name.trim().slice(0,80), (phone || '').trim() || null, `Proposed region: ${proposed_region.trim().slice(0,120)}\n\n${safePitch}`);
  res.render('signup-league', { title: 'Apply to Run a Region', error: null, success: true });
});

// ============ ATHLETE PROFILE ============

app.get('/profile', requireLogin, (req, res) => {
  if (req.session.user.role !== 'athlete') return res.redirect(roleHome(req.session.user.role));
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  const athlete = db.prepare("SELECT * FROM athletes WHERE user_id=?").get(user.id);
  const team = athlete.team_id ? db.prepare("SELECT t.*, g.name as gym_name FROM teams t JOIN gyms g ON g.id=t.gym_id WHERE t.id=?").get(athlete.team_id) : null;
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(athlete.region_id);

  // personal stats history — joined via the athlete's category, since scoring is
  // recorded per category (their own result if singles, their pair's shared
  // result if doubles/mixed). Individual raw effort is always visible here,
  // independent of how the match's points landed.
  const history = athlete.category ? db.prepare(`
    SELECT cr.raw_value, cr.points, cr.recorded_at, e.name as exercise_name, e.unit, f.week
    FROM category_results cr
    JOIN exercises e ON e.id=cr.exercise_id
    JOIN fixtures f ON f.id=cr.fixture_id
    WHERE cr.team_id=? AND cr.category=? ORDER BY f.week DESC
  `).all(athlete.team_id, athlete.category) : [];

  res.render('profile', { title: 'My Profile', user, athlete, team, region, history, welcome: req.query.welcome });
});

app.post('/profile', requireLogin, (req, res) => {
  const { first_name, last_name, phone, bio } = req.body;
  db.prepare("UPDATE users SET first_name=?, last_name=?, phone=?, bio=? WHERE id=?")
    .run(first_name, last_name, phone, bio, req.session.user.id);
  req.session.user.first_name = first_name;
  req.session.user.last_name = last_name;
  res.redirect('/profile?saved=1');
});

// ============ ACCOUNT (change password — available to every role) ============
// Athletes get a richer page at /profile already; everyone else lands here.
// This closes the "no password reset" gap without needing email infrastructure:
// anyone logged in can change their own password directly, and (see the gym
// team routes) a gym admin can reset a member's password on their behalf.
app.get('/account', requireLogin, (req, res) => {
  if (req.session.user.role === 'athlete') return res.redirect('/profile');
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  res.render('account', { title: 'My Account', user, query: req.query });
});

app.post('/account/update-details', requireLogin, (req, res) => {
  const { first_name, last_name, phone } = req.body;
  const backTo = req.session.user.role === 'athlete' ? '/profile' : '/account';
  if (!isReasonableLength(first_name, 80) || !isOptionalReasonableLength(last_name, 80)) {
    return res.redirect(backTo + '?detailsError=name');
  }
  db.prepare("UPDATE users SET first_name=?, last_name=?, phone=? WHERE id=?")
    .run(first_name.trim(), (last_name || '').trim(), (phone || '').trim() || null, req.session.user.id);
  req.session.user.first_name = first_name.trim();
  req.session.user.last_name = (last_name || '').trim();
  res.redirect(backTo + '?detailsSaved=1');
});

app.post('/account/change-password', requireLogin, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  const backTo = req.session.user.role === 'athlete' ? '/profile' : '/account';

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.redirect(backTo + '?pwError=current');
  }
  if (!isValidPassword(new_password)) {
    return res.redirect(backTo + '?pwError=length');
  }
  if (new_password !== confirm_password) {
    return res.redirect(backTo + '?pwError=mismatch');
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, user.id);
  res.redirect(backTo + '?pwChanged=1');
});

// ============ GYM ADMIN DASHBOARD ============

app.get('/gym', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const teams = db.prepare("SELECT * FROM teams WHERE gym_id=?").all(gym.id);
  const teamIds = teams.map(t => t.id);
  const rosterCounts = {};
  for (const t of teams) {
    rosterCounts[t.id] = db.prepare("SELECT COUNT(*) c FROM athletes WHERE team_id=?").get(t.id).c;
  }
  // unassigned pool in this gym's region
  const pool = db.prepare(`
    SELECT a.id as athlete_id, u.first_name, u.last_name, u.gender, u.email
    FROM athletes a JOIN users u ON u.id=a.user_id
    WHERE a.region_id=? AND a.team_id IS NULL AND a.wants_team=1
  `).all(gym.region_id);

  res.render('gym-dashboard', { title: gym.name, gym, teams, rosterCounts, pool, welcome: req.query.welcome });
});

app.post('/gym/teams/new', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const { name, division } = req.body;
  if (name && name.trim()) {
    db.prepare("INSERT INTO teams (name, gym_id, region_id, division) VALUES (?,?,?,?)")
      .run(name.trim(), gym.id, gym.region_id, division || 'Open');
  }
  res.redirect('/gym');
});

app.post('/gym/pool/assign', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const { athlete_id, team_id } = req.body;
  // verify the team belongs to this gym
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(team_id, gym.id);
  if (team) {
    db.prepare("UPDATE athletes SET team_id=?, wants_team=0 WHERE id=?").run(team_id, athlete_id);
  }
  res.redirect('/gym');
});

app.get('/gym/team/:id', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(req.params.id, gym.id);
  if (!team) return res.status(404).render('error', { title: 'Not Found', message: 'Team not found.' });
  const roster = db.prepare(`
    SELECT a.id as athlete_id, u.first_name, u.last_name, u.gender, u.email, u.phone, a.category
    FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=?`).all(team.id);
  res.render('gym-team-detail', { title: team.name, team, roster, gym, resetPasswordFor: null, newPassword: null });
});

app.post('/gym/team/:id/remove-athlete', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(req.params.id, gym.id);
  if (team) {
    db.prepare("UPDATE athletes SET team_id=NULL, wants_team=1, category=NULL WHERE id=? AND team_id=?").run(req.body.athlete_id, team.id);
  }
  res.redirect('/gym/team/' + req.params.id);
});

app.post('/gym/team/:id/update-member', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(req.params.id, gym.id);
  if (!team) return res.status(404).render('error', { title: 'Not Found', message: 'Team not found.' });

  const { athlete_id, first_name, last_name, email, phone, gender, category } = req.body;
  const validCategories = ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles', ''];
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND team_id=?").get(athlete_id, team.id);
  if (!athlete) return res.redirect('/gym/team/' + req.params.id + '?error=notfound');

  if (!isReasonableLength(first_name, 80) || !isOptionalReasonableLength(last_name, 80)) {
    return res.redirect('/gym/team/' + req.params.id + '?error=name');
  }
  if (!isValidEmail(email)) {
    return res.redirect('/gym/team/' + req.params.id + '?error=email');
  }
  const existingEmail = db.prepare("SELECT id FROM users WHERE email=? AND id!=(SELECT user_id FROM athletes WHERE id=?)").get(email.trim().toLowerCase(), athlete_id);
  if (existingEmail) {
    return res.redirect('/gym/team/' + req.params.id + '?error=emailtaken');
  }
  if (gender !== 'M' && gender !== 'F') {
    return res.redirect('/gym/team/' + req.params.id + '?error=gender');
  }
  if (!validCategories.includes(category)) {
    return res.redirect('/gym/team/' + req.params.id + '?error=category');
  }

  db.prepare("UPDATE users SET first_name=?, last_name=?, email=?, gender=?, phone=? WHERE id=?")
    .run(first_name.trim(), last_name.trim(), email.trim().toLowerCase(), gender, (phone || '').trim() || null, athlete.user_id);
  db.prepare("UPDATE athletes SET category=? WHERE id=?").run(category || null, athlete_id);

  res.redirect('/gym/team/' + req.params.id + '?saved=1');
});

// Gym admin directly creates a new member on their team — for people who
// haven't signed up themselves yet. A default password is set; the gym
// should let the athlete know it so they can log in (no email/reset
// infrastructure is wired up yet — see README).
app.post('/gym/team/:id/add-member', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(req.params.id, gym.id);
  if (!team) return res.status(404).render('error', { title: 'Not Found', message: 'Team not found.' });

  const { first_name, last_name, email, phone, gender, category } = req.body;
  const validCategories = ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles', ''];

  if (!isReasonableLength(first_name, 80) || !isOptionalReasonableLength(last_name, 80)) {
    return res.redirect('/gym/team/' + req.params.id + '?error=name');
  }
  if (!isValidEmail(email)) {
    return res.redirect('/gym/team/' + req.params.id + '?error=email');
  }
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email.trim().toLowerCase())) {
    return res.redirect('/gym/team/' + req.params.id + '?error=emailtaken');
  }
  if (gender !== 'M' && gender !== 'F') {
    return res.redirect('/gym/team/' + req.params.id + '?error=gender');
  }
  if (!validCategories.includes(category)) {
    return res.redirect('/gym/team/' + req.params.id + '?error=category');
  }

  const DEFAULT_PASSWORD = 'GLGWelcome2026!';
  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const uid = db.prepare("INSERT INTO users (email,password_hash,role,first_name,last_name,gender,phone) VALUES (?,?,?,?,?,?,?)")
    .run(email.trim().toLowerCase(), hash, 'athlete', first_name.trim(), last_name.trim(), gender, (phone || '').trim() || null).lastInsertRowid;
  db.prepare("INSERT INTO athletes (user_id, region_id, team_id, wants_team, category) VALUES (?,?,?,0,?)")
    .run(uid, team.region_id, team.id, category || null);

  res.redirect('/gym/team/' + req.params.id + '?added=1');
});

// Gym admin resets a member's password (e.g. they've forgotten it and there's
// no email/reset-link infrastructure to send one automatically). The new
// password is shown directly on the page so the gym admin can pass it along.
function generateTempPassword() {
  const words = ['River', 'Storm', 'Falcon', 'Ridge', 'Ember', 'Cedar', 'Harbor', 'Comet', 'Granite', 'Willow'];
  const word = words[Math.floor(Math.random() * words.length)];
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `${word}${digits}!`;
}

app.post('/gym/team/:id/reset-password', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(req.params.id, gym.id);
  if (!team) return res.status(404).render('error', { title: 'Not Found', message: 'Team not found.' });

  const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND team_id=?").get(req.body.athlete_id, team.id);
  if (!athlete) return res.redirect('/gym/team/' + req.params.id);

  const newPassword = generateTempPassword();
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, athlete.user_id);

  // Re-render directly (not a redirect) so the new password can be shown once,
  // in the response — never put a raw password in a URL/query string.
  const roster = db.prepare(`
    SELECT a.id as athlete_id, u.first_name, u.last_name, u.gender, u.email, u.phone, a.category
    FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=?`).all(team.id);
  res.render('gym-team-detail', {
    title: team.name, team, roster, gym,
    resetPasswordFor: athlete.id, newPassword,
  });
});

// ---- Fixtures & results entry (gym admin can enter results for their own team's fixtures) ----
app.get('/gym/fixtures', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const teamIds = db.prepare("SELECT id FROM teams WHERE gym_id=?").all(gym.id).map(t => t.id);
  if (teamIds.length === 0) return res.render('gym-fixtures', { title: 'Fixtures', fixtures: [] });
  const placeholders = teamIds.map(() => '?').join(',');
  const fixtures = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
    WHERE f.team_a_id IN (${placeholders}) OR f.team_b_id IN (${placeholders})
    ORDER BY f.week
  `).all(...teamIds, ...teamIds);
  res.render('gym-fixtures', { title: 'Fixtures', fixtures });
});

function canManageFixture(user, fixture) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'gym_admin') return false;
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(user.id);
  if (!gym) return false;
  const teamIds = db.prepare("SELECT id FROM teams WHERE gym_id=?").all(gym.id).map(t => t.id);
  return teamIds.includes(fixture.team_a_id) || teamIds.includes(fixture.team_b_id);
}

// A judge may only enter scores for the specific (fixture, category) pairs
// they've been assigned — a judge follows their participant group through
// every exercise, so scope is per category, not per gate. This is
// intentionally narrower than canManageFixture.
function judgeAssignedCategories(userId, fixtureId) {
  return db.prepare("SELECT category FROM judge_assignments WHERE user_id=? AND fixture_id=?")
    .all(userId, fixtureId).map(r => r.category);
}

// ---- server-synced clock so the controller's Cast Display and the public
// read-only view always agree on the current time, rather than each browser
// running its own independent local timer. ----
function getClockRow(fixtureId, mode) {
  let row = db.prepare("SELECT * FROM fixture_clocks WHERE fixture_id=? AND mode=?").get(fixtureId, mode);
  if (!row) {
    const id = db.prepare("INSERT INTO fixture_clocks (fixture_id, mode, running, started_at, accumulated_seconds) VALUES (?,?,0,NULL,0)")
      .run(fixtureId, mode).lastInsertRowid;
    row = db.prepare("SELECT * FROM fixture_clocks WHERE id=?").get(id);
  }
  return row;
}
function clockElapsedSeconds(row) {
  let seconds = row.accumulated_seconds || 0;
  if (row.running && row.started_at) {
    seconds += (Date.now() - new Date(row.started_at).getTime()) / 1000;
  }
  return seconds;
}

app.get('/fixture/:id/results', requireLogin, (req, res) => {
  const fixture = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.id=?`).get(req.params.id);
  if (!fixture) return res.status(404).render('error', { title: 'Not Found', message: 'Fixture not found.' });
  if (!canManageFixture(req.session.user, fixture)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "You can only manage results for your own gym's fixtures." });
  }

  const gates = db.prepare("SELECT * FROM gates ORDER BY number").all();
  const exercises = db.prepare("SELECT * FROM exercises ORDER BY gate_id, sort_order").all();

  const categoryLabel = {
    mens_singles: "Men's Singles", womens_singles: "Women's Singles",
    mens_doubles: "Men's Doubles", womens_doubles: "Women's Doubles", mixed_doubles: "Mixed Doubles",
  };

  // who's competing in each category, per team (for display — names only, scoring stays category-level)
  const athletesFor = (teamId) => db.prepare(
    "SELECT category, first_name, last_name FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=? AND a.category IS NOT NULL"
  ).all(teamId).reduce((acc, a) => { (acc[a.category] ||= []).push(`${a.first_name} ${a.last_name}`); return acc; }, {});

  const namesA = athletesFor(fixture.team_a_id);
  const namesB = athletesFor(fixture.team_b_id);

  const catResults = db.prepare("SELECT * FROM category_results WHERE fixture_id=?").all(fixture.id);
  const resultMap = {};
  for (const r of catResults) resultMap[`${r.team_id}_${r.exercise_id}_${r.category}`] = r;

  const g4Results = db.prepare("SELECT * FROM category_gate4_results WHERE fixture_id=?").all(fixture.id);
  const g4Map = {};
  for (const r of g4Results) g4Map[`${r.team_id}_${r.category}`] = r;

  const judgeAssignments = db.prepare(`
    SELECT ja.id, ja.category, u.email as judge_email, u.first_name, u.last_name, u.phone as judge_phone
    FROM judge_assignments ja JOIN users u ON u.id=ja.user_id
    WHERE ja.fixture_id=? ORDER BY ja.category
  `).all(fixture.id);

  res.render('fixture-results', {
    title: `Week ${fixture.week} Results`, fixture, gates, exercises,
    categoryLabel, namesA, namesB, resultMap, g4Map, judgeAssignments,
  });
});

// Shared by both the full-fixture results form (gym admin / GLG admin) and the
// category-scoped judge entry form — same upsert + recompute logic either way,
// just restricted to the judge's assigned categories when scoped.
function applyResultsFromBody(fixture, body, allowedExerciseIds /* null = no restriction */, allowedCategories /* null = no restriction */) {
  const categories = ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles'];
  const exercises = db.prepare("SELECT e.*, g.is_sprint_finish FROM exercises e JOIN gates g ON g.id=e.gate_id").all();

  const upsertCategoryResult = (fixtureId, exerciseId, teamId, category, rawValue) => {
    const existing = db.prepare("SELECT id FROM category_results WHERE fixture_id=? AND exercise_id=? AND team_id=? AND category=?")
      .get(fixtureId, exerciseId, teamId, category);
    if (existing) {
      db.prepare("UPDATE category_results SET raw_value=? WHERE id=?").run(rawValue, existing.id);
    } else {
      db.prepare("INSERT INTO category_results (fixture_id, exercise_id, team_id, category, raw_value) VALUES (?,?,?,?,?)")
        .run(fixtureId, exerciseId, teamId, category, rawValue);
    }
  };

  for (const ex of exercises) {
    if (ex.is_sprint_finish) continue;
    if (allowedExerciseIds && !allowedExerciseIds.includes(ex.id)) continue;
    for (const teamId of [fixture.team_a_id, fixture.team_b_id]) {
      for (const category of categories) {
        if (allowedCategories && !allowedCategories.includes(category)) continue;
        const key = `result_${teamId}_${ex.id}_${category}`;
        if (body[key] !== undefined && body[key] !== '') {
          upsertCategoryResult(fixture.id, ex.id, teamId, category, parseFloat(body[key]));
        }
      }
    }
  }

  // Gate 4 (sprint finish) — only processed if the judge's allowed set includes
  // a gate-4 exercise, or if there's no restriction at all (full-fixture form).
  const gate4Allowed = !allowedExerciseIds || exercises.some(e => e.is_sprint_finish && allowedExerciseIds.includes(e.id));
  if (gate4Allowed) {
    for (const teamId of [fixture.team_a_id, fixture.team_b_id]) {
      for (const category of categories) {
        if (allowedCategories && !allowedCategories.includes(category)) continue;
        const completedKey = `g4_${teamId}_${category}_completed`;
        const timeKey = `g4_${teamId}_${category}_time`;
        if (body[completedKey] !== undefined) {
          const completed = body[completedKey] === 'on' || body[completedKey] === '1' ? 1 : 0;
          const time = body[timeKey] ? parseFloat(body[timeKey]) : null;
          const existing = db.prepare("SELECT id FROM category_gate4_results WHERE fixture_id=? AND team_id=? AND category=?").get(fixture.id, teamId, category);
          if (existing) {
            db.prepare("UPDATE category_gate4_results SET completed=?, total_time_sec=? WHERE id=?").run(completed, time, existing.id);
          } else {
            db.prepare("INSERT INTO category_gate4_results (fixture_id, team_id, category, completed, total_time_sec) VALUES (?,?,?,?,?)")
              .run(fixture.id, teamId, category, completed, time);
          }
        }
      }
    }
  }

  scoring.recomputeFixtureScores(fixture.id);
}

app.post('/fixture/:id/results', requireLogin, (req, res) => {
  const fixtureId = req.params.id;
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(fixtureId);
  if (!fixture) return res.status(404).render('error', { title: 'Not Found', message: 'Fixture not found.' });
  if (!canManageFixture(req.session.user, fixture)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "You can only manage results for your own gym's fixtures." });
  }

  applyResultsFromBody(fixture, req.body, null);
  db.prepare("UPDATE fixtures SET status='complete' WHERE id=?").run(fixtureId);

  res.redirect(`/fixture/${fixtureId}/results?saved=1`);
});

// ---- Judge assignment (gym admin / GLG admin assigns a judge to a category for a fixture) ----
app.post('/fixture/:id/assign-judge', requireLogin, (req, res) => {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.id);
  if (!fixture || !canManageFixture(req.session.user, fixture)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "You can only assign judges for your own gym's fixtures." });
  }
  const { judge_email, judge_first_name, judge_last_name, judge_phone, category } = req.body;
  if (!Object.keys(CATEGORY_LABEL).includes(category)) {
    return res.redirect(`/fixture/${fixture.id}/results?judgeError=category`);
  }
  const email = (judge_email || '').trim().toLowerCase();

  if (!isValidEmail(email)) {
    return res.redirect(`/fixture/${fixture.id}/results?judgeError=email`);
  }

  let judge = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (judge && judge.role !== 'judge') {
    // that email belongs to someone else's account (athlete, gym admin, etc.) — don't silently repurpose it
    return res.redirect(`/fixture/${fixture.id}/results?judgeError=notjudge`);
  }

  if (!judge) {
    // no account with this email yet — create one, using the name/phone provided
    if (!isReasonableLength(judge_first_name, 80)) {
      return res.redirect(`/fixture/${fixture.id}/results?judgeError=name`);
    }
    const DEFAULT_PASSWORD = 'GLGWelcome2026!';
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    const uid = db.prepare("INSERT INTO users (email,password_hash,role,first_name,last_name,phone) VALUES (?,?,?,?,?,?)")
      .run(email, hash, 'judge', judge_first_name.trim(), (judge_last_name || '').trim(), (judge_phone || '').trim() || null).lastInsertRowid;
    judge = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  }

  db.prepare("INSERT OR IGNORE INTO judge_assignments (user_id, fixture_id, category) VALUES (?,?,?)")
    .run(judge.id, fixture.id, category);
  res.redirect(`/fixture/${fixture.id}/results?judgeAssigned=1`);
});

app.post('/fixture/:id/unassign-judge/:assignmentId', requireLogin, (req, res) => {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.id);
  if (!fixture || !canManageFixture(req.session.user, fixture)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "Access denied." });
  }
  db.prepare("DELETE FROM judge_assignments WHERE id=? AND fixture_id=?").run(req.params.assignmentId, fixture.id);
  res.redirect(`/fixture/${fixture.id}/results`);
});

// ---- Judge dashboard & category-scoped scoring ----
app.get('/judge', requireLogin, requireRole('judge'), (req, res) => {
  const assignments = db.prepare(`
    SELECT ja.id as assignment_id, ja.category, f.id as fixture_id, f.week, f.match_date,
           ta.name as team_a_name, tb.name as team_b_name
    FROM judge_assignments ja
    JOIN fixtures f ON f.id = ja.fixture_id
    JOIN teams ta ON ta.id = f.team_a_id
    JOIN teams tb ON tb.id = f.team_b_id
    WHERE ja.user_id = ?
    ORDER BY f.week, ja.category
  `).all(req.session.user.id);
  res.render('judge-dashboard', { title: 'Judge Dashboard', assignments, categoryLabel: CATEGORY_LABEL });
});

app.get('/judge/fixture/:fixtureId/category/:category', requireLogin, requireRole('judge'), (req, res) => {
  const assigned = judgeAssignedCategories(req.session.user.id, req.params.fixtureId);
  if (!assigned.includes(req.params.category)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "You're not assigned to judge this category." });
  }
  const fixture = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.id=?`).get(req.params.fixtureId);
  const category = req.params.category;

  const gates = db.prepare("SELECT * FROM gates ORDER BY number").all();
  const exercises = db.prepare(`
    SELECT e.*, g.number as gate_number, g.name as gate_name, g.is_sprint_finish
    FROM exercises e JOIN gates g ON g.id=e.gate_id ORDER BY g.number, e.sort_order`).all();

  const categoryLabel = CATEGORY_LABEL;
  const namesFor = (teamId) => {
    const rows = db.prepare("SELECT first_name, last_name FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=? AND a.category=?").all(teamId, category);
    return rows.map(r => `${r.first_name} ${r.last_name}`);
  };
  const namesA = namesFor(fixture.team_a_id), namesB = namesFor(fixture.team_b_id);

  const catResults = db.prepare("SELECT * FROM category_results WHERE fixture_id=? AND category=?").all(fixture.id, category);
  const resultMap = {};
  for (const r of catResults) resultMap[`${r.team_id}_${r.exercise_id}`] = r;

  const g4Map = {};
  const g4Results = db.prepare("SELECT * FROM category_gate4_results WHERE fixture_id=? AND category=?").all(fixture.id, category);
  for (const r of g4Results) g4Map[`${r.team_id}`] = r;

  res.render('judge-category-results', { title: `Judge — ${categoryLabel[category]}`, fixture, category, gates, exercises, categoryLabel, namesA, namesB, resultMap, g4Map });
});

app.post('/judge/fixture/:fixtureId/category/:category', requireLogin, requireRole('judge'), (req, res) => {
  const assigned = judgeAssignedCategories(req.session.user.id, req.params.fixtureId);
  if (!assigned.includes(req.params.category)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "You're not assigned to judge this category." });
  }
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.fixtureId);

  // No exercise restriction — the judge covers all 12 exercises,
  // but only for their assigned category.
  applyResultsFromBody(fixture, req.body, null, [req.params.category]);

  res.redirect(`/judge/fixture/${req.params.fixtureId}/category/${req.params.category}?saved=1`);
});

// ---- LIVE JUDGE COUNTER (phone screen) ----
// Real-time rep counting: big tap buttons for rep exercises, quick totals for
// machines, and a synced Gate 4 finish stamp. Follows the master event clock
// so the judge's phone always shows the exercise their category is on.

function judgeLiveGuard(req, res) {
  const assigned = judgeAssignedCategories(req.session.user.id, req.params.fixtureId);
  if (!assigned.includes(req.params.category)) return null;
  return db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.id=?`).get(req.params.fixtureId);
}

app.get('/judge/fixture/:fixtureId/category/:category/live', requireLogin, requireRole('judge'), (req, res) => {
  const fixture = judgeLiveGuard(req, res);
  if (!fixture) return res.status(403).render('error', { title: 'Access Denied', message: "You're not assigned to judge this category." });
  const category = req.params.category;

  const exercises = db.prepare(`
    SELECT e.*, g.number as gate_number, g.name as gate_name, g.is_sprint_finish
    FROM exercises e JOIN gates g ON g.id=e.gate_id ORDER BY g.number, e.sort_order`).all();

  // Attach this category's benchmark to each exercise so the phone can show
  // target + progress without knowing the doubles-summing rule.
  for (const ex of exercises) ex.category_benchmark = scoring.benchmarkForCategory(ex, category);

  const namesFor = (teamId) => db.prepare(
    "SELECT first_name, last_name FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=? AND a.category=?"
  ).all(teamId, category).map(r => `${r.first_name} ${r.last_name}`);

  const catResults = db.prepare("SELECT * FROM category_results WHERE fixture_id=? AND category=?").all(fixture.id, category);
  const resultMap = {};
  for (const r of catResults) resultMap[`${r.team_id}_${r.exercise_id}`] = { raw_value: r.raw_value, points: r.points };
  const g4Map = {};
  for (const r of db.prepare("SELECT * FROM category_gate4_results WHERE fixture_id=? AND category=?").all(fixture.id, category)) {
    g4Map[r.team_id] = { completed: r.completed, total_time_sec: r.total_time_sec, points: r.points };
  }

  const CATEGORY_ORDER = ['mens_singles','womens_singles','mens_doubles','womens_doubles','mixed_doubles'];

  res.render('judge-live', {
    title: `Live — ${CATEGORY_LABEL[category]}`, layout: false,
    fixture, category, categoryLabel: CATEGORY_LABEL,
    catIndex: CATEGORY_ORDER.indexOf(category),
    exercises, resultMap, g4Map,
    namesA: namesFor(fixture.team_a_id), namesB: namesFor(fixture.team_b_id),
  });
});

// Save one exercise result from the live counter (tap counters + totals).
app.post('/api/judge/fixture/:fixtureId/category/:category/result', requireLogin, requireRole('judge'), (req, res) => {
  const fixture = judgeLiveGuard(req, res);
  if (!fixture) return res.status(403).json({ error: 'not assigned' });

  const exercise_id = parseInt(req.body.exercise_id);
  const team_id = parseInt(req.body.team_id);
  const raw_value = parseFloat(req.body.raw_value);
  if (![fixture.team_a_id, fixture.team_b_id].includes(team_id)) return res.status(400).json({ error: 'bad team' });
  const ex = db.prepare("SELECT e.*, g.is_sprint_finish FROM exercises e JOIN gates g ON g.id=e.gate_id WHERE e.id=?").get(exercise_id);
  if (!ex || ex.is_sprint_finish) return res.status(400).json({ error: 'bad exercise' });
  if (!isFinite(raw_value) || raw_value < 0) return res.status(400).json({ error: 'bad value' });

  const category = req.params.category;
  const existing = db.prepare("SELECT id FROM category_results WHERE fixture_id=? AND exercise_id=? AND team_id=? AND category=?")
    .get(fixture.id, exercise_id, team_id, category);
  if (existing) db.prepare("UPDATE category_results SET raw_value=? WHERE id=?").run(raw_value, existing.id);
  else db.prepare("INSERT INTO category_results (fixture_id, exercise_id, team_id, category, raw_value) VALUES (?,?,?,?,?)")
    .run(fixture.id, exercise_id, team_id, category, raw_value);

  scoring.recomputeFixtureScores(fixture.id);

  // hand back both teams' fresh points for this exercise so the phone can show
  // benchmark-hit / station-won state live
  const out = {};
  for (const tid of [fixture.team_a_id, fixture.team_b_id]) {
    const r = db.prepare("SELECT raw_value, points, benchmark_met, beat_opponent FROM category_results WHERE fixture_id=? AND exercise_id=? AND team_id=? AND category=?")
      .get(fixture.id, exercise_id, tid, category);
    if (r) out[tid] = r;
  }
  res.json({ ok: true, results: out });
});

// Stamp / un-stamp a Gate 4 finish from the live counter.
app.post('/api/judge/fixture/:fixtureId/category/:category/gate4', requireLogin, requireRole('judge'), (req, res) => {
  const fixture = judgeLiveGuard(req, res);
  if (!fixture) return res.status(403).json({ error: 'not assigned' });

  const team_id = parseInt(req.body.team_id);
  if (![fixture.team_a_id, fixture.team_b_id].includes(team_id)) return res.status(400).json({ error: 'bad team' });
  const completed = req.body.completed ? 1 : 0;
  const time = (req.body.total_time_sec !== undefined && req.body.total_time_sec !== null && req.body.total_time_sec !== '')
    ? parseFloat(req.body.total_time_sec) : null;

  const category = req.params.category;
  const existing = db.prepare("SELECT id FROM category_gate4_results WHERE fixture_id=? AND team_id=? AND category=?").get(fixture.id, team_id, category);
  if (existing) db.prepare("UPDATE category_gate4_results SET completed=?, total_time_sec=? WHERE id=?").run(completed, time, existing.id);
  else db.prepare("INSERT INTO category_gate4_results (fixture_id, team_id, category, completed, total_time_sec) VALUES (?,?,?,?,?)")
    .run(fixture.id, team_id, category, completed, time);

  scoring.recomputeFixtureScores(fixture.id);

  const out = {};
  for (const tid of [fixture.team_a_id, fixture.team_b_id]) {
    const r = db.prepare("SELECT completed, total_time_sec, points FROM category_gate4_results WHERE fixture_id=? AND team_id=? AND category=?").get(fixture.id, tid, category);
    if (r) out[tid] = r;
  }
  res.json({ ok: true, gate4: out });
});

// ============ CAST / TV DISPLAY (public, no login needed - gyms just load the URL on a screen) ============

function boardDataFor(fixture) {
  const gates = db.prepare("SELECT * FROM gates ORDER BY number").all();
  const exercises = db.prepare("SELECT * FROM exercises ORDER BY gate_id, sort_order").all();
  const groupedFor = (teamId) => {
    const rows = db.prepare(
      "SELECT category, first_name, last_name FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=? AND a.category IS NOT NULL"
    ).all(teamId);
    const grouped = {};
    for (const r of rows) (grouped[r.category] ||= []).push(`${r.first_name} ${r.last_name}`);
    return grouped;
  };
  return {
    gates, exercises, categoryLabel: CATEGORY_LABEL,
    groupedA: groupedFor(fixture.team_a_id), groupedB: groupedFor(fixture.team_b_id),
  };
}

// Live scores for the public watch view — every category_result and
// category_gate4_result row entered so far for this fixture, keyed for easy lookup.
function liveScoresFor(fixtureId) {
  const rows = db.prepare("SELECT * FROM category_results WHERE fixture_id=?").all(fixtureId);
  const g4rows = db.prepare("SELECT * FROM category_gate4_results WHERE fixture_id=?").all(fixtureId);
  const byKey = {};
  for (const r of rows) (byKey[`${r.team_id}_${r.category}`] ||= []).push({ exercise_id: r.exercise_id, points: r.points, raw_value: r.raw_value });
  for (const r of g4rows) (byKey[`${r.team_id}_${r.category}`] ||= []).push({ exercise_id: 'gate4', points: r.points, completed: r.completed });
  return byKey;
}

app.get('/cast/:fixtureId', requireLogin, (req, res) => {
  const fixture = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.id=?`).get(req.params.fixtureId);
  if (!fixture) return res.status(404).send('Fixture not found');
  if (!canManageFixture(req.session.user, fixture)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "Only the gyms competing in this fixture (or GLG Admin) can open the live match board." });
  }
  res.render('cast', { title: 'Live Display', layout: false, fixture, ...boardDataFor(fixture) });
});

// Public, read-only version — anyone can open this (e.g. spectators, family,
// other gyms) to watch the same board and live scores, but with no
// Start/Pause/Reset controls. The clock itself is server-synced, so this
// always matches whatever the controller's Cast Display is showing.
app.get('/watch/:fixtureId', (req, res) => {
  const fixture = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.id=?`).get(req.params.fixtureId);
  if (!fixture) return res.status(404).send('Fixture not found');
  res.render('watch', { title: 'Watch Live', layout: false, fixture, ...boardDataFor(fixture) });
});

// ---- Clock API ----
// GET is public (both the controller and public viewers poll this).
// POST (start/pause/reset) requires the same fixture-ownership check as Cast.
app.get('/api/fixture/:id/clock/:mode', (req, res) => {
  const row = getClockRow(req.params.id, req.params.mode);
  res.json({ running: !!row.running, elapsedSeconds: clockElapsedSeconds(row) });
});

app.post('/api/fixture/:id/clock/:mode/start', requireLogin, (req, res) => {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.id);
  if (!fixture || !canManageFixture(req.session.user, fixture)) return res.status(403).json({ error: 'forbidden' });
  const row = getClockRow(req.params.id, req.params.mode);
  if (!row.running) {
    db.prepare("UPDATE fixture_clocks SET running=1, started_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  }
  res.json({ ok: true });
});

app.post('/api/fixture/:id/clock/:mode/pause', requireLogin, (req, res) => {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.id);
  if (!fixture || !canManageFixture(req.session.user, fixture)) return res.status(403).json({ error: 'forbidden' });
  const row = getClockRow(req.params.id, req.params.mode);
  if (row.running) {
    const elapsed = clockElapsedSeconds(row);
    db.prepare("UPDATE fixture_clocks SET running=0, started_at=NULL, accumulated_seconds=? WHERE id=?").run(elapsed, row.id);
  }
  res.json({ ok: true });
});

app.post('/api/fixture/:id/clock/:mode/reset', requireLogin, (req, res) => {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.id);
  if (!fixture || !canManageFixture(req.session.user, fixture)) return res.status(403).json({ error: 'forbidden' });
  const row = getClockRow(req.params.id, req.params.mode);
  db.prepare("UPDATE fixture_clocks SET running=0, started_at=NULL, accumulated_seconds=0 WHERE id=?").run(row.id);
  res.json({ ok: true });
});

// Live scores endpoint — polled by the public watch view (and could be used
// by the Cast Display too) so newly entered judge scores appear without a refresh.
app.get('/api/fixture/:id/live-scores', (req, res) => {
  res.json(liveScoresFor(req.params.id));
});

// ============ ADMIN ============

app.get('/admin', requireLogin, requireRole('admin'), (req, res) => {
  const stats = {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    gyms: db.prepare("SELECT COUNT(*) c FROM gyms").get().c,
    teams: db.prepare("SELECT COUNT(*) c FROM teams").get().c,
    athletes: db.prepare("SELECT COUNT(*) c FROM athletes").get().c,
    fixtures: db.prepare("SELECT COUNT(*) c FROM fixtures").get().c,
  };
  const pendingOperators = db.prepare("SELECT * FROM users WHERE role='league_operator' AND approved=0").all();
  const regions = db.prepare("SELECT * FROM regions ORDER BY level, name").all();
  res.render('admin-dashboard', { title: 'GLG Admin', stats, pendingOperators, regions });
});

app.post('/admin/operators/:id/approve', requireLogin, requireRole('admin'), (req, res) => {
  db.prepare("UPDATE users SET approved=1 WHERE id=?").run(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/operators/:id/reject', requireLogin, requireRole('admin'), (req, res) => {
  db.prepare("DELETE FROM users WHERE id=? AND role='league_operator'").run(req.params.id);
  res.redirect('/admin');
});

app.get('/admin/region/:id', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  const teams = db.prepare("SELECT t.*, g.name as gym_name FROM teams t JOIN gyms g ON g.id=t.gym_id WHERE t.region_id=?").all(region.id);
  const fixtures = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.region_id=? ORDER BY f.week`).all(region.id);
  res.render('admin-region', { title: region.name, region, teams, fixtures });
});

// ============ LEAGUE OPERATOR DASHBOARD (placeholder home once approved) ============
app.get('/league', requireLogin, requireRole('league_operator'), (req, res) => {
  res.render('league-dashboard', { title: 'League Operator' });
});

// ============ 404 ============
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: "That page doesn't exist." });
});

// ============ ERROR HANDLER ============
// Catches anything that goes wrong in any route and logs the full detail to
// the console (visible in Railway's Deployments → Logs tab) so a crash is
// diagnosable from the hosting dashboard rather than a blank "Internal Server
// Error" with no trail to follow.
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR on', req.method, req.originalUrl);
  console.error(err.stack || err);
  res.status(500).render('error', {
    title: 'Something Went Wrong',
    message: "We hit a snag loading this page. It's been logged — please try again shortly.",
  });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`GLG app running on http://localhost:${PORT}`));
}

module.exports = app;
