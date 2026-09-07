const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mailer = require('./mailer');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const scoring = require('./scoring');
const storage = require('./storage');
const multer = require('multer');

const app = express();
// Railway sits the app behind a reverse proxy — without this, Express ignores
// the X-Forwarded-For header, so express-rate-limit can't tell visitors apart
// by IP (everyone looks like one client, or none get identified correctly).
// '1' = trust exactly one hop (Railway's own proxy), not an open-ended chain.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Security headers. CSP relaxed for inline styles/scripts used throughout the
// EJS views (no external script sources are loaded, so this stays reasonably tight).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      // cdn.jsdelivr.net serves TensorFlow.js + pose-detection for the
      // Wedgetail prototype (public/wedgetail.html) — everything else on the
      // site is same-origin, this is the one deliberate external script source.
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"], // allows onclick/onchange/onsubmit attributes used throughout the views —
                                          // helmet blocks these by default even when scriptSrc allows inline <script> tags,
                                          // which silently broke every button on the Cast Display and several other pages.
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://tfhub.dev", "https://storage.googleapis.com", "https://www.kaggle.com", "https://kaggle.com"], // tfjs-core loads the actual MoveNet model weights from TF Hub/Kaggle Models at runtime, not from jsdelivr — the script tag is only the library code
      // Wedgetail recording playback streams video directly from R2 via signed URLs.
      // R2's virtual-hosted-style URLs put the bucket name in front of the account
      // id (e.g. glg-wedgetail-recordings.<account-id>.r2.cloudflarestorage.com),
      // so this has to be a wildcard subdomain rather than one fixed host.
      mediaSrc: ["'self'", "https://*.r2.cloudflarestorage.com"],
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

// A team can be managed by its gym's admin, its captain, or both at once
// (once a captain-created team has been approved onto a gym). This is an
// ownership check, not a role check — a captain keeps role='athlete' the
// whole time, so gym/team routes can't gate on requireRole('gym_admin')
// alone anymore; they gate on requireLogin + this.
function canManageTeam(sessionUser, team) {
  if (!team || !sessionUser) return false;
  if (team.captain_user_id && team.captain_user_id === sessionUser.id) return true;
  if (team.gym_id) {
    const gym = db.prepare("SELECT * FROM gyms WHERE id=? AND admin_user_id=?").get(team.gym_id, sessionUser.id);
    if (gym) return true;
  }
  return false;
}
function requireCanManageTeam(req, res, next) {
  const team = db.prepare("SELECT * FROM teams WHERE id=?").get(req.params.id);
  if (!team || !canManageTeam(req.session.user, team)) {
    return res.status(404).render('error', { title: 'Not Found', message: 'Team not found.' });
  }
  req.managedTeam = team;
  next();
}

// ---- Unassigned gym: the default home for a gym-less captain-run team ----
// One per region, created lazily on first use and reused after that. Real
// gyms all have an admin_user_id and status flows through the normal
// pending/active/suspended approval path; this one is a system placeholder —
// always 'active', never has an admin, flagged is_unassigned so the rest of
// the app (and the admin dashboard's "needs a gym" list) can tell it apart
// from a genuine gym that just hasn't been claimed yet.
function getUnassignedGym(regionId) {
  let gym = db.prepare("SELECT * FROM gyms WHERE region_id=? AND is_unassigned=1").get(regionId);
  if (!gym) {
    const id = db.prepare("INSERT INTO gyms (name, region_id, admin_user_id, address, status, is_unassigned) VALUES ('Unassigned', ?, NULL, NULL, 'active', 1)")
      .run(regionId).lastInsertRowid;
    gym = db.prepare("SELECT * FROM gyms WHERE id=?").get(id);
  }
  return gym;
}
function isRealGym(gym) { return !!(gym && !gym.is_unassigned); }

// ---- Admin control layer: role hierarchy ----
// admin        -> everything, everywhere
// league_operator ("franchisee") -> everything within their assigned region_id
// gym_admin    -> everything within their own gym (its teams, captains, athletes)
// captain      -> (role stays 'athlete') everything within their own team's roster
// A single helper answers "can this session user act on this target user?"
// so the admin, league, and gym dashboards can all call the same status/role
// actions instead of three parallel copies of the same logic.
function targetUserScope(targetUser) {
  // Resolve the chain of custody for a user: which gym (if any) and which
  // region they sit under, so a higher-up's reach can be checked in one go.
  const athlete = db.prepare("SELECT * FROM athletes WHERE user_id=?").get(targetUser.id);
  const team = athlete && athlete.team_id ? db.prepare("SELECT * FROM teams WHERE id=?").get(athlete.team_id) : null;
  const captainTeam = db.prepare("SELECT * FROM teams WHERE captain_user_id=?").get(targetUser.id);
  const ownedGym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(targetUser.id);
  const gymId = ownedGym ? ownedGym.id : (team && isRealGymId(team.gym_id) ? team.gym_id : null);
  const regionId = targetUser.region_id || athlete?.region_id || team?.region_id || (captainTeam && captainTeam.region_id) || (ownedGym && ownedGym.region_id) || null;
  return { athlete, team: team || captainTeam, gymId, regionId };
}
function isRealGymId(gymId) {
  if (!gymId) return false;
  const gym = db.prepare("SELECT is_unassigned FROM gyms WHERE id=?").get(gymId);
  return !!(gym && !gym.is_unassigned);
}
function canManageUser(actor, targetUser) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (targetUser.id === actor.id) return false; // acting on yourself goes through /account, not admin actions
  const scope = targetUserScope(targetUser);
  if (actor.role === 'league_operator') return !!(actor.region_id && scope.regionId === actor.region_id);
  const actorGym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(actor.id);
  if (actor.role === 'gym_admin' && actorGym) return scope.gymId === actorGym.id;
  // Team captain (role stays 'athlete') managing their own roster
  const captainOf = db.prepare("SELECT * FROM teams WHERE captain_user_id=?").get(actor.id);
  if (captainOf && scope.team && scope.team.id === captainOf.id) return true;
  return false;
}
function requireAdminOrScoped(req, res, next) {
  // Gate for the shared /admin/* user & gym actions: full admin always
  // passes; league_operator/gym_admin/captain pass only for targets within
  // their own scope, checked per-route via canManageUser.
  if (!req.session.user || !['admin', 'league_operator', 'gym_admin', 'athlete'].includes(req.session.user.role)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "You don't have permission to do that." });
  }
  next();
}

// Judge accounts previously shared one fixed default password
// ('GLGWelcome2026!'); replaced by per-judge random passwords with a
// 24-hour expiry (see autoCreateGymJudges / rotateGymJudgePasswords below).
function slugifyForEmail(name) {
  return (name || 'gym').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'gym';
}
// Auto-creates the 5 standing category-judge logins for a gym, using
// plus-addressing off the gym admin's own email domain so every judge
// notification lands in the inbox they already check — no separate judge
// inboxes to set up. Idempotent: skips any category that already has a
// judge account for this gym (safe to call again from the dashboard).
// These addresses are placeholders nobody actually reads day-to-day, so
// each judge gets its own random password (not a shared default) with a
// 24-hour expiry — handed to whoever's judging that category in person on
// the day, not relied on as a standing secret.
// Returns [{ category, email, wasNew, password }, ...] for all 5 categories
// — password is only set (and only meaningful) for accounts touched just now.
function autoCreateGymJudges(gym, adminEmail) {
  const domain = (adminEmail.split('@')[1] || '').trim();
  const gymSlug = slugifyForEmail(gym.name);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const results = [];
  for (const category of Object.keys(CATEGORY_LABEL)) {
    const email = `${category}+${gymSlug}@${domain}`;
    let judge = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    let wasNew = false;
    let password = null;
    if (!judge) {
      password = generateTempPassword();
      const hash = bcrypt.hashSync(password, 10);
      const uid = db.prepare("INSERT INTO users (email,password_hash,role,first_name,last_name,password_expires_at) VALUES (?,?,?,?,?,?)")
        .run(email, hash, 'judge', `${CATEGORY_LABEL[category]} Judge`, gym.name, expiresAt).lastInsertRowid;
      judge = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
      wasNew = true;
    }
    results.push({ category, email, wasNew, password });
  }
  return results;
}

// Rotates the password (and resets the 24-hour expiry) for a gym's 5
// existing standing judge logins — the "Generate Passwords" control for
// competition day, separate from creating the accounts in the first place.
// Returns the same shape as autoCreateGymJudges, password always set for
// any judge that actually exists.
function rotateGymJudgePasswords(gym, adminEmail) {
  const domain = (adminEmail.split('@')[1] || '').trim();
  const gymSlug = slugifyForEmail(gym.name);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const results = [];
  for (const category of Object.keys(CATEGORY_LABEL)) {
    const email = `${category}+${gymSlug}@${domain}`;
    const judge = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (!judge) { results.push({ category, email, exists: false, password: null }); continue; }
    const password = generateTempPassword();
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET password_hash=?, password_expires_at=? WHERE id=?").run(hash, expiresAt, judge.id);
    results.push({ category, email, exists: true, password });
  }
  return results;
}

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
app.get('/how-it-works', (req, res) => res.render('how-it-works', { title: 'How Gym League Global Works' }));
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
  if (user.status === 'suspended') {
    return res.render('login', { title: 'Log In', error: 'This account has been suspended. Contact GLG HQ if you think that\'s wrong.', next: '/' });
  }
  if (user.role === 'judge' && user.password_expires_at && new Date(user.password_expires_at) < new Date()) {
    return res.render('login', { title: 'Log In', error: 'This judge password has expired — ask your gym admin to generate a new one for today.', next: '/' });
  }
  req.session.user = { id: user.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name, region_id: user.region_id, status: user.status };
  const dest = next && next !== 'undefined' ? next : roleHome(user.role);
  res.redirect(dest);
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ---- Forgot / reset password (self-service) ----
// Always shows the same "check your email" message whether or not the
// address exists — otherwise the form becomes a way to test which emails
// have an account.
app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { title: 'Forgot Password', error: null, sent: false });
});

