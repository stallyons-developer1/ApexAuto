// Background flow: the customer submits steps 1–3 + checkout at once and leaves; api/_pipeline.js runs the
// background check and the insurance call afterwards and emails the result.
//   POST { booking, session_id | identity, consent_bg, insurance: {…, consent}, contact: {name, email, phone},
//          days, total, pickup, dropoff, dates }  → { status: 'submitted' }
//   GET  ?booking=…  → progress (stage, background + insurance status, emails; the run log in test mode)
const { load, save } = require('./_store');
const { invoke } = require('./_invoke');
const { sendEmail } = require('./_email');

const BOOKING = /^bk-[A-Za-z0-9-]{4,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const bk = req.query && req.query.booking;
      const e = BOOKING.test(bk || '') && load()[bk];
      if (!e || e.flow !== 'background') return res.status(404).json({ error: 'not found' });
      const ins = load('insurance')[bk];
      const test = process.env.ALLOW_ID_SKIP === 'true';
      return res.status(200).json({
        stage: e.pipeline.stage, done: !!e.pipeline.done, outcome: e.pipeline.outcome || '',
        background: e.status, insurance: ins ? ins.status : 'not started', insurance_stage: ins && ins.stage,
        emails: Object.keys(e.pipeline.sent || {}),
        // test mode only: what happened (a real customer just gets the emails)
        pipeline_log: test ? e.pipeline.log || [] : undefined,
        tf_log: test && e.tf ? e.tf.log || [] : undefined,
        email_errors: test ? Object.entries(e.pipeline.sent || {}).filter(([, v]) => String(v).startsWith('failed')).map(([k, v]) => `${k}: ${v}`) : undefined
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    const b = req.body || {};
    if (!BOOKING.test(b.booking || '')) return res.status(400).json({ error: 'invalid booking id' });
    if (b.consent_bg !== true) return res.status(400).json({ error: 'background-check authorization required' });
    const ins = b.insurance || {}, c = b.contact || {};
    if (ins.consent !== true) return res.status(400).json({ error: 'insurance-call authorization required' });
    if (!ins.insurer || !/^[A-Za-z0-9 -]{4,40}$/.test(String(ins.policy_number || '').trim())) return res.status(400).json({ error: 'insurance provider and policy number required' });
    if (!EMAIL.test(String(c.email || '').trim())) return res.status(400).json({ error: 'a valid email is required — we send the result there' });

    const existing = load()[b.booking];
    if (existing && existing.flow === 'background') return res.status(200).json({ status: 'submitted' });

    // ② create the background-check booking exactly as step 2 does (queues the TruthFinder check)
    const background = require('./background');
    const r = await invoke(background, { method: 'POST', headers: req.headers, body: {
      booking: b.booking, consent: true, session_id: b.session_id, identity: b.identity,
      days: b.days, pickup: b.pickup, dropoff: b.dropoff, dates: b.dates
    } });
    if (r.code !== 200) return res.status(r.code).json(r.data);

    const all = load(), e = all[b.booking];
    e.flow = 'background';
    e.contact = { name: String(c.name || '').slice(0, 100), email: String(c.email).trim().slice(0, 200), phone: String(c.phone || '').slice(0, 30) };
    e.order = { days: Number(b.days) || 1, total: Number(b.total) || (Number(b.days) || 1) * 450, pickup: String(b.pickup || ''), dropoff: String(b.dropoff || '') };
    e.ins_request = {
      insurer: ins.insurer, policy_number: String(ins.policy_number).trim(), other_name: ins.other_name, other_phone: ins.other_phone,
      zip: ins.zip, phone: ins.phone, holder_name: ins.holder_name, dob: ins.dob, address: ins.address,
      test_number: ins.test_number, session_id: b.session_id, dates: b.dates
    };
    e.pipeline = { stage: 'background_check', sent: {}, log: [{ t: new Date().toISOString(), m: 'submitted' }] };
    save(all);

    // "we received it" email — a failure here doesn't stop the booking
    try {
      await sendEmail('received', e.contact.email, { name: e.contact.name, vehicle: '2024 Chevrolet Corvette C8 Stingray' });
      const a2 = load(); a2[b.booking].pipeline.sent.received = new Date().toISOString(); save(a2);
    } catch (err) {
      const a2 = load(); a2[b.booking].pipeline.sent.received = 'failed: ' + err.message; save(a2);
      console.log(`[pipeline] ${b.booking}: email "received" failed: ${err.message}`);
    }
    return res.status(200).json({ status: 'submitted' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
