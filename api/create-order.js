// After all verifications pass, create a WooCommerce order and return the pay URL
// (customer pays that pending order with the iPOSpays gateway).
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const b = req.body || {};
    const days = Number(b.days) || 1;
    const total = Number(b.total) || days * 450;
    const productId = Number(process.env.WC_PRODUCT_ID || 381);
    const auth = Buffer.from(process.env.WC_CK + ':' + process.env.WC_CS).toString('base64');

    const order = {
      status: 'pending',
      set_paid: false,
      line_items: [{ product_id: productId, quantity: 1, total: String(total) }],
      billing: {
        first_name: (b.name || 'Verified Driver'),
        email: (b.email || ''),
        phone: (b.phone || '')
      },
      meta_data: [
        { key: '_rental_days', value: String(days) },
        { key: '_pickup', value: b.pickup || '' },
        { key: '_dropoff', value: b.dropoff || '' },
        { key: '_verified_driver', value: 'yes' },
        { key: '_id_check', value: b.id_check === 'skipped' ? 'skipped' : 'passed' }
      ]
    };

    const r = await fetch(process.env.WC_URL + '/wp-json/wc/v3/orders', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'wc_error', detail: d });

    const payUrl = process.env.WC_URL + '/checkout/order-pay/' + d.id + '/?pay_for_order=true&key=' + d.order_key;
    return res.status(200).json({ order_id: d.id, pay_url: payUrl });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
