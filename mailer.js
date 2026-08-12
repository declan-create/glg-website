// Outbound email — two possible transports, chosen automatically:
//
// 1. ZeptoMail (Zoho's transactional email API, HTTPS/443) — used if
//    ZEPTOMAIL_TOKEN is set. Preferred: Railway blocks outbound SMTP ports
//    465/587 (confirmed via a live network test from inside the app itself),
//    so raw SMTP to Zoho Mail never completes. ZeptoMail is the same Zoho
//    account/ecosystem, just sending over a normal HTTPS API call instead —
//    no new vendor, just a different Zoho product.
// 2. Zoho Mail SMTP (nodemailer) — kept as a fallback for any environment
//    where SMTP ports aren't blocked (e.g. running locally).
//
// Configured entirely through environment variables so credentials never live
// in the repo, and so the app runs fine with mail switched off (local dev,
// tests, or before either is set up) — sends just log and no-op.
//
//   ZEPTOMAIL_TOKEN   the full "Send Mail token" value from ZeptoMail's API
//                     tab, including the "Zoho-enczapikey " prefix — used
//                     as-is in the Authorization header.
//   MAIL_FROM         display from, e.g. "Gym League Global <glsignup@gymleagueglobal.com.au>"
//                     must be on the domain verified in ZeptoMail
//
//   SMTP_HOST  e.g. smtp.zoho.com.au   (AU data centre — matches the org)
//   SMTP_PORT  465 (SSL) or 587 (TLS)
//   SMTP_USER  the sending mailbox, e.g. noreply@gymleagueglobal.com.au
//   SMTP_PASS  a Zoho APP PASSWORD for that mailbox (not the login password)
//
// MAIL_TRANSPORT=json switches to nodemailer's in-memory JSON transport
// (used by the test suite to inspect messages without a real SMTP server).

const nodemailer = require('nodemailer');

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (process.env.MAIL_TRANSPORT === 'json') {
    transport = nodemailer.createTransport({ jsonTransport: true });
  } else if (process.env.ZEPTOMAIL_TOKEN) {
    transport = 'zeptomail'; // handled directly in send(), not via nodemailer
  } else if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: (process.env.SMTP_PORT || '465') === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

function mailEnabled() { return !!getTransport(); }

// Parses "Display Name <email@domain.com>" into ZeptoMail's separate
// address/name fields — MAIL_FROM is kept in the familiar combined format
// everywhere else in this file for consistency with nodemailer.
function parseFromHeader(from) {
  const match = /^(.*)<(.+)>$/.exec(from || '');
  if (match) return { address: match[2].trim(), name: match[1].trim().replace(/^"|"$/g, '') };
  return { address: from, name: undefined };
}

// Fire-and-forget: never let a mail failure break the request that triggered
// it (assigning a judge must succeed even if the mail provider is unreachable).
async function send({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail disabled] would send "${subject}" to ${to}`);
    return null;
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  try {
    if (t === 'zeptomail') {
      const fromParsed = parseFromHeader(from);
      const res = await fetch('https://api.zeptomail.com.au/v1.1/email', {
        method: 'POST',
        headers: {
          'Authorization': process.env.ZEPTOMAIL_TOKEN, // full string already includes "Zoho-enczapikey " prefix
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromParsed,
          to: [{ email_address: { address: to } }],
          subject,
          textbody: text,
          htmlbody: html,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`ZeptoMail API ${res.status}: ${body}`);
      }
      return await res.json();
    }
    return await t.sendMail({ from, to, subject, text, html });
  } catch (e) {
    console.error(`[mail] failed sending "${subject}" to ${to}:`, e.message);
    return null;
  }
}

function judgeAssignmentEmail({ judge, category_label, fixture, isNewAccount, defaultPassword }) {
  const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
  const loginLine = isNewAccount
    ? `Log in with this email address and the password: ${defaultPassword}\n(You can change it after logging in via My Account.)`
    : `Log in with this email address and your usual GLG password.`;

  const text = `Hi ${judge.first_name || 'there'},

You've been assigned as a judge for Gym League Global.

  Match:     ${fixture.team_a_name} vs ${fixture.team_b_name}
  Date:      ${fixture.match_date || 'see fixture'}
  Judging:   ${category_label}

You follow your participant group through every exercise, counting for both
teams. On the day, open ${site} on your phone, log in, and tap LIVE COUNTER
next to your assignment — the screen follows the event clock automatically.

${loginLine}

See you there,
Gym League Global
${site}`;

  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split('\n').map(l => l === '' ? '<br>' : `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">${l}</div>`).join('');

  return {
    to: judge.email,
    subject: `You're judging ${category_label} — ${fixture.team_a_name} vs ${fixture.team_b_name}`,
    text, html,
  };
}