app.post('/forgot-password', authLimiter, (req, res) => {
  const { email } = req.body;
  if (!isValidEmail(email)) {
    return res.render('forgot-password', { title: 'Forgot Password', error: 'Please enter a valid email address.', sent: false });
  }
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.trim().toLowerCase());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    db.prepare(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)`)
      .run(user.id, tokenHash, expiresAt);
    const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
    mailer.send(mailer.passwordResetEmail({ user, resetUrl: `${site}/reset-password/${token}` }));
  }
  res.render('forgot-password', { title: 'Forgot Password', error: null, sent: true });
});

app.get('/reset-password/:token', (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const row = db.prepare("SELECT * FROM password_resets WHERE token_hash=?").get(tokenHash);
  const valid = row && !row.used_at && new Date(row.expires_at) > new Date();
  res.render('reset-password', { title: 'Reset Password', error: null, valid: !!valid, token: req.params.token });
});

app.post('/reset-password/:token', authLimiter, (req, res) => {
  const { password, confirm_password } = req.body;
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const row = db.prepare("SELECT * FROM password_resets WHERE token_hash=?").get(tokenHash);
  const valid = row && !row.used_at && new Date(row.expires_at) > new Date();
  if (!valid) {
    return res.render('reset-password', { title: 'Reset Password', error: 'This reset link is invalid or has expired — request a new one.', valid: false, token: req.params.token });
  }
  if (!isValidPassword(password) || password !== confirm_password) {
    return res.render('reset-password', { title: 'Reset Password', error: 'Passwords must match and be at least 6 characters.', valid: true, token: req.params.token });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, row.user_id);
  db.prepare("UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  res.render('login', { title: 'Log In', error: 'Password updated — log in with your new password.', next: '/' });
});

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
  const { first_name, last_name, email, password, gender, dob, phone, region_id, team_choice, team_id, new_team_name } = req.body;
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
  // Team Captain path needs a team name up front, and it must be unique
  // within the region (same rule as gym-created teams — enforced at the DB
  // level too via idx_teams_name_region, this is just the friendly error).
  let cleanTeamName = null;
  if (team_choice === 'captain') {
    cleanTeamName = (new_team_name || '').trim();
    if (!isReasonableLength(cleanTeamName, 80)) {
      return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'Please enter a name for your team.', step: 1 });
    }
    const nameTaken = db.prepare("SELECT id FROM teams WHERE region_id=? AND name = ? COLLATE NOCASE").get(region_id, cleanTeamName);
    if (nameTaken) {
      return res.render('signup-athlete', { title: 'Athlete Sign Up', regions, error: 'A team with that name already exists in your region — please choose another.', step: 1 });
    }
  }

  const hash = bcrypt.hashSync(password, 10);
  // Every new signup starts 'pending' — the gym (if the athlete lands on one
  // of its teams), the captain (if it's a captain-run team), or admin (if
  // unattached) has to approve them before they count as active on a roster.
  const uid = db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,gender,dob,phone,status) VALUES (?,?,?,?,?,?,?,?,'pending')`)
    .run(email.trim().toLowerCase(), hash, 'athlete', first_name.trim(), last_name.trim(), gender, dob || null, (phone || '').trim() || null).lastInsertRowid;

  const wantsTeam = team_choice === 'assign' ? 1 : 0;
  let chosenTeamId = team_choice === 'pick' && team_id ? team_id : null;
  let newTeamId = null;
  if (team_choice === 'captain') {
    // Gym-less captain teams get the region's "Unassigned" placeholder gym
    // instead of NULL — makes them visible in competition setup right away,
    // and the captain can still request a real gym later (unchanged flow).
    const unassignedGym = getUnassignedGym(region_id);
    newTeamId = db.prepare(`INSERT INTO teams (name, gym_id, region_id, division, captain_user_id) VALUES (?,?,?,?,?)`)
      .run(cleanTeamName, unassignedGym.id, region_id, 'Open', uid).lastInsertRowid;
    chosenTeamId = newTeamId;
  }
  db.prepare(`INSERT INTO athletes (user_id, region_id, team_id, wants_team) VALUES (?,?,?,?)`)
    .run(uid, region_id, chosenTeamId, wantsTeam);

  req.session.user = { id: uid, email: email.trim().toLowerCase(), role: 'athlete', first_name: first_name.trim(), last_name: last_name.trim() };

  // Fire-and-forget welcome email — never block the redirect on mail being
  // slow/down (mailer.send already swallows its own errors).
  const regionRow = regions.find(r => String(r.id) === String(region_id));
  if (team_choice === 'captain') {
    mailer.send(mailer.captainTeamCreatedEmail({
      user: { first_name: first_name.trim(), email: email.trim().toLowerCase() },
      teamName: cleanTeamName,
      regionName: regionRow ? regionRow.name : null,
    }));
  } else {
    mailer.send(mailer.welcomeAthleteEmail({
      user: { first_name: first_name.trim(), email: email.trim().toLowerCase() },
      regionName: regionRow ? regionRow.name : null,
    }));
  }
  const athleteNotice = mailer.adminNotifyEmail({
    subject: `New athlete signup: ${first_name.trim()} ${last_name.trim()}`,
    lines: [
      `${first_name.trim()} ${last_name.trim()} (${email.trim().toLowerCase()}) just signed up.`,
      `Region: ${regionRow ? regionRow.name : region_id}`,
      newTeamId ? `Started a new team as captain: "${cleanTeamName}" (team_id ${newTeamId}).`
        : chosenTeamId ? `Picked a team directly (team_id ${chosenTeamId}).`
        : (wantsTeam ? 'Asked to be assigned a team.' : 'No team preference set.'),
    ],
  });
  if (athleteNotice) mailer.send(athleteNotice);

  // Captains land on their new team's management page, not the plain
  // profile — that's the "screen to set up the team" from the brief.
  if (newTeamId) return res.redirect(`/gym/team/${newTeamId}?welcome=1`);
  res.redirect('/profile?welcome=1');
});

// endpoint used by the signup form to load teams for a chosen region (AJAX)
app.get('/api/regions/:id/teams', (req, res) => {
  const teams = db.prepare("SELECT id, name FROM teams WHERE region_id=? ORDER BY name").all(req.params.id);
  res.json(teams);
});

// used by a captain's "request a gym" search box — search-or-create, so an
// empty/no-match result is expected and handled client-side, not an error.
app.get('/api/regions/:id/gyms', requireLogin, (req, res) => {
  const q = (req.query.q || '').trim();
  const gyms = q
    ? db.prepare("SELECT id, name FROM gyms WHERE region_id=? AND name LIKE ? ORDER BY name LIMIT 10").all(req.params.id, `%${q}%`)
    : db.prepare("SELECT id, name FROM gyms WHERE region_id=? ORDER BY name LIMIT 25").all(req.params.id);
  res.json(gyms);
});

// ---- Team Captain: request to attach a gym-less team to a gym ----
app.post('/gym/team/:id/request-gym', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  if (isRealGymId(team.gym_id)) return res.redirect('/gym/team/' + req.params.id + '?error=alreadyhasgym');
  const existingPending = db.prepare("SELECT id FROM gym_attachment_requests WHERE team_id=? AND status='pending'").get(team.id);
  if (existingPending) return res.redirect('/gym/team/' + req.params.id + '?error=pendingexists');

  const { gym_id, new_gym_name } = req.body;
  const gym = gym_id ? db.prepare("SELECT * FROM gyms WHERE id=? AND region_id=?").get(gym_id, team.region_id) : null;
  const requestedName = (new_gym_name || '').trim();
  if (!gym && !requestedName) return res.redirect('/gym/team/' + req.params.id + '?error=nogym');

  db.prepare(`INSERT INTO gym_attachment_requests (team_id, gym_id, requested_gym_name, requested_by) VALUES (?,?,?,?)`)
    .run(team.id, gym ? gym.id : null, gym ? null : requestedName.slice(0, 120), req.session.user.id);

  if (gym) {
    const gymAdmin = db.prepare("SELECT * FROM users WHERE id=?").get(gym.admin_user_id);
    const captain = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
    mailer.send(mailer.gymAttachmentRequestEmail({
      gymAdmin, gymName: gym.name, teamName: team.name,
      captainName: `${captain.first_name} ${captain.last_name}`.trim(), captainEmail: captain.email,
    }));
  } else {
    // Typed a gym name with no match in the system — nobody to notify
    // automatically yet, so flag it for GLG HQ to follow up manually.
    const notice = mailer.adminNotifyEmail({
      subject: `Team "${team.name}" requested an unlisted gym: "${requestedName}"`,
      lines: [`Team "${team.name}" (team_id ${team.id}) wants to join a gym called "${requestedName}", which doesn't exist in the system yet.`, `Follow up with the team captain to confirm/create the gym.`],
    });
    if (notice) mailer.send(notice);
  }

  res.redirect('/gym/team/' + req.params.id + '?requested=1');
});

app.post('/gym/attachment-requests/:reqId/approve', requireLogin, requireRole('gym_admin'), (req, res) => {
  const request = db.prepare("SELECT * FROM gym_attachment_requests WHERE id=? AND status='pending'").get(req.params.reqId);
  if (!request || !request.gym_id) return res.redirect('/gym');
  const gym = db.prepare("SELECT * FROM gyms WHERE id=? AND admin_user_id=?").get(request.gym_id, req.session.user.id);
  if (!gym) return res.status(403).render('error', { title: 'Access Denied', message: "You don't have permission to action this request." });

  const team = db.prepare("SELECT * FROM teams WHERE id=?").get(request.team_id);
  db.prepare("UPDATE teams SET gym_id=? WHERE id=?").run(gym.id, team.id);
  db.prepare("UPDATE gym_attachment_requests SET status='approved', decided_at=CURRENT_TIMESTAMP WHERE id=?").run(request.id);

  const captain = db.prepare("SELECT * FROM users WHERE id=?").get(team.captain_user_id);
  if (captain) mailer.send(mailer.gymAttachmentDecisionEmail({ user: captain, teamName: team.name, gymName: gym.name, approved: true }));

  res.redirect('/gym');
});

