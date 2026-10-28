// Create a Didit ID-verification session and return the hosted verify URL.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const booking = (req.body && req.body.booking) || ('bk-' + Date.now());
    const base = process.env.APP_URL || ('https://' + req.headers.host);
    const r = await fetch('https://verification.didit.me/v3/session/', {
      method: 'POST',
      headers: { 'x-api-key': process.env.DIDIT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow_id: process.env.DIDIT_WORKFLOW_ID,
        vendor_data: booking,
        callback: base + '/?resume=1'
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'didit_error', detail: d });
    return res.status(200).json({ url: d.url, session_id: d.session_id, booking });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
