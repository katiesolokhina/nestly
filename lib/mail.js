// Email, if the server has an SMTP account set up (.env: SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, MAIL_FROM). Without it, email is simply off.
const nodemailer = require('nodemailer');

let transport = null;
const mailOn = () => Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);

function transporter() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 587 upgrades to TLS with STARTTLS
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  if (!mailOn()) return false;
  await transporter().sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
  return true;
}

module.exports = { mailOn, sendMail };