app.post('/gym/attachment-requests/:reqId/reject', requireLogin, requireRole('gym_admin'), (req, res) => {
  const request = db.prepare("SELECT * FROM gym_attachment_requests WHERE id=? AND status='pending'").get(req.params.reqId);
  if (!request || !request.gym_id) return res.redirect('/gym');
  const gym = db.prepare("SELECT * FROM gyms WHERE id=? AND admin_user_id=?").get(request.gym_id, req.session.user.id);
  if (!gym) return res.status(403).render('error', { title: 'Access Denied', message: "You don't have permission to action this request." });

  db.prepare("UPDATE gym_attachment_requests SET status='rejected', decided_at=CURRENT_TIMESTAMP WHERE id=?").run(request.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=?").get(request.team_id);
  const captain = db.prepare("SELECT * FROM users WHERE id=?").get(team.captain_user_id);
  if (captain) mailer.send(mailer.gymAttachmentDecisionEmail({ user: captain, teamName: team.name, gymName: gym.name, approved: false }));

  res.redirect('/gym');
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
  // Pending until GLG HQ approves the gym's admission — the click-through
  // notification review on the admin dashboard is what flips this to active.
  const uid = db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,phone,status) VALUES (?,?,?,?,?,?,'pending')`)
    .run(email.trim().toLowerCase(), hash, 'gym_admin', (admin_first_name || gym_name).trim().slice(0,80), (admin_last_name || '').trim().slice(0,80), (phone || '').trim() || null).lastInsertRowid;

  const gymId = db.prepare(`INSERT INTO gyms (name, region_id, admin_user_id, address, status) VALUES (?,?,?,?,'pending')`)
    .run(gym_name.trim().slice(0,120), region_id, uid, address ? address.trim().slice(0,200) : null).lastInsertRowid;

  // Allow comma-separated team names, creating 1+ teams at signup (flexibility: 1 gym -> many teams).
  // Capped at 20 teams and 80 chars per name at signup time to prevent abuse — more can be added later from the dashboard.
  const names = (team_names || gym_name + ' Team A').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  for (const n of names) {
    db.prepare(`INSERT INTO teams (name, gym_id, region_id) VALUES (?,?,?)`).run(n.slice(0,80), gymId, region_id);
  }

  req.session.user = { id: uid, email: email.trim().toLowerCase(), role: 'gym_admin', first_name: admin_first_name, last_name: admin_last_name };

  const gymRegionRow = regions.find(r => String(r.id) === String(region_id));
  mailer.send(mailer.welcomeGymEmail({
    user: { first_name: (admin_first_name || '').trim(), email: email.trim().toLowerCase() },
    gymName: gym_name.trim(),
    regionName: gymRegionRow ? gymRegionRow.name : null,
    teamNames: names,
  }));
  const gymNotice = mailer.adminNotifyEmail({
    subject: `New gym registered: ${gym_name.trim()}`,
    lines: [
      `${gym_name.trim()} just registered, admin contact ${(admin_first_name || '').trim()} ${(admin_last_name || '').trim()} (${email.trim().toLowerCase()}).`,
      `Region: ${gymRegionRow ? gymRegionRow.name : region_id}`,
      `Team(s) created: ${names.join(', ')}`,
    ],
  });

  // Auto-provision the 5 standing category-judge logins for this gym — no
  // manual per-judge setup needed. Each gets its own random password
  // (24-hour expiry) since these placeholder addresses aren't inboxes
  // anyone actually checks — the admin relays login + password to whoever's
  // judging each category on the day, or generates fresh ones any time from
  // the dashboard's "Generate Passwords" button.
  const gymRow = db.prepare("SELECT * FROM gyms WHERE id=?").get(gymId);
  const judges = autoCreateGymJudges(gymRow, email.trim().toLowerCase());
  mailer.send(mailer.gymJudgesCreatedEmail({
    user: { first_name: (admin_first_name || '').trim(), email: email.trim().toLowerCase() },
    gymName: gym_name.trim(),
    judges: judges.map(j => ({ label: CATEGORY_LABEL[j.category], email: j.email, password: j.password })),
  }));
  if (gymNotice) mailer.send(gymNotice);

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
  db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,phone,bio,approved,status) VALUES (?,?,?,?,?,?,?,0,'pending')`)
    .run(email.trim().toLowerCase(), hash, 'league_operator', first_name.trim().slice(0,80), last_name.trim().slice(0,80), (phone || '').trim() || null, `Proposed region: ${proposed_region.trim().slice(0,120)}\n\n${safePitch}`);

  mailer.send(mailer.leagueApplicationReceivedEmail({
    user: { first_name: first_name.trim(), email: email.trim().toLowerCase() },
    proposedRegion: proposed_region.trim(),
  }));
  const leagueNotice = mailer.adminNotifyEmail({
    subject: `New region application: ${proposed_region.trim()}`,
    lines: [
      `${first_name.trim()} ${last_name.trim()} (${email.trim().toLowerCase()}) applied to run a region.`,
      `Proposed region: ${proposed_region.trim()}`,
      `Pitch: ${safePitch || '(none provided)'}`,
      `Review at ${process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au'}/admin`,
    ],
  });
  if (leagueNotice) mailer.send(leagueNotice);

  res.render('signup-league', { title: 'Apply to Run a Region', error: null, success: true });
});

// ============ ATHLETE PROFILE ============

app.get('/profile', requireLogin, (req, res) => {
  if (req.session.user.role !== 'athlete') return res.redirect(roleHome(req.session.user.role));
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  const athlete = db.prepare("SELECT * FROM athletes WHERE user_id=?").get(user.id);
  // LEFT JOIN, not JOIN — a captain-run team may not have a gym yet, and an
  // INNER JOIN here would silently make that team disappear from their own profile.
  const team = athlete.team_id ? db.prepare("SELECT t.*, g.name as gym_name FROM teams t LEFT JOIN gyms g ON g.id=t.gym_id WHERE t.id=?").get(athlete.team_id) : null;
  const isCaptain = !!(team && team.captain_user_id === user.id);
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

  res.render('profile', { title: 'My Profile', user, athlete, team, region, history, isCaptain, welcome: req.query.welcome });
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

// Shared by GET /gym and the two judge-password actions below, since both
// of those need to re-render the full dashboard (with a one-time password
// table bolted on) rather than redirect and lose that data.
function renderGymDashboard(req, res, extra = {}) {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const teams = db.prepare("SELECT * FROM teams WHERE gym_id=?").all(gym.id);
  const rosterCounts = {};
  for (const t of teams) {
    rosterCounts[t.id] = db.prepare("SELECT COUNT(*) c FROM athletes WHERE team_id=?").get(t.id).c;
  }
  // Standing category-judge logins for this gym — created automatically at
  // signup for new gyms; existing gyms from before this feature see a
  // "Generate" button instead until they click it once.
  const gymAdminUser = db.prepare("SELECT email FROM users WHERE id=?").get(gym.admin_user_id);
  const gymSlug = slugifyForEmail(gym.name);
  const judgeDomain = (gymAdminUser.email.split('@')[1] || '').trim();
  const standingJudges = Object.keys(CATEGORY_LABEL).map(category => {
    const email = `${category}+${gymSlug}@${judgeDomain}`;
    const exists = !!db.prepare("SELECT id FROM users WHERE email=?").get(email);
    return { category, label: CATEGORY_LABEL[category], email, exists };
  });
  const allJudgesExist = standingJudges.every(j => j.exists);
  // unassigned pool in this gym's region
  const pool = db.prepare(`
    SELECT a.id as athlete_id, u.first_name, u.last_name, u.gender, u.email
    FROM athletes a JOIN users u ON u.id=a.user_id
    WHERE a.region_id=? AND a.team_id IS NULL AND a.wants_team=1
  `).all(gym.region_id);

  // Pending requests from team captains asking to attach their (gym-less)
  // team to this gym — needs this gym admin's explicit approve/reject.
  const pendingAttachmentRequests = db.prepare(`
    SELECT r.id, r.created_at, t.name as team_name, t.id as team_id, u.first_name, u.last_name, u.email
    FROM gym_attachment_requests r
    JOIN teams t ON t.id=r.team_id
    JOIN users u ON u.id=r.requested_by
    WHERE r.gym_id=? AND r.status='pending' ORDER BY r.created_at
  `).all(gym.id);

  res.render('gym-dashboard', {
    title: gym.name, gym, teams, rosterCounts, pool, pendingAttachmentRequests, standingJudges, allJudgesExist,
    welcome: req.query.welcome, judgesGenerated: req.query.judgesGenerated, generatedPasswords: null,
    ...extra,
  });
}

app.get('/gym', requireLogin, requireRole('gym_admin'), (req, res) => {
  renderGymDashboard(req, res);
});

app.post('/gym/judges/generate', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const adminUser = db.prepare("SELECT email, first_name FROM users WHERE id=?").get(gym.admin_user_id);
  const judges = autoCreateGymJudges(gym, adminUser.email);
  mailer.send(mailer.gymJudgesCreatedEmail({
    user: { first_name: adminUser.first_name, email: adminUser.email },
    gymName: gym.name,
    judges: judges.map(j => ({ label: CATEGORY_LABEL[j.category], email: j.email, password: j.password })),
  }));
  // Shown once, right here — these placeholder addresses aren't real inboxes,
  // so the admin needs the passwords on-screen to relay them, not just emailed.
  renderGymDashboard(req, res, {
    generatedPasswords: judges.map(j => ({ label: CATEGORY_LABEL[j.category], email: j.email, password: j.password })),
  });
});

// Rotates all 5 judges' passwords — for competition day, or any time the
// gym admin wants a fresh set (e.g. the last set's 24-hour window lapsed).
app.post('/gym/judges/generate-passwords', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const adminUser = db.prepare("SELECT email, first_name FROM users WHERE id=?").get(gym.admin_user_id);
  const rotated = rotateGymJudgePasswords(gym, adminUser.email);
  renderGymDashboard(req, res, {
    generatedPasswords: rotated.filter(j => j.exists).map(j => ({ label: CATEGORY_LABEL[j.category], email: j.email, password: j.password })),
  });
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

// Batch pool assignment — one submit sets a team for as many pool athletes
// as the gym admin filled in, instead of a separate Assign button per row.
// Rows left on "leave unassigned" are simply skipped.
app.post('/gym/pool/assign', requireLogin, requireRole('gym_admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
  const assignments = req.body.assignments || {};
  for (const [athleteId, teamId] of Object.entries(assignments)) {
    if (!teamId) continue; // left unassigned — skip rather than error
    // verify the team belongs to this gym before trusting a client-supplied id
    const team = db.prepare("SELECT * FROM teams WHERE id=? AND gym_id=?").get(teamId, gym.id);
    if (team) {
      db.prepare("UPDATE athletes SET team_id=?, wants_team=0 WHERE id=?").run(team.id, athleteId);
    }
  }
  res.redirect('/gym');
});

app.get('/gym/team/:id', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const gym = team.gym_id ? db.prepare("SELECT * FROM gyms WHERE id=?").get(team.gym_id) : null;
  const isCaptain = team.captain_user_id === req.session.user.id;
  const pendingRequest = db.prepare("SELECT * FROM gym_attachment_requests WHERE team_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(team.id);
  const roster = db.prepare(`
    SELECT a.id as athlete_id, u.id as user_id, u.first_name, u.last_name, u.gender, u.email, u.phone, u.status, a.category
    FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=?`).all(team.id);
  res.render('gym-team-detail', {
    title: team.name, team, roster, gym, hasRealGym: isRealGym(gym), isCaptain, pendingRequest,
    resetPasswordFor: null, newPassword: null, welcome: req.query.welcome,
  });
});

// Approve a pending athlete onto this roster (captain or gym admin) — the
// "someone attached to a team gets approved by the gym/captain" leg of the
// signup-approval requirement. Suspend is the same control in reverse, e.g.
// for a no-show or a account under review, without deleting their history.
app.post('/gym/team/:id/roster/:athleteId/approve', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND team_id=?").get(req.params.athleteId, team.id);
  if (athlete) db.prepare("UPDATE users SET status='active' WHERE id=?").run(athlete.user_id);
  res.redirect('/gym/team/' + team.id);
});
app.post('/gym/team/:id/roster/:athleteId/suspend', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND team_id=?").get(req.params.athleteId, team.id);
  if (athlete) db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(athlete.user_id);
  res.redirect('/gym/team/' + team.id);
});

