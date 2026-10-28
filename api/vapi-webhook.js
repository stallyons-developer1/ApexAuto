// Vapi server messages for insurance calls (set up in api/insurance.js when APP_URL is public https).
//   status-update       → ringing / connected
//   conversation-update → live stage from the transcript (policy given, reviewing, on hold, confirmed)
//   end-of-call-report  → final verified / declined / needs_review, without waiting for the page to poll
// Vapi sends VAPI_WEBHOOK_SECRET in the x-vapi-secret header.
const { load, save } = require('./_store');
const { deriveStage, finish, readResult } = require('./insurance');

module.exports = async (req, res) => {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || req.headers['x-vapi-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const msg = (req.body && req.body.message) || {};
    const callId = msg.call && msg.call.id;
    const all = load('insurance');
    const entry = callId && Object.values(all).find((e) => e.call_id === callId);
    if (!entry || entry.status !== 'calling') return res.status(200).json({}); // not ours, or already final

    if (msg.type === 'status-update') {
      if (msg.status === 'ringing') entry.stage = 'dialing';
      else if (msg.status === 'in-progress' && (!entry.stage || entry.stage === 'dialing')) entry.stage = 'menu';
    } else if (msg.type === 'conversation-update') {
      entry.stage = deriveStage(msg.messages || msg.conversation, entry.policy_number);
      entry.stage_from_webhook = true;
    } else if (msg.type === 'end-of-call-report') {
      const call = { artifact: msg.artifact, analysis: msg.analysis, endedReason: msg.endedReason, recordingUrl: msg.recordingUrl };
      // If the structured result isn't in the report yet, leave it to polling (GET /api/insurance) to finish
      if (!readResult(call)) { entry.stage = 'finishing'; } else { finish(entry, call); }
    } else {
      return res.status(200).json({});
    }
    entry.stage_at = new Date().toISOString();
    save(all, 'insurance');
    return res.status(200).json({});
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
