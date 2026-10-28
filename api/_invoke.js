// Call one of our own endpoint handlers in-process (helper, not an endpoint) — lets the background
// pipeline reuse api/background.js, api/insurance.js and api/create-order.js exactly as the page uses them.
function invoke(handler, { method = 'GET', body, query = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ code: this.statusCode, data: o }); return this; },
      send(o) { resolve({ code: this.statusCode, data: o }); return this; },
      setHeader() {}, end(o) { resolve({ code: this.statusCode, data: o }); }
    };
    Promise.resolve(handler({ method, body, query, headers, socket: {} }, res)).catch(reject);
  });
}
module.exports = { invoke };
