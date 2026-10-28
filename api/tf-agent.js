// Endpoint for the TruthFinder agent on the client's computer (agent/truthfinder-agent.js), used when
// TruthFinder refuses logins from the server. TF_MODE=agent + TF_AGENT_KEY on the server; the agent sends
// the key in x-agent-key. The agent never decides anything — it sends the report text and the server runs
// the same check as the server worker (api/_truthfinder.js applyResult).
//   GET  ?action=next                               → { job: { booking_id, identity } | null }  (claims it)
//   POST { action: 'log', booking, lines: [...] }   → append run-log lines
//   POST { action: 'patch', booking, tf: {...} }    → stage / result counters
//   POST { action: 'snapshot', booking, name, png (base64), html }
//   POST { action: 'result', booking, text }        → server decides clear / review
//   POST { action: 'fail', booking, message, stopped, stack, noRecords }  (noRecords: TruthFinder had no results)
const fs = require('fs');
const path = require('path');
const { load } = require('./_store');
const tf = require('./_truthfinder');

const CLAIM_TIMEOUT_MS = 15 * 60 * 1000; // a job claimed but not finished in 15 min can be picked up again
const TF_KEYS = ['stage', 'at', 'error', 'started_at', 'results_total', 'results_seen', 'results_fit', 'results_age_match', 'picked', 'picked_by', 'ambiguous'];


module.exports = async (req, res) => {
  if (!tf.agentMode()) return res.status(503).json({ error: 'agent mode is off (set TF_MODE=agent and TF_AGENT_KEY)' });
  if (req.headers['x-agent-key'] !== process.env.TF_AGENT_KEY) return res.status(401).json({ error: 'unauthorized' });


  try {
    if (req.method === 'GET') {
      if ((req.query && req.query.action) !== 'next') return res.status(400).json({ error: 'action=next' });
      const now = Date.now();
      const job = Object.values(load())
        .filter((e) => e.status === 'checking' && (!e.tf || !e.tf.claimed_at || now - Date.parse(e.tf.claimed_at) > CLAIM_TIMEOUT_MS))
        .sort((a, b) => (a.submitted_at || '').localeCompare(b.submitted_at || ''))[0];
      if (!job) return res.status(200).json({ job: null });
      tf.update(job.booking_id, (e) => { e.tf = { log: [], claimed_at: new Date().toISOString(), snapshots: [] }; });
      tf.log(job.booking_id, 'Agent on the client\'s computer picked up the job');
      return res.status(200).json({ job: { booking_id: job.booking_id, identity: job.identity || job.verified_identity } });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    const b = req.body || {};
    const entry = load()[b.booking];
    if (!entry) return res.status(404).json({ error: 'booking not found' });
    if (entry.status !== 'checking') return res.status(409).json({ error: 'booking is no longer being checked' });

    if (b.action === 'log') {
      const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 50).map((l) => ({
        t: String(l.t || new Date().toISOString()), level: ['info', 'warn', 'error'].includes(l.level) ? l.level : 'info', m: String(l.m || '').slice(0, 500)
      }));
      tf.update(b.booking, (e) => { e.tf = e.tf || {}; e.tf.log = (e.tf.log || []).concat(lines).slice(-tf.MAX_LOG); });
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'patch') {
      const patch = {};
      for (const k of TF_KEYS) if (b.tf && k in b.tf) patch[k] = b.tf[k];
      tf.update(b.booking, (e) => { e.tf = Object.assign(e.tf || {}, patch); });
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'snapshot') {
      const name = String(b.name || '');
      if (!/^[\w-]{1,60}$/.test(name)) return res.status(400).json({ error: 'bad snapshot name' });
      const dir = path.join(tf.SNAPS, b.booking);
      fs.mkdirSync(dir, { recursive: true });
      if (b.png) fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(String(b.png), 'base64'));
      if (b.html) fs.writeFileSync(path.join(dir, name + '.html'), String(b.html).slice(0, 3000000));
      tf.update(b.booking, (e) => { e.tf = e.tf || {}; e.tf.snapshots = (e.tf.snapshots || []).concat(name); });
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'result') {
      const r = tf.applyResult(b.booking, String(b.text || '').slice(0, 500000), entry.identity || entry.verified_identity);
      return res.status(200).json({ ok: true, clear: r.clear, reject: r.reject, reason: r.reason });
    }
    if (b.action === 'fail') {
      tf.applyFail(b.booking, String(b.message || 'agent error').slice(0, 300), !!b.stopped, String(b.stack || '').slice(0, 300), !!b.noRecords);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