app.post('/gym/team/:id/edit', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const name = (req.body.name || '').trim().slice(0, 80);
  const division = (req.body.division || 'Open').trim().slice(0, 40);
  if (!name) return res.redirect(`/gym/team/${team.id}?error=name`);

  const dupe = db.prepare("SELECT id FROM teams WHERE region_id=? AND name = ? COLLATE NOCASE AND id != ?").get(team.region_id, name, team.id);
  if (dupe) return res.redirect(`/gym/team/${team.id}?error=teamnametaken`);

  db.prepare("UPDATE teams SET name=?, division=? WHERE id=?").run(name, division, team.id);
  res.redirect(`/gym/team/${team.id}?teamsaved=1`);
});

app.post('/gym/team/:id/remove-athlete', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  db.prepare("UPDATE athletes SET team_id=NULL, wants_team=1, category=NULL WHERE id=? AND team_id=?").run(req.body.athlete_id, team.id);
  res.redirect('/gym/team/' + req.params.id);
});

app.post('/gym/team/:id/update-member', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;

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

// Batch version of update-member — the roster form submits every row's
// edits in one request instead of needing a separate Save click per row.
// Same validation as the single-row route, applied per member; a bad row is
// skipped (with its error reported) rather than discarding everyone else's
// valid changes in the same submission.
app.post('/gym/team/:id/update-members', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const validCategories = ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles', ''];
  const raw = req.body.members || {};
  const rows = Array.isArray(raw) ? raw : Object.values(raw);

  const errors = [];
  let savedCount = 0;
  for (const m of rows) {
    if (!m || !m.athlete_id) continue;
    const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND team_id=?").get(m.athlete_id, team.id);
    if (!athlete) continue; // not on this team — ignore rather than trust client-supplied ids blindly

    const first_name = (m.first_name || '').trim();
    const last_name = (m.last_name || '').trim();
    const email = (m.email || '').trim().toLowerCase();
    const phone = (m.phone || '').trim();
    const gender = m.gender;
    const category = m.category || '';
    const label = first_name || `member #${m.athlete_id}`;

    if (!isReasonableLength(first_name, 80) || !isOptionalReasonableLength(last_name, 80)) { errors.push(`${label}: invalid name`); continue; }
    if (!isValidEmail(email)) { errors.push(`${label}: invalid email`); continue; }
    const existingEmail = db.prepare("SELECT id FROM users WHERE email=? AND id!=(SELECT user_id FROM athletes WHERE id=?)").get(email, m.athlete_id);
    if (existingEmail) { errors.push(`${label}: email already in use`); continue; }
    if (gender !== 'M' && gender !== 'F') { errors.push(`${label}: invalid gender`); continue; }
    if (!validCategories.includes(category)) { errors.push(`${label}: invalid category`); continue; }

    db.prepare("UPDATE users SET first_name=?, last_name=?, email=?, gender=?, phone=? WHERE id=?")
      .run(first_name, last_name, email, gender, phone || null, athlete.user_id);
    db.prepare("UPDATE athletes SET category=? WHERE id=?").run(category || null, m.athlete_id);
    savedCount++;
  }

  if (errors.length) {
    return res.redirect(`/gym/team/${team.id}?batchSaved=${savedCount}&batchErrors=${encodeURIComponent(errors.join('; '))}`);
  }
  res.redirect(`/gym/team/${team.id}?saved=1&savedCount=${savedCount}`);
});

// Gym admin (or captain) directly creates one or more new members on their
// team in a single submit — for people who haven't signed up themselves
// yet. A default password is set for each; the gym should let the athlete
// know it so they can log in (no email/reset infrastructure is wired up
// yet — see README). A bad row is skipped (with its error reported) rather
// than discarding everyone else's valid entries in the same submission,
// same pattern as the roster batch-edit route.
app.post('/gym/team/:id/add-members', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const gym = team.gym_id ? db.prepare("SELECT * FROM gyms WHERE id=?").get(team.gym_id) : null;
  const validCategories = ['mens_singles', 'womens_singles', 'mens_doubles', 'womens_doubles', 'mixed_doubles', ''];
  const raw = req.body.newmembers || {};
  const rows = Array.isArray(raw) ? raw : Object.values(raw);

  const DEFAULT_PASSWORD = 'GLGWelcome2026!';
  const errors = [];
  let addedCount = 0;

  for (const m of rows) {
    if (!m) continue;
    const first_name = (m.first_name || '').trim();
    const last_name = (m.last_name || '').trim();
    const email = (m.email || '').trim().toLowerCase();
    const phone = (m.phone || '').trim();
    const gender = m.gender;
    const category = m.category || '';
    const label = first_name || email || 'a new member';

    // An entirely blank row (from an unused "+" slot left in the form) is
    // silently skipped rather than reported as an error.
    if (!first_name && !email) continue;

    if (!isReasonableLength(first_name, 80) || !isOptionalReasonableLength(last_name, 80)) { errors.push(`${label}: invalid name`); continue; }
    if (!isValidEmail(email)) { errors.push(`${label}: invalid email`); continue; }
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) { errors.push(`${label}: email already in use`); continue; }
    if (gender !== 'M' && gender !== 'F') { errors.push(`${label}: invalid gender`); continue; }
    if (!validCategories.includes(category)) { errors.push(`${label}: invalid category`); continue; }

    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    const uid = db.prepare("INSERT INTO users (email,password_hash,role,first_name,last_name,gender,phone) VALUES (?,?,?,?,?,?,?)")
      .run(email, hash, 'athlete', first_name, last_name, gender, phone || null).lastInsertRowid;
    db.prepare("INSERT INTO athletes (user_id, region_id, team_id, wants_team, category) VALUES (?,?,?,0,?)")
      .run(uid, team.region_id, team.id, category || null);

    mailer.send(mailer.addedByGymEmail({
      user: { first_name, email },
      gymName: gym ? gym.name : `${team.name} (a captain-run team)`,
      teamName: team.name,
      tempPassword: DEFAULT_PASSWORD,
    }));
    addedCount++;
  }

  if (errors.length) {
    return res.redirect(`/gym/team/${team.id}?addedCount=${addedCount}&addErrors=${encodeURIComponent(errors.join('; '))}`);
  }
  res.redirect(`/gym/team/${req.params.id}?added=1&addedCount=${addedCount}`);
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

