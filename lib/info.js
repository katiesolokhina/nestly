// Home info: field templates for the starting types, tappable values, Wi-Fi QR codes, warranties.
const QRCode = require('qrcode');

const KINDS = { text: 'Text', secret: 'Hidden', phone: 'Phone', email: 'Email', link: 'Link', address: 'Address', date: 'Date' };

// Suggested fields for a new item of each starting type. Types a household adds start blank.
const TEMPLATES = {
  'Wi-Fi & codes': [['Network', 'text'], ['Password', 'secret']],
  Contacts: [['Phone', 'phone'], ['Email', 'email'], ['Address', 'address']],
  Appliances: [['Brand', 'text'], ['Model', 'text'], ['Serial number', 'text'], ['Purchased', 'date'], ['Warranty ends', 'date'], ['Manual', 'link']],
  'Documents & how-tos': [],
};
// A new item's fields: the household's own for this type (Settings), else the built-in ones.
function template(type, household) {
  const own = household && (household.infoTemplates || []).find((t) => t.type === type);
  if (own) return own.fields.map((f) => ({ label: f.label, value: '', kind: f.kind || 'text' }));
  return (TEMPLATES[type] || []).map(([label, kind]) => ({ label, value: '', kind }));
}

const isHttp = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };

// Where a value goes when tapped.
function hrefFor(f) {
  const v = f.value;
  if (!v) return '';
  if (f.kind === 'phone') { const digits = v.replace(/[^\d+]/g, ''); return digits ? `tel:${digits}` : ''; }
  if (f.kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? `mailto:${v}` : '';
  if (f.kind === 'link') return isHttp(v) ? v : '';
  if (f.kind === 'address') return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;
  return '';
}
const smsFor = (f) => (f.kind === 'phone' ? `sms:${f.value.replace(/[^\d+]/g, '')}` : '');

const isWarranty = (f) => f.kind === 'date' && /warrant/i.test(f.label) && /^\d{4}-\d{2}-\d{2}$/.test(f.value);

// A Wi-Fi item gets a QR code when it has a network name. Phones join by scanning it.
async function wifiQr(item) {
  const find = (re, kinds) => item.fields.find((f) => re.test(f.label) && (!kinds || kinds.includes(f.kind)) && f.value);
  const ssid = find(/network|ssid|wi-?fi name/i);
  if (!ssid) return null;
  const pass = find(/password|key|pass/i, ['secret', 'text']);
  const esc = (s) => s.replace(/([\;,:"])/g, '\\$1');
  const text = `WIFI:T:${pass ? 'WPA' : 'nopass'};S:${esc(ssid.value)};${pass ? `P:${esc(pass.value)};` : ''};`;
  return QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}

// A line under the title in lists: the first few things that aren't secret.
const summary = (item) => item.fields.filter((f) => f.value && f.kind !== 'secret' && f.kind !== 'link').slice(0, 2).map((f) => f.value).join(' · ');

module.exports = { KINDS, TEMPLATES, template, hrefFor, smsFor, isWarranty, wifiQr, summary, isHttp };
