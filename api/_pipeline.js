// Background verification pipeline (helper, not an endpoint) — the customer fills steps 1–3 and checkout without
// waiting; api/submit.js queues the booking and this runs the checks one after another, then emails the result:
//   ② background check (TruthFinder)  → clear → ③ insurance call (Vapi) → verified → WooCommerce order → "approved" email + pay link
//   rejected / not covered → "declined" email · needs a human → "review" email (the team decides in admin.html;
//   an approval there moves the booking on to the next check automatically)
// Runs inside dev-server.js every 15 s. Each email type is sent at most once per booking.
const { load, save } = require('./_store');
const { invoke } = require('./_invoke');
const { sendEmail } = require('./_email');

const VEHICLE = '2024 Chevrolet Corvette C8 Stingray';
let running = false;

function start() {
  setTimeout(tick, 3000);
  setInterval(tick, 15000);
  console.log('[pipeline] background verification pipeline running');
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const e of Object.values(load())) {
      if (e.flow !== 'background' || !e.pipeline || e.pipeline.done) continue;
      await step(e.booking_id).catch((err) => note(e.booking_id, `error: ${err.message}`));
    }
  } finally { running = false; }
}

function upd(id, fn) { const all = load(); if (all[id]) { fn(all[id]); save(all); } return all[id]; }
function note(id, m) {
  upd(id, (e) => { e.pipeline.log = (e.pipeline.log || []).concat({ t: new Date().toISOString(), m: String(m).slice(0, 300) }).slice(-60); });
  console.log(`[pipeline] ${id}: ${m}`);
}
function setStage(id, stage) { upd(id, (e) => { if (e.pipeline.stage !== stage) { e.pipeline.stage = stage; e.pipeline.stage_at = new Date().toISOString(); } }); }
function done(id, outcome) { upd(id, (e) => { e.pipeline.done = true; e.pipeline.outcome = outcome; e.pipeline.stage = 'done'; }); note(id, `finished: ${outcome}`); }

async function email(id, type) {
  const e = load()[id];
  if (e.pipeline.sent && e.pipeline.sent[type]) return;
  const b = e.booking || {};
  try {
    await sendEmail(type, e.contact && e.contact.email, {
      name: e.contact && e.contact.name, vehicle: VEHICLE, payUrl: e.pipeline.pay_url,
      dates: b.pickup_date && b.return_date ? `${b.pickup_date} → ${b.return_date}` : ''
    });
    upd(id, (x) => { x.pipeline.sent = Object.assign(x.pipeline.sent || {}, { [type]: new Date().toISOString() }); });
    note(id, `email sent: ${type}`);
  } catch (err) {
    upd(id, (x) => { x.pipeline.sent = Object.assign(x.pipeline.sent || {}, { [type]: 'failed: ' + err.message }); });
    note(id, `email "${type}" failed: ${err.message}`);
  }
}

async function step(id) {
  const e = load()[id];
  // ② background check
  if (e.status === 'checking') return setStage(id, 'background_check');
  if (e.status === 'declined_background') { await email(id, 'declined'); return done(id, 'declined — background check'); }
  if (e.status === 'manual_review') { setStage(id, 'background_review'); return email(id, 'review'); } // waits for the team
  if (e.status !== 'bg_clear') return;

  // ③ insurance call
  const insurance = require('./insurance');
  let ins = load('insurance')[id];
  if (!ins) {
    if (e.pipeline.ins_started) return; // started, entry not written yet
    upd(id, (x) => { x.pipeline.ins_started = new Date().toISOString(); });
    setStage(id, 'insurance_call');
    const r = await invoke(insurance, { method: 'POST', body: Object.assign({}, e.ins_request, { booking: id, consent: true }) });
    if (r.code !== 200) {
      note(id, `insurance call could not start: ${(r.data && r.data.error) || r.code}`);
      await email(id, 'review');
      return done(id, 'review — insurance call could not start');
    }
    return note(id, 'insurance call started');
  }
  if (ins.status === 'calling') {
    setStage(id, 'insurance_call');
    await invoke(insurance, { method: 'GET', query: { booking: id } }); // reads the call from Vapi, finishes it when ended
    ins = load('insurance')[id];
    if (ins.status === 'calling') return;
  }
  if (ins.status === 'declined') { await email(id, 'declined'); return done(id, 'declined — insurance'); }
  if (ins.status === 'needs_review') { await email(id, 'review'); return done(id, 'review — insurance'); }
  if (ins.status !== 'verified') return;

  // ④ both passed → order + payment link
  setStage(id, 'payment_link');
  const o = e.order || {}, c = e.contact || {};
  const r = await invoke(require('./create-order'), { method: 'POST', body: {
    days: o.days, total: o.total, pickup: o.pickup, dropoff: o.dropoff, name: c.name, email: c.email, phone: c.phone,
    id_check: e.id_source === 'didit' ? 'passed' : 'skipped'
  } });
  if (r.code === 200 && r.data && r.data.pay_url) {
    upd(id, (x) => { x.pipeline.pay_url = r.data.pay_url; x.pipeline.order_id = r.data.order_id; });
    note(id, `order ${r.data.order_id} created`);
  } else {
    note(id, `order could not be created (${(r.data && r.data.error) || r.code}) — approved email says the team will send the link`);
  }
  await email(id, 'approved');
  done(id, 'approved');
}

module.exports = { start, tick };