app.post('/gym/team/:id/reset-password', requireLogin, requireCanManageTeam, (req, res) => {
  const team = req.managedTeam;
  const gym = team.gym_id ? db.prepare("SELECT * FROM gyms WHERE id=?").get(team.gym_id) : null;

  const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND team_id=?").get(req.body.athlete_id, team.id);
  if (!athlete) return res.redirect('/gym/team/' + req.params.id);

  const newPassword = generateTempPassword();
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, athlete.user_id);

  // Re-render directly (not a redirect) so the new password can be shown once,
  // in the response — never put a raw password in a URL/query string.
  const roster = db.prepare(`
    SELECT a.id as athlete_id, u.id as user_id, u.first_name, u.last_name, u.gender, u.email, u.phone, u.status, a.category
    FROM athletes a JOIN users u ON u.id=a.user_id WHERE a.team_id=?`).all(team.id);
  res.render('gym-team-detail', {
    title: team.name, team, roster, gym, hasRealGym: isRealGym(gym),
    isCaptain: team.captain_user_id === req.session.user.id,
    pendingRequest: db.prepare("SELECT * FROM gym_attachment_requests WHERE team_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(team.id),
    resetPasswordFor: athlete.id, newPassword, welcome: null,
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

// Narrower than canManageFixture: gyms can view the results page, run Cast
// Display, and control the clock for their own fixtures — but entering or
// changing scores is judges-and-GLG-admin-only. Judges use their own
// category-scoped routes (below), which already restrict which categories
// they can touch; this gate is for the full, unscoped results form.
function canEditFixtureResults(user) {
  return !!user && user.role === 'admin';
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
    canEditResults: canEditFixtureResults(req.session.user),
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
  if (!canEditFixtureResults(req.session.user)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "Only judges and GLG Admin can enter or change results." });
  }

  applyResultsFromBody(fixture, req.body, null);
  db.prepare("UPDATE fixtures SET status='complete' WHERE id=?").run(fixtureId);

  res.redirect(`/fixture/${fixtureId}/results?saved=1`);
});

// ---- Clear all results for a fixture (wipes test data before a real event) ----
// Deliberately separate from the results form: blanking a field there is
// ignored, so this is the only way to remove scores. Clock is untouched.
app.post('/fixture/:id/clear-results', requireLogin, (req, res) => {
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=?").get(req.params.id);
  if (!fixture || !canEditFixtureResults(req.session.user)) {
    return res.status(403).render('error', { title: 'Access Denied', message: "Only judges and GLG Admin can clear results." });
  }
  db.prepare("DELETE FROM category_results WHERE fixture_id=?").run(fixture.id);
  db.prepare("DELETE FROM category_gate4_results WHERE fixture_id=?").run(fixture.id);
  scoring.recomputeFixtureScores(fixture.id);
  res.redirect(`/fixture/${fixture.id}/results?cleared=1`);
});

// ---- Judge assignment (gym admin / GLG admin assigns a judge to a category for a fixture) ----
app.post('/fixture/:id/assign-judge', requireLogin, (req, res) => {
  const fixture = db.prepare(`
    SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
    JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.id=?`).get(req.params.id);
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
  let wasNewAccount = false;
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
    wasNewAccount = true;
  }

  db.prepare("INSERT OR IGNORE INTO judge_assignments (user_id, fixture_id, category) VALUES (?,?,?)")
    .run(judge.id, fixture.id, category);

  // Email the judge their assignment + login details (fire-and-forget; the
  // assignment stands even if mail is down or not configured yet).
  mailer.send(mailer.judgeAssignmentEmail({
    judge,
    category_label: CATEGORY_LABEL[category],
    fixture,
    isNewAccount: wasNewAccount,
    defaultPassword: 'GLGWelcome2026!',
  }));
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

  const CATEGORY_ORDER = ['womens_singles','womens_doubles','mixed_doubles','mens_doubles','mens_singles'];

  res.render('judge-live', {
    title: `Live — ${CATEGORY_LABEL[category]}`, layout: false,
    fixture, category, categoryLabel: CATEGORY_LABEL,
    catIndex: CATEGORY_ORDER.indexOf(category),
    exercises, resultMap, g4Map,
    namesA: namesFor(fixture.team_a_id), namesB: namesFor(fixture.team_b_id),
  });
});

// Context for the Wedgetail camera counter: which exercises + team ids this
// judge can write live rep counts against, so the counter can be pointed at
// a real fixture/category instead of running as a disconnected prototype.
app.get('/api/judge/fixture/:fixtureId/category/:category/context', requireLogin, requireRole('judge'), (req, res) => {
  const fixture = judgeLiveGuard(req, res);
  if (!fixture) return res.status(403).json({ error: 'not assigned' });

  const exercises = db.prepare(`
    SELECT e.id, e.name, g.number as gate_number, g.is_sprint_finish
    FROM exercises e JOIN gates g ON g.id=e.gate_id
    WHERE g.is_sprint_finish = 0
    ORDER BY g.number, e.sort_order`).all();

  res.json({
    fixture_id: fixture.id,
    category: req.params.category,
    team_a: { id: fixture.team_a_id, name: fixture.team_a_name },
    team_b: { id: fixture.team_b_id, name: fixture.team_b_name },
    exercises,
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
  // Accumulated whole-match totals per team — shown flanking the master clock.
  const totals = {};
  for (const r of [...rows, ...g4rows]) totals[r.team_id] = (totals[r.team_id] || 0) + (r.points || 0);
  byKey._totals = totals;
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
  // Each tile also gets a status breakdown so the tile itself hints at what's
  // waiting on you before you even click through to the full list.
  const breakdown = (table, col = 'status') => {
    const rows = db.prepare(`SELECT ${col} as k, COUNT(*) c FROM ${table} GROUP BY ${col}`).all();
    const out = {};
    rows.forEach(r => out[r.k || 'active'] = r.c);
    return out;
  };
  const stats = {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    gyms: db.prepare("SELECT COUNT(*) c FROM gyms WHERE is_unassigned=0").get().c,
    teams: db.prepare("SELECT COUNT(*) c FROM teams").get().c,
    athletes: db.prepare("SELECT COUNT(*) c FROM athletes").get().c,
    fixtures: db.prepare("SELECT COUNT(*) c FROM fixtures").get().c,
  };
  const statusBreakdown = {
    users: breakdown('users'),
    gyms: db.prepare("SELECT status as k, COUNT(*) c FROM gyms WHERE is_unassigned=0 GROUP BY status").all()
      .reduce((o, r) => (o[r.k || 'active'] = r.c, o), {}),
  };
  const pendingOperators = db.prepare("SELECT * FROM users WHERE role='league_operator' AND approved=0").all();
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' ORDER BY name").all();
  const allRegions = db.prepare("SELECT * FROM regions ORDER BY level, name").all();

  // An in-app safety net alongside the admin notification emails — so a new
  // signup is still visible here even if ADMIN_NOTIFY_EMAIL isn't set yet,
  // or an email happens to get lost. Last 10 of each, newest first. Each row
  // links through to a review page — click in, see the full detail, approve
  // or reject right there.
  const recentGyms = db.prepare(`
    SELECT g.id, g.name, g.status, g.created_at, u.first_name, u.last_name, u.email, r.name as region_name
    FROM gyms g JOIN users u ON u.id=g.admin_user_id LEFT JOIN regions r ON r.id=g.region_id
    WHERE g.is_unassigned=0
    ORDER BY g.created_at DESC LIMIT 10
  `).all();
  const recentAthletes = db.prepare(`
    SELECT a.id as athlete_id, u.id as user_id, u.first_name, u.last_name, u.email, u.status, u.created_at, r.name as region_name, t.name as team_name
    FROM athletes a JOIN users u ON u.id=a.user_id LEFT JOIN regions r ON r.id=a.region_id LEFT JOIN teams t ON t.id=a.team_id
    ORDER BY u.created_at DESC LIMIT 10
  `).all();

  // Captain-run teams with no gym attached — surfaced for manual admin
  // follow-up (chase the captain, help find them a gym, or dissolve the
  // team). No auto-expiry: every gym-less team shows here until resolved.
  const orphanedTeams = db.prepare(`
    SELECT t.id, t.name, t.created_at, r.name as region_name,
           u.first_name as captain_first_name, u.last_name as captain_last_name, u.email as captain_email
    FROM teams t
    LEFT JOIN regions r ON r.id=t.region_id
    LEFT JOIN users u ON u.id=t.captain_user_id
    LEFT JOIN gyms g ON g.id=t.gym_id
    WHERE t.gym_id IS NULL OR g.is_unassigned=1
    ORDER BY t.created_at
  `).all();

  res.render('admin-dashboard', {
    title: 'GLG Admin', stats, statusBreakdown, pendingOperators, regions: allRegions, regionOptions: regions, storage: db.storageInfo(),
    recordingStorage: storage.storageDiagnostics(),
    recentGyms, recentAthletes, orphanedTeams, adminNotifyConfigured: !!process.env.ADMIN_NOTIFY_EMAIL,
  });
});

// ============================================================================
// ADMIN CONTROL PANEL — global CRUD over users, gyms, teams, athletes.
// "Admin can do anything a franchisee, gym, captain, or user can do" — these
// routes are the global (admin) tier of the shared canManageUser() hierarchy
// defined near the top of this file. requireRole('admin') keeps this tier
// admin-only for now; league_operator/gym_admin get the scoped equivalents
// on their own dashboards (see /league and /gym below).
// ============================================================================

app.get('/admin/users', requireLogin, requireRole('admin'), (req, res) => {
  const { role, status } = req.query;
  let sql = `SELECT u.*, g.name as owns_gym_name, tc.name as captain_of_team
             FROM users u
             LEFT JOIN gyms g ON g.admin_user_id = u.id
             LEFT JOIN teams tc ON tc.captain_user_id = u.id
             WHERE 1=1`;
  const params = [];
  if (role) { sql += ' AND u.role=?'; params.push(role); }
  if (status) { sql += ' AND u.status=?'; params.push(status); }
  sql += ' ORDER BY u.created_at DESC';
  const users = db.prepare(sql).all(...params);
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' ORDER BY name").all();
  res.render('admin-users', { title: 'All Users', users, regions, roleFilter: role || '', statusFilter: status || '', error: req.query.error || null });
});

app.post('/admin/users/new', requireLogin, requireRole('admin'), (req, res) => {
  const { email, password, role, first_name, last_name, region_id } = req.body;
  const validRoles = ['athlete', 'gym_admin', 'league_operator', 'judge', 'admin'];
  if (!isValidEmail(email) || !isValidPassword(password) || !validRoles.includes(role) || !isReasonableLength(first_name, 80)) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Please fill in a valid email, password (6+ chars), name and role.'));
  }
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email.trim().toLowerCase())) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('An account with that email already exists.'));
  }
  const hash = bcrypt.hashSync(password, 10);
  // Admin-created accounts start active — admin creating them IS the approval.
  const uid = db.prepare(`INSERT INTO users (email,password_hash,role,first_name,last_name,region_id,status) VALUES (?,?,?,?,?,?,'active')`)
    .run(email.trim().toLowerCase(), hash, role, first_name.trim().slice(0,80), (last_name||'').trim().slice(0,80), role === 'league_operator' ? (region_id || null) : null).lastInsertRowid;
  if (role === 'athlete') {
    const regionValid = region_id && db.prepare("SELECT id FROM regions WHERE id=?").get(region_id);
    db.prepare("INSERT INTO athletes (user_id, region_id, wants_team) VALUES (?,?,1)").run(uid, regionValid ? region_id : null);
  }
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/status', requireLogin, requireRole('admin'), (req, res) => {
  const status = req.body.status;
  if (!['pending', 'active', 'suspended'].includes(status)) return res.redirect('/admin/users');
  db.prepare("UPDATE users SET status=? WHERE id=?").run(status, req.params.id);
  res.redirect(req.get('Referrer') || '/admin/users');
});

