// Shared helpers for the verification steps (not an endpoint — the leading "_" keeps
// Vercel from exposing it). State lives in local JSON files until Supabase (M1).
//   'reviews'   → step ② background-check queue
//   'insurance' → step ③ insurance calls
const fs = require('fs');
const path = require('path');
const os = require('os');

const files = (name) => [path.join(__dirname, '..', 'data', name + '.json'), path.join(os.tmpdir(), 'apex-' + name + '.json')];

function load(name = 'reviews') {
  for (const f of files(name)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {} }
  return {};
}
function save(all, name = 'reviews') {
  for (const f of files(name)) {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(all, null, 2)); return; } catch (e) {}
  }
  throw new Error('could not save queue');
}

async function diditDecision(sessionId) {
  const r = await fetch('https://verification.didit.me/v3/session/' + encodeURIComponent(sessionId) + '/decision/', {
    headers: { 'x-api-key': process.env.DIDIT_API_KEY }
  });
  const d = await r.json();
  if (!r.ok) { const e = new Error('didit_error'); e.detail = d; throw e; }
  return d;
}

function addressText(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.formatted_address || [a.street, a.city, a.state, a.postal_code || a.zip].filter(Boolean).join(', ');
}

// Identity fields per handoff/data-contract.md
function identityFromDecision(d) {
  const id = (d.id_verifications && d.id_verifications[0]) || {};
  return {
    first_name: id.first_name || '', middle_name: id.middle_name || '', last_name: id.last_name || '', full_name: id.full_name || '',
    date_of_birth: id.date_of_birth || '', age: id.age || '',
    document_type: id.document_type || '', document_number: id.document_number || '',
    issuing_state: id.issuing_state || id.issuing_state_name || '',
    expiration_date: id.expiration_date || '',
    address: addressText(id.formatted_address || id.address), portrait_image: id.portrait_image || '',
    phone: phoneFromDecision(d)
  };
}
// Phone from Didit, when the workflow collects one (phone verification step, or contact details)
function phoneFromDecision(d) {
  const pv = (d.phone_verifications && d.phone_verifications[0]) || {};
  const cd = d.contact_details || {};
  return String(pv.full_number || pv.phone_number || pv.phone || cd.phone_number || cd.phone || d.phone_number || '');
}

module.exports = { load, save, diditDecision, identityFromDecision };
