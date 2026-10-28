// Poll a Didit session's verification result.
module.exports = async (req, res) => {
  const sid = req.query && req.query.session_id;
  if (!sid) return res.status(400).json({ error: 'session_id required' });
  try {
    const r = await fetch('https://verification.didit.me/v3/session/' + encodeURIComponent(sid) + '/decision/', {
      headers: { 'x-api-key': process.env.DIDIT_API_KEY }
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'didit_error', detail: d });
    // status: Not Started | In Progress | In Review | Approved | Declined | Abandoned
    return res.status(200).json({ status: d.status || 'Unknown' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