// Deleting a person can leave dangling references (they run a gym, captain a
// team, judge a fixture, etc.) — rather than cascading destructively, detach
// the roles they held (gym/team keep existing, just ownerless) and remove
// the account itself. Scoring history (category_results etc.) is untouched.
app.post('/admin/users/:id/delete', requireLogin, requireRole('admin'), (req, res) => {
  const id = req.params.id;
  db.prepare("UPDATE gyms SET admin_user_id=NULL WHERE admin_user_id=?").run(id);
  db.prepare("UPDATE teams SET captain_user_id=NULL WHERE captain_user_id=?").run(id);
  db.prepare("DELETE FROM athletes WHERE user_id=?").run(id);
  try {
    db.prepare("DELETE FROM users WHERE id=?").run(id);
  } catch (e) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Could not delete — this account is still referenced elsewhere (e.g. judge assignments or recordings).'));
  }
  res.redirect('/admin/users');
});

// Promote an athlete to captain of a brand-new (Unassigned-gym) team — the
// "make an athlete a captain" control. If they're already on a team's roster,
// they're moved onto the new team they'll now captain.
app.post('/admin/users/:id/make-captain', requireLogin, requireRole('admin'), (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=? AND role='athlete'").get(req.params.id);
  if (!user) return res.redirect('/admin/users?error=' + encodeURIComponent('Only an athlete can be made a captain.'));
  const athlete = db.prepare("SELECT * FROM athletes WHERE user_id=?").get(user.id);
  const regionId = (athlete && athlete.region_id) || req.body.region_id;
  if (!regionId) return res.redirect('/admin/users?error=' + encodeURIComponent('This athlete has no region on file — set one first.'));
  const teamName = (req.body.team_name || `${user.first_name}'s Team`).trim().slice(0, 80);
  const dupe = db.prepare("SELECT id FROM teams WHERE region_id=? AND name = ? COLLATE NOCASE").get(regionId, teamName);
  if (dupe) return res.redirect('/admin/users?error=' + encodeURIComponent('A team with that name already exists in this region.'));
  const unassignedGym = getUnassignedGym(regionId);
  const teamId = db.prepare("INSERT INTO teams (name, gym_id, region_id, division, captain_user_id) VALUES (?,?,?,?,?)")
    .run(teamName, unassignedGym.id, regionId, 'Open', user.id).lastInsertRowid;
  if (athlete) {
    db.prepare("UPDATE athletes SET team_id=?, wants_team=0 WHERE id=?").run(teamId, athlete.id);
  } else {
    db.prepare("INSERT INTO athletes (user_id, region_id, team_id, wants_team) VALUES (?,?,?,0)").run(user.id, regionId, teamId);
  }
  res.redirect('/admin/users');
});

app.get('/admin/gyms', requireLogin, requireRole('admin'), (req, res) => {
  const gyms = db.prepare(`
    SELECT g.*, u.first_name, u.last_name, u.email, r.name as region_name,
           (SELECT COUNT(*) FROM teams t WHERE t.gym_id=g.id) as team_count
    FROM gyms g LEFT JOIN users u ON u.id=g.admin_user_id LEFT JOIN regions r ON r.id=g.region_id
    WHERE g.is_unassigned=0 ORDER BY g.created_at DESC
  `).all();
  const regions = db.prepare("SELECT * FROM regions WHERE level='region' ORDER BY name").all();
  res.render('admin-gyms', { title: 'All Gyms', gyms, regions, error: req.query.error || null });
});

app.post('/admin/gyms/new', requireLogin, requireRole('admin'), (req, res) => {
  const { name, region_id, address } = req.body;
  if (!isReasonableLength(name, 120) || !db.prepare("SELECT id FROM regions WHERE id=?").get(region_id)) {
    return res.redirect('/admin/gyms?error=' + encodeURIComponent('Please enter a gym name and choose a valid region.'));
  }
  db.prepare("INSERT INTO gyms (name, region_id, admin_user_id, address, status) VALUES (?,?,NULL,?,'active')")
    .run(name.trim().slice(0,120), region_id, (address||'').trim().slice(0,200) || null);
  res.redirect('/admin/gyms');
});

app.post('/admin/gyms/:id/status', requireLogin, requireRole('admin'), (req, res) => {
  const status = req.body.status;
  if (!['pending', 'active', 'suspended'].includes(status)) return res.redirect('/admin/gyms');
  const gym = db.prepare("SELECT * FROM gyms WHERE id=? AND is_unassigned=0").get(req.params.id);
  if (!gym) return res.redirect('/admin/gyms');
  db.prepare("UPDATE gyms SET status=? WHERE id=?").run(status, gym.id);
  // Approving a gym also activates its admin's own account, if that account
  // was still sitting pending on the same signup.
  if (status === 'active' && gym.admin_user_id) {
    db.prepare("UPDATE users SET status='active' WHERE id=? AND status='pending'").run(gym.admin_user_id);
  }
  res.redirect(req.get('Referrer') || '/admin/gyms');
});

app.post('/admin/gyms/:id/delete', requireLogin, requireRole('admin'), (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE id=? AND is_unassigned=0").get(req.params.id);
  if (!gym) return res.redirect('/admin/gyms');
  const teamCount = db.prepare("SELECT COUNT(*) c FROM teams WHERE gym_id=?").get(gym.id).c;
  if (teamCount > 0) {
    return res.redirect('/admin/gyms?error=' + encodeURIComponent(`Can't delete ${gym.name} — it still has ${teamCount} team(s). Move or remove them first.`));
  }
  db.prepare("DELETE FROM gyms WHERE id=?").run(gym.id);
  res.redirect('/admin/gyms');
});

app.get('/admin/teams', requireLogin, requireRole('admin'), (req, res) => {
  const teams = db.prepare(`
    SELECT t.*, g.name as gym_name, g.is_unassigned as gym_is_unassigned, r.name as region_name,
           u.first_name as captain_first_name, u.last_name as captain_last_name,
           (SELECT COUNT(*) FROM athletes a WHERE a.team_id=t.id) as roster_count
    FROM teams t
    LEFT JOIN gyms g ON g.id=t.gym_id
    LEFT JOIN regions r ON r.id=t.region_id
    LEFT JOIN users u ON u.id=t.captain_user_id
    ORDER BY t.created_at DESC
  `).all();
  res.render('admin-teams', { title: 'All Teams', teams });
});

app.get('/admin/athletes', requireLogin, requireRole('admin'), (req, res) => {
  const athletes = db.prepare(`
    SELECT a.id as athlete_id, u.id as user_id, u.first_name, u.last_name, u.email, u.status, u.created_at,
           a.region_id, r.name as region_name, t.id as team_id, t.name as team_name, a.category
    FROM athletes a
    JOIN users u ON u.id=a.user_id
    LEFT JOIN regions r ON r.id=a.region_id
    LEFT JOIN teams t ON t.id=a.team_id
    ORDER BY u.created_at DESC
  `).all();
  const teamsByRegion = {};
  db.prepare("SELECT t.id, t.name, t.region_id FROM teams t").all().forEach(t => {
    (teamsByRegion[t.region_id] ||= []).push(t);
  });
  res.render('admin-athletes', { title: 'All Athletes', athletes, teamsByRegion });
});

app.post('/admin/athletes/:id/assign-team', requireLogin, requireRole('admin'), (req, res) => {
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=?").get(req.params.id);
  if (!athlete) return res.redirect('/admin/athletes');
  const teamId = req.body.team_id || null;
  const team = teamId ? db.prepare("SELECT * FROM teams WHERE id=?").get(teamId) : null;
  db.prepare("UPDATE athletes SET team_id=?, wants_team=? WHERE id=?").run(team ? team.id : null, team ? 0 : 1, athlete.id);
  // Fitting someone into a team is the "action required" that clears an
  // unattached pending athlete — approve them in the same step.
  if (team) db.prepare("UPDATE users SET status='active' WHERE id=? AND status='pending'").run(athlete.user_id);
  res.redirect('/admin/athletes');
});

app.post('/admin/athletes/:id/status', requireLogin, requireRole('admin'), (req, res) => {
  const status = req.body.status;
  if (!['pending', 'active', 'suspended'].includes(status)) return res.redirect('/admin/athletes');
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=?").get(req.params.id);
  if (athlete) db.prepare("UPDATE users SET status=? WHERE id=?").run(status, athlete.user_id);
  res.redirect(req.get('Referrer') || '/admin/athletes');
});

// ---- Notification click-through: review a single gym or athlete signup ----
app.get('/admin/notifications/gym/:id', requireLogin, requireRole('admin'), (req, res) => {
  const gym = db.prepare(`
    SELECT g.*, u.first_name, u.last_name, u.email, u.phone, u.status as admin_status, r.name as region_name
    FROM gyms g LEFT JOIN users u ON u.id=g.admin_user_id LEFT JOIN regions r ON r.id=g.region_id
    WHERE g.id=?
  `).get(req.params.id);
  if (!gym) return res.status(404).render('error', { title: 'Not Found', message: 'Gym not found.' });
  const teams = db.prepare("SELECT * FROM teams WHERE gym_id=?").all(gym.id);
  res.render('admin-notification-gym', { title: gym.name, gym, teams });
});

