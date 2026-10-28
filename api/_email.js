// Customer emails for the background-check flow, sent with Resend (helper, not an endpoint).
// Env: RESEND_API_KEY, EMAIL_FROM (e.g. "Imperium Luxury Concierge <bookings@imperiumway.com>" — the domain must be
// verified in Resend; until then Resend's onboarding@resend.dev only delivers to the Resend account's own email).
const FROM = () => process.env.EMAIL_FROM || 'Imperium Luxury Concierge <onboarding@resend.dev>';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, body) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1c2430">
    <h2 style="margin:0 0 14px">${esc(title)}</h2>${body}
    <p style="color:#6b7480;font-size:12px;margin-top:28px">Imperium Luxury Concierge · imperiumway.com</p></div>`;
}

// type: received | approved | declined | review
function build(type, d) {
  const hi = `<p>Hi ${esc(d.name || 'there')},</p>`;
  const trip = d.vehicle ? `<p style="color:#4a5360">${esc(d.vehicle)}${d.dates ? ' · ' + esc(d.dates) : ''}</p>` : '';
  switch (type) {
    case 'received': return {
      subject: 'We received your rental request',
      html: layout('Thanks — we\'re verifying your details', `${hi}${trip}<p>We received your booking and are now running the background and insurance checks. This usually takes a few minutes. We'll email you as soon as it's done — you don't need to keep the page open.</p>`)
    };
    case 'approved': return {
      subject: 'You\'re approved — complete your booking',
      html: layout('You\'re approved!', `${hi}${trip}<p>Your verification is complete. Please complete payment to confirm your rental:</p>` +
        (d.payUrl ? `<p><a href="${esc(d.payUrl)}" style="display:inline-block;background:#0e9e73;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Complete payment</a></p><p style="font-size:12px;color:#6b7480">If the button doesn't work, open: ${esc(d.payUrl)}</p>`
          : `<p>Our team will send you the payment link shortly.</p>`) +
        `<p>The vehicle is released only to the verified driver.</p>`)
    };
    case 'declined': return {
      subject: 'Update on your rental request',
      html: layout('We\'re unable to accept this rental', `${hi}${trip}<p>Unfortunately we're unable to accept this rental request. You have not been charged.</p><p>If you have questions, please reply to this email or contact us.</p>`)
    };
    case 'review': return {
      subject: 'We need a little more time',
      html: layout('Your booking is being reviewed', `${hi}${trip}<p>We need a little more time to complete your verification. Our team will review it and contact you shortly. You have not been charged.</p>`)
    };
    default: throw new Error('unknown email type ' + type);
  }
}

async function sendEmail(type, to, data) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  if (!to) throw new Error('no customer email');
  const { subject, html } = build(type, data || {});
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${d.message || d.name || 'error'}`);
  return d.id;
}

module.exports = { sendEmail };
