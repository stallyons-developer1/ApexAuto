// Internal reviewer API (team only) — backs admin.html.
//   GET                 → the background-check queue (bookings submitted from step ②)
//   GET  ?booking=...   → one booking + the verified identity (live from Didit, or typed in test mode)
//   POST { booking, decision, icm_checked, icm_notes, reviewer } → approve | decline | pending
// Instant Checkmate is checked MANUALLY by the reviewer on its own site; its notes are
// context only and never the recorded basis for a decline (see handoff/automation-1).
// Requires header x-admin-key === ADMIN_KEY.
const fs = require('fs');
const { load, save, diditDecision, identityFromDecision } = require('./_store');
const truthfinder = require('./_truthfinder');

const STATUS = { approve: 'bg_clear', decline: 'declined_background', pending: 'manual_review' };

module.exports = async (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ error: 'ADMIN_KEY not set — admin disabled' });
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });

  try {
    const all = load();

    if (req.method === 'POST') {
      const b = req.body || {};
      const entry = all[b.booking];
      if (!entry) return res.status(404).json({ error: 'booking not found' });
      if (b.action === 'retry_truthfinder') {
        if (!truthfinder.enabled()) return res.status(400).json({ error: 'TruthFinder worker is not configured (TF_ENABLED, TF_EMAIL, TF_PASSWORD)' });
        if (entry.status === 'checking') return res.status(200).json({ ok: true, status: entry.status });
        if (entry.session_id && !entry.verified_identity) entry.verified_identity = identityFromDecision(await diditDecision(entry.session_id));
        entry.status = 'checking'; entry.report_check = null; entry.tf = {};
        save(all);
        truthfinder.enqueue(b.booking);
        return res.status(200).json({ ok: true, status: 'checking' });
      }
      if (!STATUS[b.decision]) return res.status(400).json({ error: 'decision must be approve|decline|pending' });
      const m = b.match || {};
      if (b.decision === 'approve' && !(m.age && m.location && m.single)) {
        return res.status(400).json({ error: 'confirm the identity match before approving' });
      }
      entry.status = STATUS[b.decision];
      entry.review = {
        decision: b.decision,
        icm_checked: !!b.icm_checked,
        icm_notes: String(b.icm_notes || '').slice(0, 4000),
        match: { age: !!m.age, location: !!m.location, single: !!m.single },
        clean: !!b.clean,
        flags: Array.isArray(b.flags) ? b.flags.map((f) => String(f).slice(0, 80)).slice(0, 20) : [],
        reviewer: String(b.reviewer || '').slice(0, 100),
        reviewed_at: new Date().toISOString()
      };
      save(all);
      return res.status(200).json({ ok: true, status: entry.status });
    }

    const bk = req.query && req.query.booking;
    if (bk && req.query.snapshot) { // TruthFinder debug screenshot / HTML for this booking
      const p = truthfinder.snapshotPath(bk, String(req.query.snapshot));
      if (!p) return res.status(404).json({ error: 'snapshot not found' });
      res.setHeader('Content-Type', p.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8');
      res.statusCode = 200;
      return res.end(fs.readFileSync(p));
    }
    if (!bk) {
      const items = Object.values(all)
        .sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''))
        .map((e) => ({ booking_id: e.booking_id, name: e.name, status: e.status, id_source: e.id_source,
                       submitted_at: e.submitted_at, reviewer: e.review && e.review.reviewer }));
      return res.status(200).json({ items });
    }

    const entry = all[bk];
    if (!entry) return res.status(404).json({ error: 'booking not found' });
    const identity = entry.session_id ? identityFromDecision(await diditDecision(entry.session_id)) : entry.identity;
    return res.status(200).json(Object.assign({}, entry, { identity }));
  } catch (e) {
    return res.status(e.message === 'didit_error' ? 502 : 500).json({ error: e.message, detail: e.detail });
  }
};