app.get('/admin/notifications/athlete/:id', requireLogin, requireRole('admin'), (req, res) => {
  const athlete = db.prepare(`
    SELECT a.*, u.first_name, u.last_name, u.email, u.phone, u.status as user_status, r.name as region_name
    FROM athletes a JOIN users u ON u.id=a.user_id LEFT JOIN regions r ON r.id=a.region_id
    WHERE a.id=?
  `).get(req.params.id);
  if (!athlete) return res.status(404).render('error', { title: 'Not Found', message: 'Athlete not found.' });
  const team = athlete.team_id ? db.prepare("SELECT t.*, g.name as gym_name, g.is_unassigned FROM teams t LEFT JOIN gyms g ON g.id=t.gym_id WHERE t.id=?").get(athlete.team_id) : null;
  const availableTeams = db.prepare("SELECT * FROM teams WHERE region_id=? ORDER BY name").all(athlete.region_id);
  res.render('admin-notification-athlete', { title: `${athlete.first_name} ${athlete.last_name}`, athlete, team, availableTeams });
});

app.post('/admin/operators/:id/approve', requireLogin, requireRole('admin'), (req, res) => {
  const regionId = req.body.region_id || null;
  db.prepare("UPDATE users SET approved=1, status='active', region_id=? WHERE id=?").run(regionId, req.params.id);
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
  res.render('admin-region', { title: region.name, region, teams, fixtures, error: req.query.error || null });
});

// ---- Self-service competition setup: add teams, generate/create matches ----
// A "team" created here needs a gym_id (schema requirement + the rest of the
// app assumes every team belongs to a gym) but there's no real gym behind
// it — so we auto-create a minimal placeholder gym with no admin_user_id,
// named after the team. It's cleaned up again if the team is later deleted,
// so these placeholders never pile up.
app.post('/admin/region/:id/teams', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  const name = (req.body.name || '').trim().slice(0, 80);
  if (!name) return res.redirect(`/admin/region/${region.id}`);

  const gymId = db.prepare("INSERT INTO gyms (name, region_id, admin_user_id, address) VALUES (?,?,?,?)")
    .run(`${name} (auto)`, region.id, null, null).lastInsertRowid;
  db.prepare("INSERT INTO teams (name, gym_id, region_id, division) VALUES (?,?,?,?)")
    .run(name, gymId, region.id, 'Open');

  res.redirect(`/admin/region/${region.id}`);
});

// Rename or re-divide a team — GLG Admin can do this for any team in the
// region. (Gym admins / captains have the equivalent on their own team's
// page at /gym/team/:id/edit — deliberately not exposed here too, to avoid
// two different edit forms for the same team.)
app.post('/admin/region/:id/teams/:teamId/edit', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND region_id=?").get(req.params.teamId, region.id);
  if (!team) return res.redirect(`/admin/region/${region.id}`);

  const name = (req.body.name || '').trim().slice(0, 80);
  const division = (req.body.division || 'Open').trim().slice(0, 40);
  if (!name) return res.redirect(`/admin/region/${region.id}?error=${encodeURIComponent('Team name cannot be blank.')}`);

  const dupe = db.prepare("SELECT id FROM teams WHERE region_id=? AND name = ? COLLATE NOCASE AND id != ?").get(region.id, name, team.id);
  if (dupe) return res.redirect(`/admin/region/${region.id}?error=${encodeURIComponent('Another team in this region already has that name.')}`);

  db.prepare("UPDATE teams SET name=?, division=? WHERE id=?").run(name, division, team.id);
  res.redirect(`/admin/region/${region.id}`);
});

// A team can only be removed while it's still empty and untouched — real
// rosters and scored history are exactly what this whole site exists to
// protect, so deleting either here (rather than through a more careful,
// audited flow) is refused outright rather than silently cascading.
app.post('/admin/region/:id/teams/:teamId/delete', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  const team = db.prepare("SELECT * FROM teams WHERE id=? AND region_id=?").get(req.params.teamId, region.id);
  if (!team) return res.redirect(`/admin/region/${region.id}`);

  const rosterCount = db.prepare("SELECT COUNT(*) c FROM athletes WHERE team_id=?").get(team.id).c;
  const playedCount = db.prepare(`
    SELECT COUNT(*) c FROM fixtures WHERE (team_a_id=? OR team_b_id=?) AND status='complete'
  `).get(team.id, team.id).c;

  if (rosterCount > 0 || playedCount > 0) {
    const teams = db.prepare("SELECT t.*, g.name as gym_name FROM teams t JOIN gyms g ON g.id=t.gym_id WHERE t.region_id=?").all(region.id);
    const fixtures = db.prepare(`
      SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
      JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.region_id=? ORDER BY f.week`).all(region.id);
    return res.render('admin-region', {
      title: region.name, region, teams, fixtures,
      error: rosterCount > 0
        ? `Can't remove ${team.name} — it still has ${rosterCount} athlete(s) on its roster.`
        : `Can't remove ${team.name} — it has already played a scored match.`,
    });
  }

  // Also remove any scheduled-but-unplayed fixtures involving this team, so
  // it doesn't leave a dangling fixture pointing at a team that no longer exists.
  db.prepare("DELETE FROM fixtures WHERE (team_a_id=? OR team_b_id=?) AND status!='complete'").run(team.id, team.id);
  db.prepare("DELETE FROM teams WHERE id=?").run(team.id);

  // Only remove the gym if it was one of these auto-created placeholders
  // (no admin account, no other teams still using it) — never touch a real
  // gym that just happens to have lost one of several teams.
  const gym = db.prepare("SELECT * FROM gyms WHERE id=?").get(team.gym_id);
  if (gym && !gym.admin_user_id) {
    const otherTeams = db.prepare("SELECT COUNT(*) c FROM teams WHERE gym_id=?").get(gym.id).c;
    if (otherTeams === 0) db.prepare("DELETE FROM gyms WHERE id=?").run(gym.id);
  }

  res.redirect(`/admin/region/${region.id}`);
});

// Auto-generate matches: pairs whichever teams are ticked, in the order
// given (1v2, 3v4, ...). An odd team out gets flagged rather than silently
// dropped or erroring, so it's obvious a bye happened and why.
app.post('/admin/region/:id/fixtures/generate', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  let teamIds = req.body.team_ids;
  if (!teamIds) teamIds = [];
  if (!Array.isArray(teamIds)) teamIds = [teamIds];
  teamIds = teamIds.map(id => parseInt(id)).filter(Boolean);

  const matchDate = (req.body.match_date || '').trim() || null;
  const maxWeek = db.prepare("SELECT MAX(week) w FROM fixtures WHERE region_id=?").get(region.id).w || 0;
  const nextWeek = maxWeek + 1;

  let byeTeamId = null;
  if (teamIds.length % 2 === 1) byeTeamId = teamIds.pop();

  const insFixture = db.prepare("INSERT INTO fixtures (region_id, week, team_a_id, team_b_id, match_date, status) VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < teamIds.length; i += 2) {
    insFixture.run(region.id, nextWeek, teamIds[i], teamIds[i + 1], matchDate, 'scheduled');
  }

  let error = null;
  if (byeTeamId) {
    const byeTeam = db.prepare("SELECT name FROM teams WHERE id=?").get(byeTeamId);
    error = `${teamIds.length / 2} match(es) created. ${byeTeam ? byeTeam.name : 'One team'} got a bye this round (odd number of teams selected).`;
  }

  if (error) {
    const teams = db.prepare("SELECT t.*, g.name as gym_name FROM teams t JOIN gyms g ON g.id=t.gym_id WHERE t.region_id=?").all(region.id);
    const fixtures = db.prepare(`
      SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
      JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.region_id=? ORDER BY f.week`).all(region.id);
    return res.render('admin-region', { title: region.name, region, teams, fixtures, error, notice: error });
  }

  res.redirect(`/admin/region/${region.id}`);
});

// Manual one-off match — same week-numbering as generate, so a manually
// added match slots in alongside auto-generated ones without clashing.
app.post('/admin/region/:id/fixtures/manual', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  const teamA = parseInt(req.body.team_a_id), teamB = parseInt(req.body.team_b_id);
  const matchDate = (req.body.match_date || '').trim() || null;
  if (!teamA || !teamB || teamA === teamB) return res.redirect(`/admin/region/${region.id}`);

  const maxWeek = db.prepare("SELECT MAX(week) w FROM fixtures WHERE region_id=?").get(region.id).w || 0;
  db.prepare("INSERT INTO fixtures (region_id, week, team_a_id, team_b_id, match_date, status) VALUES (?,?,?,?,?,?)")
    .run(region.id, maxWeek + 1, teamA, teamB, matchDate, 'scheduled');

  res.redirect(`/admin/region/${region.id}`);
});

// A fixture can only be removed while nothing's actually been scored against
// it yet — once results exist, deleting the fixture would silently orphan
// that data instead of protecting it.
app.post('/admin/region/:id/fixtures/:fixtureId/delete', requireLogin, requireRole('admin'), (req, res) => {
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(req.params.id);
  const fixture = db.prepare("SELECT * FROM fixtures WHERE id=? AND region_id=?").get(req.params.fixtureId, region.id);
  if (!fixture) return res.redirect(`/admin/region/${region.id}`);

  const hasResults = db.prepare("SELECT COUNT(*) c FROM category_results WHERE fixture_id=?").get(fixture.id).c
    + db.prepare("SELECT COUNT(*) c FROM category_gate4_results WHERE fixture_id=?").get(fixture.id).c;

  if (hasResults > 0) {
    const teams = db.prepare("SELECT t.*, g.name as gym_name FROM teams t JOIN gyms g ON g.id=t.gym_id WHERE t.region_id=?").all(region.id);
    const fixtures = db.prepare(`
      SELECT f.*, ta.name as team_a_name, tb.name as team_b_name FROM fixtures f
      JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id WHERE f.region_id=? ORDER BY f.week`).all(region.id);
    return res.render('admin-region', { title: region.name, region, teams, fixtures, error: "Can't remove a match that already has results entered." });
  }

  db.prepare("DELETE FROM judge_assignments WHERE fixture_id=?").run(fixture.id);
  db.prepare("DELETE FROM fixture_clocks WHERE fixture_id=?").run(fixture.id);
  db.prepare("DELETE FROM fixtures WHERE id=?").run(fixture.id);

  res.redirect(`/admin/region/${region.id}`);
});

