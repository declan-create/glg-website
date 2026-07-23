// Outbound email via Zoho Mail SMTP (part of the Zoho One subscription).
//
// Configured entirely through environment variables so credentials never live
// in the repo, and so the app runs fine with mail switched off (local dev,
// tests, or before the mailbox is set up) — sends just log and no-op.
//
//   SMTP_HOST  e.g. smtp.zoho.com.au   (AU data centre — matches the org)
//   SMTP_PORT  465 (SSL)
//   SMTP_USER  the sending mailbox, e.g. noreply@gymleagueglobal.com.au
//   SMTP_PASS  a Zoho APP PASSWORD for that mailbox (not the login password)
//   MAIL_FROM  display from, e.g. "Gym League Global <noreply@gymleagueglobal.com.au>"
//
// MAIL_TRANSPORT=json switches to nodemailer's in-memory JSON transport
// (used by the test suite to inspect messages without a real SMTP server).

const nodemailer = require('nodemailer');

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (process.env.MAIL_TRANSPORT === 'json') {
    transport = nodemailer.createTransport({ jsonTransport: true });
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

// Fire-and-forget: never let a mail failure break the request that triggered
// it (assigning a judge must succeed even if Zoho is unreachable).
async function send({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail disabled] would send "${subject}" to ${to}`);
    return null;
  }
  try {
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
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

module.exports = { send, mailEnabled, judgeAssignmentEmail };
