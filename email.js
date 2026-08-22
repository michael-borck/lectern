// email.js — pluggable code delivery: dev (log), smtp, resend.
// Env:
//   EMAIL_PROVIDER   dev (default) | smtp | resend
//   EMAIL_FROM       sender address (smtp/resend)
//   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS   (provider=smtp)
//   RESEND_API_KEY                            (provider=resend)

const PROVIDER = (process.env.EMAIL_PROVIDER || 'dev').toLowerCase();
const FROM = process.env.EMAIL_FROM || 'lectern@localhost';

async function sendSmtp(to, subject, text) {
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transport.sendMail({ from: FROM, to, subject, text });
}

async function sendResend(to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

async function sendCode(to, code) {
  const subject = `${code} — your lectern login code`;
  const text = `Your login code is: ${code}\n\nIt expires in 10 minutes.\n`;
  if (PROVIDER === 'dev') {
    console.log(`[email:dev] code for ${to}: ${code}`);
    return;
  }
  if (PROVIDER === 'smtp') return sendSmtp(to, subject, text);
  if (PROVIDER === 'resend') return sendResend(to, subject, text);
  throw new Error(`unknown EMAIL_PROVIDER: ${PROVIDER}`);
}

module.exports = { sendCode, PROVIDER };