// ============ LEAGUE OPERATOR DASHBOARD (placeholder home once approved) ============
// A franchisee's reach is scoped to the one region assigned to them at
// approval time (see /admin/operators/:id/approve). "A franchisee can do
// anything gyms/athletes/captains within its franchise can do" — this
// dashboard is that scoped tier: same suspend/approve/assign actions as
// admin, filtered down to their region via the shared /admin/* routes plus
// a region_id ownership check on each one below.
function requireOwnRegion(req, res, next) {
  if (!req.session.user.region_id) {
    return res.status(403).render('error', { title: 'No Region Assigned', message: "GLG HQ hasn't assigned you a region yet — reach out to get set up." });
  }
  next();
}
app.get('/league', requireLogin, requireRole('league_operator'), requireOwnRegion, (req, res) => {
  const regionId = req.session.user.region_id;
  const region = db.prepare("SELECT * FROM regions WHERE id=?").get(regionId);
  const gyms = db.prepare(`
    SELECT g.*, u.first_name, u.last_name, u.email,
           (SELECT COUNT(*) FROM teams t WHERE t.gym_id=g.id) as team_count
    FROM gyms g LEFT JOIN users u ON u.id=g.admin_user_id
    WHERE g.region_id=? AND g.is_unassigned=0 ORDER BY g.created_at DESC
  `).all(regionId);
  const teams = db.prepare(`
    SELECT t.*, g.name as gym_name,
           (SELECT COUNT(*) FROM athletes a WHERE a.team_id=t.id) as roster_count
    FROM teams t LEFT JOIN gyms g ON g.id=t.gym_id WHERE t.region_id=? ORDER BY t.name
  `).all(regionId);
  const athletes = db.prepare(`
    SELECT a.id as athlete_id, u.first_name, u.last_name, u.email, u.status, t.name as team_name
    FROM athletes a JOIN users u ON u.id=a.user_id LEFT JOIN teams t ON t.id=a.team_id
    WHERE a.region_id=? ORDER BY u.created_at DESC
  `).all(regionId);
  res.render('league-dashboard', { title: 'League Operator', region, gyms, teams, athletes });
});

// Scoped mirror of the admin gym/athlete status actions — a franchisee can
// only touch a gym or athlete that actually belongs to their own region.
app.post('/league/gyms/:id/status', requireLogin, requireRole('league_operator'), requireOwnRegion, (req, res) => {
  const gym = db.prepare("SELECT * FROM gyms WHERE id=? AND region_id=? AND is_unassigned=0").get(req.params.id, req.session.user.region_id);
  const status = req.body.status;
  if (gym && ['pending', 'active', 'suspended'].includes(status)) {
    db.prepare("UPDATE gyms SET status=? WHERE id=?").run(status, gym.id);
    if (status === 'active' && gym.admin_user_id) db.prepare("UPDATE users SET status='active' WHERE id=? AND status='pending'").run(gym.admin_user_id);
  }
  res.redirect('/league');
});
app.post('/league/athletes/:id/status', requireLogin, requireRole('league_operator'), requireOwnRegion, (req, res) => {
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=? AND region_id=?").get(req.params.id, req.session.user.region_id);
  const status = req.body.status;
  if (athlete && ['pending', 'active', 'suspended'].includes(status)) {
    db.prepare("UPDATE users SET status=? WHERE id=?").run(status, athlete.user_id);
  }
  res.redirect('/league');
});

// ============ WEDGETAIL RECORDINGS ============
// Upload endpoint deliberately has no login gate, matching wedgetail.html
// itself (a standalone tool a judge opens on their phone on the day, same as
// today — see product doc). It's still rate-limited and size-capped. Viewing
// recordings back IS gated, below, since that's where athletes' likenesses
// actually get looked at after the fact.
const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB — generous for a single exercise "set" clip
});
const recordingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many recording uploads from this device — please wait a few minutes.',
});

app.post('/api/wedgetail/recordings', recordingLimiter, recordingUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file received.' });
  if (!storage.storageEnabled()) {
    // Fail soft: Wedgetail keeps counting reps live either way — recording
    // is a bonus feature, not something that should block a live judge.
    console.log('[wedgetail] recording received but storage not configured — discarding.');
    return res.json({ ok: false, stored: false, reason: 'Video storage not configured yet.' });
  }

  const { exercise_name, mode, lane_a_label, lane_b_label, duration_sec, fixture_id } = req.body;
  if (!isReasonableLength(exercise_name, 120) || (mode !== 'angle' && mode !== 'floor')) {
    return res.status(400).json({ error: 'Missing or invalid exercise_name/mode.' });
  }

  let repLog = [], reviewFlags = [];
  try {
    if (req.body.rep_log) repLog = JSON.parse(req.body.rep_log);
    if (req.body.review_flags) reviewFlags = JSON.parse(req.body.review_flags);
  } catch (e) {
    return res.status(400).json({ error: 'rep_log/review_flags must be valid JSON.' });
  }

  const day = new Date().toISOString().slice(0, 10);
  const key = `wedgetail/${day}/${crypto.randomUUID()}.webm`;

  try {
    await storage.uploadRecording({ key, buffer: req.file.buffer, contentType: req.file.mimetype || 'video/webm' });
  } catch (e) {
    console.error('[wedgetail] upload to storage failed:', e.message);
    return res.status(502).json({ error: 'Video storage upload failed — reps already counted are unaffected.' });
  }

  const fixtureIdVal = fixture_id && db.prepare("SELECT id FROM fixtures WHERE id=?").get(fixture_id) ? fixture_id : null;
  const info = db.prepare(`
    INSERT INTO recordings (fixture_id, exercise_name, mode, lane_a_label, lane_b_label, video_key, duration_sec, rep_log, review_flags, recorded_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    fixtureIdVal, exercise_name.trim().slice(0, 120), mode,
    (lane_a_label || '').trim().slice(0, 80) || null, (lane_b_label || '').trim().slice(0, 80) || null,
    key, parseFloat(duration_sec) || null, JSON.stringify(repLog), JSON.stringify(reviewFlags),
    req.session.user ? req.session.user.id : null
  );

  res.json({ ok: true, stored: true, id: info.lastInsertRowid, flagCount: reviewFlags.length });
});

// Coaches (gym admins) see recordings tagged with one of their own team
// names in either lane. Admin sees everything. This is a simple name-match
// rather than a hard foreign key because a lane label is just whatever tag
// was on-screen when recording started — it's descriptive, not a booking.
app.get('/gym/recordings', requireLogin, requireRole('gym_admin', 'admin'), async (req, res) => {
  let rows;
  if (req.session.user.role === 'admin') {
    rows = db.prepare("SELECT * FROM recordings ORDER BY created_at DESC LIMIT 200").all();
  } else {
    const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
    const teams = db.prepare("SELECT name FROM teams WHERE gym_id=?").all(gym.id).map(t => t.name);
    if (teams.length === 0) {
      rows = [];
    } else {
      const placeholders = teams.map(() => '?').join(',');
      rows = db.prepare(`
        SELECT * FROM recordings
        WHERE lane_a_label IN (${placeholders}) OR lane_b_label IN (${placeholders})
        ORDER BY created_at DESC LIMIT 200
      `).all(...teams, ...teams);
    }
  }
  rows.forEach(r => {
    r.reviewFlagsParsed = JSON.parse(r.review_flags || '[]');
  });
  res.render('gym-recordings', { title: 'Wedgetail Recordings', recordings: rows });
});

app.get('/gym/recordings/:id', requireLogin, requireRole('gym_admin', 'admin'), async (req, res) => {
  const rec = db.prepare("SELECT * FROM recordings WHERE id=?").get(req.params.id);
  if (!rec) return res.status(404).render('error', { title: 'Not Found', message: 'Recording not found.' });

  if (req.session.user.role !== 'admin') {
    const gym = db.prepare("SELECT * FROM gyms WHERE admin_user_id=?").get(req.session.user.id);
    const teams = db.prepare("SELECT name FROM teams WHERE gym_id=?").all(gym.id).map(t => t.name);
    if (!teams.includes(rec.lane_a_label) && !teams.includes(rec.lane_b_label)) {
      return res.status(403).render('error', { title: 'Access Denied', message: "This recording isn't from one of your teams." });
    }
  }

  const playbackUrl = await storage.getPlaybackUrl(rec.video_key, 3600);
  res.render('gym-recording-detail', {
    title: rec.exercise_name,
    rec,
    playbackUrl,
    repLog: JSON.parse(rec.rep_log || '[]'),
    reviewFlags: JSON.parse(rec.review_flags || '[]'),
  });
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

  // Recording retention — see storage.js for the RECORDING_RETENTION_DAYS env
  // var this depends on. Runs once shortly after startup (catches anything
  // that piled up while the app was down) and then once a day. A day is
  // plenty granular for a "delete after N days" policy; no reason to check
  // more often than that.
  const runRetentionCleanup = () => {
    storage.cleanupExpiredRecordings(db)
      .then(result => { if (result.checked) console.log(`[wedgetail retention] checked recordings older than ${result.days}d — deleted ${result.deleted}`); })
      .catch(e => console.error('[wedgetail retention] cleanup run failed:', e.message));
  };
  setTimeout(runRetentionCleanup, 30 * 1000); // give the DB/volume a moment to be fully ready after a fresh deploy
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);
}

module.exports = app;