// Shared plain-text -> HTML step so every template stays in sync visually
// without hand-writing HTML twice.
function toHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split('\n').map(l => l === '' ? '<br>' : `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">${l}</div>`).join('');
}

function welcomeAthleteEmail({ user, regionName }) {
  const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
  const text = `Hi ${user.first_name || 'there'},

Welcome to Gym League Global — you're signed up in ${regionName || 'your region'}.

What happens next:
  1. If you asked to be assigned a team, a gym admin will place you shortly —
     check ${site}/profile any time to see your status.
  2. If you picked your own team, you're in — your team's gym admin can see
     you on their roster now.
  3. Keep an eye on your email for fixture and judging notices.

Your account email (${user.email}) is what you'll always use to log in,
including for password recovery if you ever forget it — so keep it current
under My Account.

See you on the floor,
Gym League Global
${site}`;
  return { to: user.email, subject: 'Welcome to Gym League Global', text, html: toHtml(text) };
}

function welcomeGymEmail({ user, gymName, regionName, teamNames }) {
  const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
  const teamLines = (teamNames || []).map(n => `  - ${n}`).join('\n');
  const text = `Hi ${user.first_name || 'there'},

${gymName} is registered with Gym League Global in ${regionName || 'your region'}.

Team(s) created at signup:
${teamLines || '  (none yet — add one from your dashboard)'}

Next steps:
  1. Go to ${site}/gym and check your roster.
  2. Invite your athletes to sign up at ${site}/signup/athlete — have them
     pick your team by name during sign-up, or sign up themselves and you
     can assign them from the dashboard.
  3. Add or rename teams, and reset a member's password for them, any time
     from the gym dashboard.
  4. Watch for fixture and judge-assignment emails as your season is scheduled.

Your account email (${user.email}) is what you'll always log in with,
including for password recovery — keep it current under My Account.

Welcome aboard,
Gym League Global
${site}`;
  return { to: user.email, subject: `${gymName} is set up on Gym League Global`, text, html: toHtml(text) };
}

function passwordResetEmail({ user, resetUrl }) {
  const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
  const text = `Hi ${user.first_name || 'there'},

We received a request to reset the password on your Gym League Global
account (${user.email}).

Reset it here (link expires in 1 hour):
${resetUrl}

If you didn't ask for this, you can safely ignore this email — your
password won't change unless you click the link above and set a new one.

Gym League Global
${site}`;
  return { to: user.email, subject: 'Reset your Gym League Global password', text, html: toHtml(text) };
}

function addedByGymEmail({ user, gymName, teamName, tempPassword }) {
  const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
  const text = `Hi ${user.first_name || 'there'},

${gymName} has added you to Gym League Global — you're on ${teamName ? `the ${teamName} team` : 'their roster'}.

Log in here: ${site}/login
  Email: ${user.email}
  Temporary password: ${tempPassword}

We'd recommend changing that password once you're in — go to My Account after
logging in, or use "Forgot Password" any time from the login page.

Once you're in, you can see your results, your team, and your upcoming fixtures.

See you on the floor,
Gym League Global
${site}`;
  return { to: user.email, subject: `${gymName} added you to Gym League Global`, text, html: toHtml(text) };
}

function leagueApplicationReceivedEmail({ user, proposedRegion }) {
  const site = process.env.PUBLIC_BASE_URL || 'https://gymleagueglobal.com.au';
  const text = `Hi ${user.first_name || 'there'},

Thanks for applying to run a Gym League Global region${proposedRegion ? ` (${proposedRegion})` : ''}.

Your application is now with our team for review — we'll be in touch by email
once there's a decision. No action needed from you in the meantime.

Gym League Global
${site}`;
  return { to: user.email, subject: 'Your Gym League Global region application', text, html: toHtml(text) };
}

// Internal notifications to GLG HQ — nothing fancy, just make sure a human
// sees every new gym, athlete, and league application without having to
// remember to check the admin dashboard. Silently no-ops if ADMIN_NOTIFY_EMAIL
// isn't set, same fail-soft pattern as every other email in this file.
function adminNotifyEmail({ subject, lines }) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to) return null;
  const text = lines.join('\n');
  return { to, subject: `[GLG] ${subject}`, text, html: toHtml(text) };
}

module.exports = {
  send, mailEnabled, judgeAssignmentEmail, welcomeAthleteEmail, welcomeGymEmail,
  passwordResetEmail, addedByGymEmail, leagueApplicationReceivedEmail, adminNotifyEmail,
};
