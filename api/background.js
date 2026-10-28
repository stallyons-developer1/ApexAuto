// Step ② from the customer's side.
//   POST { booking, session_id | identity, consent, days, pickup, dropoff, dates, report_text? }
//        → without report_text: queue for team review
//        → with report_text (TEST ONLY, "pdf" mode): the uploaded report is matched against the ID;
//          same person + no records = bg_clear (step 3 opens), anything else = manual_review
//   GET  ?booking=...  → { status } only (never flags or notes — the customer only sees "under review")
const { load, save, diditDecision, identityFromDecision } = require('./_store');
const { checkReport } = require('./_report');
const truthfinder = require('./_truthfinder');

const BOOKING = /^bk-[A-Za-z0-9-]{4,40}$/;

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const bk = req.query && req.query.booking;
      const entry = BOOKING.test(bk || '') && load()[bk];
      if (!entry) return res.status(404).json({ error: 'not found' });
      // the tester also sees the report check once the worker has finished (a real customer never does)
      const check = process.env.ALLOW_ID_SKIP === 'true' && entry.report_check
        ? { match: entry.report_check.match, report: entry.report_check.report, flags: entry.report_check.flags, records: entry.report_check.records.length } : undefined;
      // TEST ONLY: the TruthFinder worker's run-time log, shown under step 2 for debugging
      const log = process.env.ALLOW_ID_SKIP === 'true' && entry.tf ? entry.tf.log || [] : undefined;
      // the automatic check stopped on an error: the page stops progress (error text for testers only)
      const failed = entry.status === 'manual_review' && !!entry.tf && entry.tf.stage === 'failed' && !entry.review;
      const error = failed && process.env.ALLOW_ID_SKIP === 'true' ? entry.tf.error : undefined;
      return res.status(200).json({ status: entry.status, stage: entry.tf && entry.tf.stage, check, log, failed, error });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    const b = req.body || {};
    if (!BOOKING.test(b.booking || '')) return res.status(400).json({ error: 'invalid booking id' });

    // TEST ONLY: re-run the automatic check after it stopped on an error
    if (b.action === 'retry') {
      if (process.env.ALLOW_ID_SKIP !== 'true') return res.status(403).json({ error: 'retry is test-only — the team retries from the admin page' });
      const all = load(), e = all[b.booking];
      if (!e) return res.status(404).json({ error: 'not found' });
      if (!truthfinder.enabled()) return res.status(400).json({ error: 'TruthFinder check is not enabled' });
      if (e.status !== 'checking') {
        if (e.status !== 'manual_review' || e.review) return res.status(409).json({ error: 'this booking already has a decision' });
        e.status = 'checking'; e.report_check = null; e.tf = {};
        save(all);
        truthfinder.enqueue(b.booking);
      }
      return res.status(200).json({ status: 'checking' });
    }
    if (b.consent !== true) return res.status(400).json({ error: 'consent required' });

    const all = load();
    if (all[b.booking]) return res.status(200).json({ status: all[b.booking].status }); // already submitted

    let idSource, name, identity = null, verified = null;
    if (b.session_id) {
      // Real gate: only a Didit-approved identity goes forward
      const d = await diditDecision(b.session_id);
      if (d.status !== 'Approved') return res.status(409).json({ error: 'ID not approved' });
      idSource = 'didit';
      verified = identityFromDecision(d);
      name = verified.full_name;
    } else {
      // TEST ONLY — customer skipped Didit, so they typed their details
      if (process.env.ALLOW_ID_SKIP !== 'true') return res.status(400).json({ error: 'ID verification required' });
      const i = b.identity || {};
      const clean = (v, n) => String(v || '').trim().slice(0, n);
      identity = {
        first_name: clean(i.first_name, 60), middle_name: clean(i.middle_name, 60), last_name: clean(i.last_name, 60),
        date_of_birth: clean(i.date_of_birth, 10), issuing_state: clean(i.issuing_state, 2).toUpperCase(),
        phone: clean(i.phone, 25) // optional — when given, the TruthFinder report must show this number too
      };
      if (!identity.first_name || !identity.last_name || !identity.issuing_state) {
        return res.status(400).json({ error: 'first name, last name and state required (date of birth is optional)' });
      }
      identity.full_name = [identity.first_name, identity.middle_name, identity.last_name].filter(Boolean).join(' ');
      idSource = 'skipped (test)';
      name = identity.full_name;
    }

    // TEST ONLY: uploaded report → automatic match. Never in production, where the customer could
    // upload a report of their own making; there the report is read by the team (admin.html).
    let status = 'manual_review', reportCheck = null;
    if (b.report_text) {
      if (process.env.ALLOW_ID_SKIP !== 'true') return res.status(400).json({ error: 'report upload is test-only' });
      reportCheck = checkReport(String(b.report_text).slice(0, 200000), verified || identity);
      if (!reportCheck.readable) return res.status(400).json({ error: "couldn't read that report — upload the background report PDF" });
      if (reportCheck.matched && reportCheck.confirmedClean) status = 'bg_clear';
    } else if (truthfinder.enabled()) {
      status = 'checking'; // the TruthFinder worker picks it up (api/_truthfinder.js)
    }

    const dates = b.dates || {};
    all[b.booking] = {
      booking_id: b.booking, session_id: b.session_id || '', id_source: idSource, name, identity,
      status, report_check: reportCheck,
      verified_identity: status === 'checking' ? verified : undefined, // the worker searches with the Didit ID
      booking: { days: Number(b.days) || null, pickup: String(b.pickup || ''), dropoff: String(b.dropoff || ''),
                 pickup_date: String(dates.pickup || ''), return_date: String(dates.return || '') },
      consent_at: new Date().toISOString(),
      consent_ip: String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || ''),
      submitted_at: new Date().toISOString(),
      review: null
    };
    save(all);
    if (status === 'checking') truthfinder.enqueue(b.booking);
    // In test mode the tester sees why (a real customer never sees match details or flags)
    return res.status(200).json(reportCheck ? { status, check: { match: reportCheck.match, report: reportCheck.report, flags: reportCheck.flags, records: reportCheck.records.length } } : { status });
  } catch (e) {
    return res.status(e.message === 'didit_error' ? 502 : 500).json({ error: e.message, detail: e.detail });
  }
};
