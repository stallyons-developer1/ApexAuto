// TruthFinder check for step ② (helper, not an endpoint), on Bart's own paid account. TruthFinder support
// confirmed in writing that a script on our own account is fine "within normal account activity limits",
// but that the data must not be the SOLE factor in an eligibility decision. So:
//   • one search per booking, one at a time, with a gap between searches (TF_MIN_GAP_SECONDS)
//   • no bot-detection evasion — a captcha / block / refused login stops the job and the booking goes to the team
//   • same person + a confirmed clean record → bg_clear; anything else (records, unsure match, errors) →
//     manual_review for a human. Nothing is declined automatically.
//
// It can run in two places, with the same browser flow:
//   server — inside the Node server (dev-server.js): TF_ENABLED=true + TF_EMAIL + TF_PASSWORD on the server
//   agent  — on the client's own computer in a normal Chrome window (agent/truthfinder-agent.js), when
//            TruthFinder refuses logins from the server. The server holds the queue (TF_MODE=agent +
//            TF_AGENT_KEY) and makes the decision; the agent holds the TruthFinder login. See api/tf-agent.js.
// Every step logs to the booking (live log under step 2 in test mode, admin page) and saves a screenshot + HTML.
//
// Env: TF_ENABLED, TF_EMAIL, TF_PASSWORD, TF_MODE (server|agent), TF_AGENT_KEY, TF_HEADLESS (default true),
//      TF_BROWSER_CHANNEL (e.g. chrome), TF_MIN_GAP_SECONDS (default 45),
//      TF_LOGIN_URL (default https://app.truthfinder.com/login), TF_DASHBOARD_URL (default …/dashboard)
const fs = require('fs');
const path = require('path');
const { load, save } = require('./_store');
const { checkReport, middleOk, ageOn, toIsoDate } = require('./_report');

const DATA = path.join(__dirname, '..', 'data');
const PROFILE = () => process.env.TF_PROFILE_DIR || path.join(DATA, 'tf-profile');
const SNAPS = path.join(DATA, 'tf-snapshots');
const DASHBOARD = () => process.env.TF_DASHBOARD_URL || 'https://app.truthfinder.com/dashboard';
const TIMEOUT = 45000;
const MAX_LOG = 200;

const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

// server worker runs the browser here; agent mode only queues and decides
const agentMode = () => process.env.TF_MODE === 'agent' && !!process.env.TF_AGENT_KEY;
const serverWorker = () => process.env.TF_ENABLED === 'true' && !agentMode() && !!process.env.TF_EMAIL && !!process.env.TF_PASSWORD;
const enabled = () => serverWorker() || agentMode(); // step 2 bookings go to "checking"

let context = null;
class Stop extends Error {} // expected outcome that should go to the team (block, no match, …)
class NoRecords extends Stop {} // TruthFinder returned no results at all for the name + state
class BrokenResult extends Error {} // a result's View link led to TruthFinder's "not found" page — skip it

// ---- booking store (server side) -----------------------------------------------------------------
function update(id, fn) {
  const all = load();
  if (!all[id]) return null;
  fn(all[id]);
  save(all);
  return all[id];
}
// io: where the browser flow reports to. Server: straight into the store. Agent: HTTP to the server (setIO).
const localIO = {
  appendLog(id, line) {
    update(id, (e) => { e.tf = e.tf || {}; e.tf.log = (e.tf.log || []).concat(line).slice(-MAX_LOG); });
    (line.level === 'error' ? console.error : console.log)(`[truthfinder] ${id}: ${line.m}`);
  },
  patchTf(id, obj) { update(id, (e) => { e.tf = Object.assign(e.tf || {}, obj); }); },
  saveSnapshot(id, base, png, html) {
    const dir = path.join(SNAPS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, base + '.png'), png);
    fs.writeFileSync(path.join(dir, base + '.html'), html);
    update(id, (e) => { e.tf = e.tf || {}; e.tf.snapshots = (e.tf.snapshots || []).concat(base); });
  }
};
let io = localIO;
function setIO(x) { io = x; }

function log(id, msg, level = 'info') {
  return io.appendLog(id, { t: new Date().toISOString(), level, m: String(msg).slice(0, 500) });
}
const STAGE_TEXT = { starting: 'Starting the check', logging_in: 'Signing in to TruthFinder', searching: 'Searching by name',
  matching: 'Choosing the matching result', reading_report: 'Reading the report' };
function setStage(id, stage, extra) {
  io.patchTf(id, Object.assign({ stage, at: new Date().toISOString() }, extra || {}));
  log(id, `— ${STAGE_TEXT[stage] || stage} —`);
}

// phone in the log: last 4 digits only
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? `***-***-${d.slice(-4)}` : 'not given'; };
const phoneNote = (check) => check.match.phone === null ? ' · phone not given' : ` · phone ${check.match.phone ? '✓' : '✗'} (${check.report.phones || 0} number(s) in report)`;

// ---- decision (always on the server) -----------------------------------------------------------------
function applyResult(id, text, idn) {
  log(id, `Report text captured (${text.length} characters)`);
  const check = checkReport(text, idn);
  const clear = check.readable && check.matched && check.confirmedClean;
  const ok = (v) => (v ? '✓' : '✗');
  log(id, `Report: ${check.report.name || '?'} · DOB ${check.report.dob || '?'} · age ${check.report.age ?? '?'} · states ${check.report.states.join(', ') || '?'}`);
  log(id, `Match with step 1: name ${ok(check.match.name)} · DOB ${check.match.dob === null ? 'not given' : ok(check.match.dob)} · state ${ok(check.match.state)}${phoneNote(check)}`);
  log(id, check.flags.length ? `Flagged records: ${check.flags.join(', ')} (${check.records.length} record line(s))`
    : check.noRecords ? 'Criminal records: none found' : check.records.length ? `Criminal records: ${check.records.length}, none flagged` : 'Criminal records: could not confirm (no "none found" text and no records read)',
    check.flags.length ? 'warn' : 'info');
  if (!check.readable) log(id, 'Report not readable — expected a name plus a criminal-records section', 'warn');
  const reason = !check.readable ? 'report not readable' : !check.matched ? 'identity not fully matched' : check.flags.length ? 'records found'
    : !check.confirmedClean ? "criminal section didn't confirm a clean record" : '';
  // Client's rule (TF_ON_RECORDS, default "reject"): the confirmed customer has flagged records → rejected.
  // NOT when the match was ambiguous (no DOB/phone, several people with the name) — the record may be someone
  // else's, so that goes to the team. TF_ON_RECORDS=review sends every record to the team instead.
  // Note: TruthFinder says its data must not be the sole factor, and the handoff docs say never auto-reject;
  // this is the client's decision and their legal risk (FCRA).
  const ambiguous = !!(load()[id] && load()[id].tf && load()[id].tf.ambiguous);
  const reject = !clear && check.readable && check.matched && check.flags.length > 0 && !ambiguous && (process.env.TF_ON_RECORDS || 'reject') !== 'review';
  update(id, (e) => {
    e.report_check = check;
    e.status = clear ? 'bg_clear' : reject ? 'declined_background' : 'manual_review';
    e.tf = Object.assign(e.tf || {}, { stage: 'done', result: clear ? 'clear' : reject ? 'rejected' : 'review', reason, finished_at: new Date().toISOString() });
  });
  log(id, clear ? 'RESULT: CLEAR — step 2 complete, step 3 unlocked'
    : reject ? `RESULT: REJECTED — records found (${check.flags.join(', ')})`
    : `RESULT: sent to team review — ${reason}${ambiguous && check.flags.length ? ' (not sure the record is the customer\'s)' : ''}`, clear ? 'info' : 'warn');
  return { clear, reject, reason };
}
// No TruthFinder results for the name + state. Client's rule (TF_NO_RESULTS, default "clear"): treat as a clean
// record. Note this means "TruthFinder has no data on them", not "checked and clean"; set TF_NO_RESULTS=review
// to send these to the team instead.
function applyNoRecords(id, msg) {
  const clear = (process.env.TF_NO_RESULTS || 'clear') !== 'review';
  update(id, (e) => {
    e.status = clear ? 'bg_clear' : 'manual_review';
    e.tf = Object.assign(e.tf || {}, { stage: 'done', result: clear ? 'clear' : 'review', reason: 'no record found (no TruthFinder result matches name + state + DOB)', finished_at: new Date().toISOString() });
  });
  log(id, msg);
  log(id, clear ? 'RESULT: CLEAR (no records found) — step 2 complete, step 3 unlocked' : 'RESULT: sent to team review — no records found (TF_NO_RESULTS=review)', clear ? 'info' : 'warn');
}
function applyFail(id, msg, stopped, stack, noRecords) {
  if (noRecords) return applyNoRecords(id, msg);
  update(id, (e) => { e.status = 'manual_review'; e.tf = Object.assign(e.tf || {}, { stage: 'failed', error: msg, result: 'review', finished_at: new Date().toISOString() }); });
  log(id, `${stopped ? 'STOPPED' : 'ERROR'}: ${msg}`, 'error');
  if (stack) log(id, 'at ' + stack, 'error');
  log(id, 'RESULT: sent to team review', 'warn');
}
const errInfo = (err) => ({
  msg: String((err && err.message) || err).slice(0, 300),
  stopped: err instanceof Stop,
  noRecords: err instanceof NoRecords,
  stack: !(err instanceof Stop) && err && err.stack ? String(err.stack).split('\n').slice(1, 3).map((s) => s.trim()).join(' | ') : ''
});

// ---- server worker: in-process queue -------------------------------------------------------------------
const queue = [];
let running = false, lastSearchAt = 0;
function enqueue(bookingId) {
  if (agentMode()) { log(bookingId, 'Queued — waiting for the TruthFinder agent on the client\'s computer to pick it up'); return; }
  if (!serverWorker()) return;
  if (!queue.includes(bookingId)) queue.push(bookingId);
  setImmediate(pump);
}
function start() {
  if (agentMode()) { console.log('[truthfinder] agent mode — waiting for the agent on the client\'s computer (api/tf-agent)'); return; }
  if (!serverWorker()) return;
  for (const e of Object.values(load())) if (e.status === 'checking') enqueue(e.booking_id); // resume after a restart
  console.log('[truthfinder] worker ready' + (queue.length ? `, resuming ${queue.length} job(s)` : ''));
}
async function gapBeforeSearch(id) {
  const gap = Number(process.env.TF_MIN_GAP_SECONDS || 45) * 1000 - (Date.now() - lastSearchAt);
  if (gap > 0) { log(id, `Waiting ${Math.ceil(gap / 1000)}s before the next search (normal activity limit)`); await sleep(gap); }
}
async function pump() {
  if (running || !queue.length) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const entry = load()[id];
      if (!entry || entry.status !== 'checking') continue;
      update(id, (e) => { e.tf = { log: [] }; }); // fresh log for this run
      await gapBeforeSearch(id);
      const idn = entry.identity || entry.verified_identity;
      try {
        const text = await runBrowserCheck(id, idn);
        applyResult(id, text, idn);
      } catch (err) {
        const x = errInfo(err);
        applyFail(id, x.msg, x.stopped, x.stack, x.noRecords);
      }
      lastSearchAt = Date.now();
    }
  } finally {
    running = false;
    await closeBrowser(); // free memory between bursts
  }
}

// The browser flow (server worker and agent): returns the report text, throws Stop / Error otherwise
async function runBrowserCheck(id, idn) {
  setStage(id, 'starting', { error: '', started_at: new Date().toISOString(), snapshots: [] });
  if (!idn || !idn.first_name || !idn.last_name) throw new Stop('no identity to search');
  log(id, `Step 1 identity: ${idn.first_name}${idn.middle_name ? ' ' + idn.middle_name : ''} ${idn.last_name} · DOB ${idn.date_of_birth || '?'} · state ${idn.issuing_state || '?'} · phone ${maskPhone(idn.phone)}`);
  try {
    return await fetchReportText(id, idn);
  } catch (err) {
    if (!(err instanceof Stop)) await closeBrowser(); // fresh browser next time
    throw err;
  }
}

// ---- browser -----------------------------------------------------------------------------------------
async function browser() {
  if (context) return context;
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { throw new Error('playwright is not installed (server: deploy with the Dockerfile; agent: run START-AGENT)'); }
  fs.mkdirSync(PROFILE(), { recursive: true });
  const opts = {
    headless: process.env.TF_HEADLESS !== 'false',
    viewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'] // container-friendly (Railway / Docker)
  };
  const channel = process.env.TF_BROWSER_CHANNEL; // "chrome" = the computer's installed Google Chrome
  try {
    context = await chromium.launchPersistentContext(PROFILE(), channel ? Object.assign({ channel }, opts) : opts);
  } catch (e) {
    if (!channel) throw e;
    console.log(`[truthfinder] ${channel} not available (${e.message.split('\n')[0]}) — using the bundled Chromium`);
    context = await chromium.launchPersistentContext(PROFILE(), opts);
  }
  context.setDefaultTimeout(TIMEOUT);
  // if someone closes the Chrome window, forget it — the next check opens a fresh one
  const ctx = context;
  ctx.on('close', () => { if (context === ctx) context = null; });
  return context;
}
async function closeBrowser() {
  if (context) { await context.close().catch(() => {}); context = null; }
}

const snapCount = {};
async function snap(page, id, step) {
  try {
    snapCount[id] = (snapCount[id] || 0) + 1;
    const base = `${String(snapCount[id]).padStart(2, '0')}-${step}`;
    const png = await page.screenshot({ fullPage: true });
    await io.saveSnapshot(id, base, png, await page.content());
    log(id, `Snapshot saved: ${base} (page: ${page.url()})`);
  } catch (e) { log(id, `Snapshot failed (${step}): ${e.message}`, 'warn'); }
}

// A captcha / block the user would have to solve. TruthFinder's normal login page carries Google's
// invisible reCAPTCHA badge (.grecaptcha-badge, size=invisible) for every visitor — that is not a challenge
// and is ignored. A visible "I'm not a robot" box, an image-challenge popup, hCaptcha / Turnstile or a
// Cloudflare check page stops the job — it is never solved or bypassed.
async function assertNotBlocked(page, id) {
  const found = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (f.closest('.grecaptcha-badge') || /size=invisible/.test(src) || !visible(f)) continue;
      if (/recaptcha\/(api2|enterprise)\/(anchor|bframe)/.test(src)) return 'reCAPTCHA challenge (' + (/bframe/.test(src) ? 'image puzzle' : '"I\'m not a robot" box') + ')';
      if (/hcaptcha\.com/.test(src)) return 'hCaptcha challenge';
      if (/challenges\.cloudflare\.com|turnstile/.test(src)) return 'Cloudflare check';
    }
    if (document.querySelector('#challenge-form, #cf-challenge-running')) return 'Cloudflare check page';
    const t = (document.body.innerText || '').slice(0, 5000);
    const m = t.match(/verify you are (a )?human|are you a robot|unusual (traffic|activity)|access denied|attention required/i);
    return m ? `page says "${m[0]}"` : '';
  }).catch(() => '');
  if (found) {
    await snap(page, id, 'blocked');
    throw new Stop(`TruthFinder showed a ${found} — not bypassed; the team will check manually`);
  }
}

// Visible element from a list of candidate locators (first that exists)
async function firstVisible(locators) {
  for (const l of locators) {
    const el = l.first();
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

const LOGIN = () => process.env.TF_LOGIN_URL || 'https://app.truthfinder.com/login';

// The dashboard's "Search By" form is ready (Name tab / First Name field) — not just the header search bar
async function onDashboard(page) {
  return !!(await firstVisible([page.getByPlaceholder(/first name/i), page.getByLabel(/first name/i),
    page.getByRole('tab', { name: /^\s*name\s*$/i }), page.getByText(/^\s*search by\s*$/i)]));
}
// Signed in at all (the side menu has "Log Out")
async function signedIn(page) {
  return !!(await firstVisible([page.getByRole('link', { name: /log ?out/i }), page.getByRole('button', { name: /log ?out/i }), page.getByText(/^\s*log ?out\s*$/i)]));
}
// After sign-in TruthFinder may pass through /verification and load the dashboard slowly: wait for the form.
async function waitForSearchForm(page, id) {
  let noted = false;
  for (let i = 0; i < 30; i++) {
    if (await onDashboard(page)) return;
    if (/verification/i.test(page.url()) && !noted) { log(id, `TruthFinder is on its verification page (${page.url()}) — waiting for it to finish`); noted = true; }
    const t = (await page.innerText('body').catch(() => '')).slice(0, 4000);
    // TruthFinder's one-time "new device" check — account security, done once by a person, never automated
    if (/verify this new device|new device login|send verification email|enter (the )?(code|verification code)|verify your (email|phone|device|identity)|we sent (you )?a code|one-time (code|passcode)/i.test(t)) {
      await snap(page, id, 'device-verification');
      throw new Stop('TruthFinder wants to verify this new device (one time only). In the agent\'s Chrome window click "Send Verification Email", open the email and click its link (paste the link into that same Chrome window), then run the check again');
    }
    await assertNotBlocked(page, id);
    await sleep(1500);
  }
  if (!/dashboard/i.test(page.url())) { await goTo(page, id, DASHBOARD()); if (await onDashboard(page)) return; }
  await snap(page, id, 'no-search-form');
  throw new Error(`the dashboard "Search By" form did not appear (page: ${page.url()})`);
}
async function goTo(page, id, url) {
  log(id, `Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await assertNotBlocked(page, id);
}

// dashboard → already signed in? done. Otherwise sign in (on the page the dashboard sent us to, or on
// app.truthfinder.com/login) and come back to the dashboard.
async function ensureLoggedIn(page, id) {
  await goTo(page, id, DASHBOARD());
  const pass = page.locator('input[type="password"]');
  const passVisible = () => pass.first().isVisible().catch(() => false);
  if (!(await passVisible())) {
    if ((await onDashboard(page)) || (await signedIn(page))) {
      log(id, 'Already signed in (saved session)');
      await waitForSearchForm(page, id);
      log(id, 'Dashboard search form found');
      return;
    }
    log(id, `No login form and no search form on ${page.url()} — trying the login page`, 'warn');
    await goTo(page, id, LOGIN());
    if (!(await passVisible())) {
      await goTo(page, id, DASHBOARD());
      if (await onDashboard(page)) { log(id, 'Dashboard search form found'); return; }
      await snap(page, id, 'no-login-form');
      throw new Error('neither the dashboard search form nor the login form was found');
    }
  }

  setStage(id, 'logging_in');
  await snap(page, id, 'login');
  const email = await firstVisible([page.locator('input[type="email"]'), page.locator('input[name*="email" i]'), page.getByLabel(/email/i), page.getByPlaceholder(/email/i)]);
  if (!email) throw new Error('login form: email field not found');
  const em = String(process.env.TF_EMAIL).trim(), pw = String(process.env.TF_PASSWORD);
  await email.fill(em);
  await pass.first().fill(pw);
  // masked, to confirm the Railway variables arrived as intended (spaces / quotes are a common cause of failed logins)
  log(id, `Using TF_EMAIL ${em.replace(/^(.{2}).*(@.*)$/, '$1***$2')} · TF_PASSWORD length ${pw.length}${pw !== pw.trim() ? ' (has leading/trailing spaces!)' : ''}`);
  const submit = await firstVisible([page.getByRole('button', { name: /log ?in|sign ?in|continue/i }), page.locator('button[type="submit"], input[type="submit"]')]);
  if (!submit) throw new Error('login form: submit button not found');
  const btnText = ((await submit.innerText().catch(() => '')) || (await submit.getAttribute('value').catch(() => '')) || 'submit').trim();
  log(id, `Email and password entered (password hidden) — clicking "${btnText}"`);
  // The login may happen in the background (no page reload): wait until we leave /login, the password
  // field goes away, or an error message shows — not just for the page to settle.
  const settled = () => page.waitForFunction(() => {
    const onLogin = /login|sign-?in/i.test(location.pathname);
    const pw = [...document.querySelectorAll('input[type="password"]')].some((e) => e.offsetParent !== null);
    const err = /invalid|incorrect|wrong|not recognized|try again|doesn'?t match|no account|locked/i.test(document.body.innerText);
    return !onLogin || !pw || err;
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  // Diagnostics: what the login request actually got back (status + start of the body) — tells a wrong
  // password apart from a request the site refused (bot check, IP block, captcha required…)
  const seenResponses = [];
  const onResponse = async (r) => {
    try {
      const req = r.request();
      if (req.method() === 'GET' || !/login|sign-?in|auth|session|token|account/i.test(r.url())) return;
      // never log tokens: a successful login only shows its status and the names of the fields it returned
      let body = (await r.text().catch(() => '')).replace(/\s+/g, ' ');
      if (r.ok()) { try { body = '(fields: ' + Object.keys(JSON.parse(body)).join(', ') + ')'; } catch (e) { body = ''; } }
      else body = body.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>').replace(/("?(token|refreshToken|accessToken|password|secret)"?\s*:\s*)"[^"]*"/gi, '$1"<hidden>"').slice(0, 300);
      seenResponses.push(`${req.method()} ${r.url().replace(/\?.*/, '')} → ${r.status()} ${body}`);
    } catch (e) { /* ignore */ }
  };
  page.on('response', onResponse);
  await submit.click();
  let done = await settled();
  if (!done) {
    log(id, 'Still on the login page after the click — pressing Enter in the password field', 'warn');
    await pass.first().press('Enter').catch(() => {});
    done = await settled();
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(1000);
  page.off('response', onResponse);
  if (seenResponses.length) seenResponses.slice(0, 6).forEach((s) => log(id, `Login request: ${s}`));
  else log(id, 'No login request was seen after clicking — the page may have refused before sending (e.g. a hidden captcha check)', 'warn');
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
  log(id, `Browser: ${ua}`);
  await assertNotBlocked(page, id);
  if (await passVisible()) {
    // the page's own error message, if it shows one
    const msg = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[role="alert"], .error, .alert, [class*="error" i], [class*="invalid" i], [class*="alert" i]')]
        .find((e) => e.offsetParent !== null && (e.innerText || '').trim());
      if (el) return el.innerText.trim();
      const m = document.body.innerText.match(/[^\n]*(invalid|incorrect|wrong|not recognized|try again|doesn'?t match|no account|locked)[^\n]*/i);
      return m ? m[0].trim() : '';
    }).catch(() => '');
    log(id, `Login page says: ${msg ? `"${msg.slice(0, 200)}"` : '(no error message shown)'} · still at ${page.url()}`, 'warn');
    await snap(page, id, 'login-failed');
    throw new Stop('TruthFinder login failed — check TF_EMAIL / TF_PASSWORD');
  }
  log(id, 'Signed in — waiting for the dashboard search form');
  await waitForSearchForm(page, id);
  log(id, 'Dashboard search form found');
}

// TruthFinder dashboard flow (as walked through by hand on app.truthfinder.com):
//   dashboard "Search By" → Name tab → First Name, Last Name, State dropdown (full state names) → Search
//   → results ("109 Results"): cards with name, sometimes age, Aliases, Locations, Possible Relatives, a View button
//   → View → /reports/<id>/overview → "View Detailed Report" → tabs: Personal, Locations, Criminal Records, …
async function search(page, id, idn) {
  setStage(id, 'searching');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // "Search By": Name tab (Phone / Email / Address are the others)
  const nameTab = await firstVisible([page.getByRole('tab', { name: /^\s*name\s*$/i }), page.getByRole('button', { name: /^\s*name\s*$/i }),
    page.getByRole('link', { name: /^\s*name\s*$/i }), page.getByText(/^\s*name\s*$/i)]);
  if (nameTab) { await nameTab.click().catch(() => {}); log(id, 'Clicked the "Name" tab'); }
  else log(id, '"Name" tab not found — using the form as shown', 'warn');
  await snap(page, id, 'dashboard');

  const first = await firstVisible([page.getByPlaceholder(/first name/i), page.getByLabel(/first name/i), page.locator('input[name*="first" i]')]);
  const last = await firstVisible([page.getByPlaceholder(/last name/i), page.getByLabel(/last name/i), page.locator('input[name*="last" i]')]);
  if (!first || !last) throw new Error('search form: First Name / Last Name fields not found');
  await first.fill(idn.first_name);
  await last.fill(idn.last_name);
  // Middle name → TruthFinder's "M.I." box (initial), or a full "Middle Name" box if that's what it has.
  // City and Age stay empty — the right person is picked from the results by state + age.
  let mi = '';
  if (idn.middle_name) {
    const box = await firstVisible([page.getByPlaceholder(/^\s*m\.?\s*i\.?\s*$|middle/i), page.getByLabel(/^\s*m\.?\s*i\.?\s*$|middle/i), page.locator('input[name*="middle" i], input[name="mi" i]')]);
    if (box) {
      const ph = `${(await box.getAttribute('placeholder').catch(() => '')) || ''} ${(await box.getAttribute('name').catch(() => '')) || ''}`;
      mi = /middle\s*name/i.test(ph) ? idn.middle_name : idn.middle_name.trim()[0].toUpperCase();
      await box.fill(mi);
    } else log(id, 'Middle name given, but no M.I. box on the search form — searching without it', 'warn');
  }

  const st = String(idn.issuing_state || '').toUpperCase();
  const stateName = STATE_NAMES[st] || st;
  const sel = await firstVisible([page.locator('select[name*="state" i]'), page.getByLabel(/^\s*state\s*$/i).locator('xpath=self::select'), page.locator('select')]);
  if (sel) {
    await sel.selectOption({ label: stateName }).catch(() => sel.selectOption({ value: st })).catch(() => sel.selectOption({ value: stateName }))
      .catch(() => { throw new Error(`search form: state "${stateName}" not in the dropdown`); });
  } else {
    // custom dropdown: open it, then pick the state by its visible name
    const dd = await firstVisible([page.getByRole('combobox', { name: /state/i }), page.getByText(/^\s*(select )?state\s*$/i), page.getByPlaceholder(/state/i)]);
    if (!dd) throw new Error('search form: State dropdown not found');
    await dd.click();
    const opt = await firstVisible([page.getByRole('option', { name: new RegExp(`^\\s*${stateName}\\s*$`, 'i') }), page.getByText(new RegExp(`^\\s*${stateName}\\s*$`, 'i'))]);
    if (!opt) throw new Error(`search form: state "${stateName}" not in the dropdown`);
    await opt.click();
  }
  log(id, `Filled First Name "${idn.first_name}"${mi ? `, M.I. "${mi}"` : ''}, Last Name "${idn.last_name}", State "${stateName}" (${sel ? 'select' : 'custom dropdown'})`);

  const go =await firstVisible([page.getByRole('button', { name: /^\s*search\s*$/i }), page.getByRole('button', { name: /search/i }), page.locator('button[type="submit"]')]);
  if (!go) throw new Error('search form: Search button not found');
  await go.click();
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  // results page says "<n> Results"
  log(id, 'Clicked Search — waiting for results');
  const seen = await waitForResults(page);
  if (!seen) log(id, 'Results did not finish loading within 45s — reading whatever is on the page', 'warn');
  await assertNotBlocked(page, id);
  await snap(page, id, 'results');
}

// TruthFinder shows "Loading... Please be patient" and placeholder text while it searches. Wait until that
// is gone AND there are result cards (View buttons) or an explicit "no results" message — then until the
// number of cards stops changing (results can arrive in batches). True when results were ready.
const LOADING = /please be patient|loading\.\.\.|charm cleric/i;
async function waitForResults(page) {
  const ready = await page.waitForFunction((loadingSrc) => {
    const t = document.body.innerText || '';
    if (new RegExp(loadingSrc, 'i').test(t)) return false;
    const views = [...document.querySelectorAll('a, button')].filter((b) => /^\s*view( report)?\s*$/i.test(b.innerText || '')).length;
    return views > 0 || /\b0\s+results?\b|no (search )?results( found)?|no records? found|we (could not|couldn'?t|did not|didn'?t) find/i.test(t);
  }, LOADING.source, { timeout: 45000 }).then(() => true).catch(() => false);
  if (!ready) return false;
  let prev = -1;
  for (let i = 0; i < 6; i++) { // settle: same card count twice in a row
    const n = await page.evaluate(() => [...document.querySelectorAll('a, button')].filter((b) => /^\s*view( report)?\s*$/i.test(b.innerText || '')).length).catch(() => 0);
    if (n === prev) break;
    prev = n;
    await sleep(1200);
  }
  return true;
}

// Read the result cards on the results page and mark each card's View button (data-apex-view=<n>)
async function markCards(page, idn) {
  return page.evaluate(({ last }) => {
    const l = last.toLowerCase();
    const views = [...document.querySelectorAll('a, button')].filter((b) => /^\s*view( report)?\s*$/i.test(b.innerText || ''));
    const out = [];
    for (const v of views) {
      // climb to the card: the largest ancestor that still holds only this one View button
      let el = v;
      while (el.parentElement && el.parentElement !== document.body) {
        const p = el.parentElement;
        const viewsInside = [...p.querySelectorAll('a, button')].filter((b) => /^\s*view( report)?\s*$/i.test(b.innerText || '')).length;
        if (viewsInside > 1) break;
        el = p;
      }
      const text = (el.innerText || '').trim();
      if (!text.toLowerCase().includes(l)) continue;
      v.setAttribute('data-apex-view', String(out.length));
      out.push(text);
    }
    const body = document.body.innerText;
    const total = (body.match(/\b(\d[\d,]*)\s+results?\b/i) || [])[1];
    const none = /\b0\s+results?\b|no (search )?results( found)?|no records? found|we (could not|couldn'?t|did not|didn'?t) find (any|a match)/i.test(body);
    return { out, total: total ? Number(total.replace(/,/g, '')) : null, none };
  }, { last: idn.last_name });
}

// Results that are this person — the card must match ALL THREE: first + last name, the ID's state in its
// Locations, and the date of birth (the card shows an age or a birth year, never the full date — checked
// within a year). A card that doesn't show an age / birth year doesn't count. No match → no report is opened
// and the check returns "no record found" (NoRecords → client's rule: clear).
async function findCandidates(page, id, idn) {
  setStage(id, 'matching');
  const cards = await markCards(page, idn);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const f = norm(idn.first_name).split(' ')[0], l = norm(idn.last_name).split(' ').pop();
  const st = String(idn.issuing_state || '').toUpperCase();
  const stRe = new RegExp(`\\b${st}\\b|\\b${STATE_NAMES[st] || '#'}\\b`, 'i');
  const dobIso = toIsoDate(idn.date_of_birth);
  const wantAge = ageOn(dobIso), wantYear = dobIso ? Number(dobIso.slice(0, 4)) : null;

  // TruthFinder card: [badge "First and Last Name Match"] / name / Aliases … / age as a bare number line /
  // Locations … / Possible Relatives … / View
  const BADGE = /^\s*(first and last name match|first name match|last name match|best match|exact match)\s*$/i;
  const scored = cards.out.map((t, i) => {
    const lines = t.split('\n').map((s) => s.trim()).filter((s) => s && !BADGE.test(s));
    const nameLine = lines[0] || '';
    const head = norm(lines.join('\n').split(/aliases|also known|locations?|lived in|possible relatives|relatives|\bage\b|\bborn\b|\n\d{2,3}\n/i)[0]).split(' ');
    const locPart = (t.match(/locations?[\s\S]*?(?=possible relatives|relatives|$)/i) || [t])[0];
    const bare = lines.find((s) => /^\d{2,3}$/.test(s)); // the age line
    const age = Number((t.match(/\bage\b\s*:?\s*(\d{2,3})/i) || t.match(/\b(\d{2,3})\s*(?:years|yrs)\b/i) || [])[1] || bare) || null;
    const born = Number((t.match(/\b(?:born|dob|birth(?:day|date)?)\b[^\d\n]{0,20}(?:\d{1,2}[\/-]\d{1,2}[\/-])?((?:19|20)\d{2})\b/i) || [])[1]) || null;
    // date of birth vs the card: age (±1 — the birthday may or may not have passed) or birth year
    const dob = !wantAge ? null : age != null ? Math.abs(age - wantAge) <= 1 : born != null ? Math.abs(born - wantYear) <= 0 : null;
    const cardName = norm(nameLine).split(' ');
    return { i, nameLine, name: head.includes(f) && head.includes(l) && middleOk(cardName, f, l, idn.middle_name), state: stRe.test(locPart), age, born, dob };
  });
  // Open: cards whose age matches first; then (unless TF_OPEN_NO_AGE=false) cards that show no age at all —
  // a missing age is not a mismatch, and skipping them would let anyone whose card hides the age pass
  // unchecked. Their report's age / DOB / phone is verified after opening. A card whose age differs is never opened.
  const openNoAge = process.env.TF_OPEN_NO_AGE !== 'false';
  // no date of birth given: the age can't be checked, so every name + state match is a candidate
  // the exact age first (today's age from the DOB), then ±1 (TruthFinder's age can be a year off), then no age
  const ageMatched = scored.filter((c) => c.name && c.state && c.dob === true);
  for (const c of ageMatched) c.exact = c.age != null ? c.age === wantAge : c.born === wantYear;
  let fit = ageMatched.filter((c) => c.exact).concat(ageMatched.filter((c) => !c.exact))
    .concat(openNoAge || !wantAge ? scored.filter((c) => c.name && c.state && c.dob === null) : []);
  io.patchTf(id, { results_total: cards.total, results_seen: cards.out.length, results_fit: fit.length });
  log(id, `Results: ${cards.total ?? '?'} total · ${cards.out.length} card(s) with "${idn.last_name}" · looking for name + ${st} + age ${wantAge ?? '?'} (born ${wantYear ?? '?'})`);
  scored.slice(0, 15).forEach((c) => log(id, `  #${c.i + 1} ${c.nameLine.slice(0, 60)} — name ${c.name ? '✓' : '✗'} · ${st} ${c.state ? '✓' : '✗'} · DOB ${!wantAge ? 'not given' : c.dob === true ? '✓' : c.dob === false ? '✗' : '? (no age on card — checked in the report)'}${c.age != null ? ' (age ' + c.age + ')' : c.born ? ' (born ' + c.born + ')' : ''}`));
  const byAge = fit.filter((c) => c.dob === true).length;
  log(id, fit.length ? `Profiles to open: ${Math.min(fit.length, maxReports())} of ${fit.length} (${byAge} with matching age, ${fit.length - byAge} without an age on the card)` : 'No result matches name + state + DOB — not opening any report');

  // nobody with this name / state / age on TruthFinder → no record of this person → client's rule: clear
  if (!cards.out.length && (cards.total === 0 || cards.none)) {
    await snap(page, id, 'no-results');
    throw new NoRecords(`TruthFinder found no records for ${idn.first_name} ${idn.last_name} in ${STATE_NAMES[st] || st}`);
  }
  if (!cards.out.length) throw new Stop('no result cards with this last name on the results page');
  if (!fit.length) throw new NoRecords(`No record found — no TruthFinder result matches ${idn.first_name} ${idn.last_name}, ${STATE_NAMES[st] || st}, born ${dobIso || '?'}`);
  // A full middle name ("Paul", not just "P") that appears on exactly one card identifies the customer:
  // open that card first and treat it as the person (not ambiguous)
  const fullMid = norm(idn.middle_name || '').split(' ')[0];
  let strongId = false;
  if (fullMid.length > 1 && fit.length > 1) {
    const exact = fit.filter((c) => norm(c.nameLine).split(' ').includes(fullMid));
    if (exact.length === 1) {
      fit = [exact[0]].concat(fit.filter((c) => c !== exact[0]));
      strongId = true;
      log(id, `Only result #${exact[0].i + 1} shows the full middle name "${idn.middle_name}" — treating it as the customer`);
    }
  }
  const list = fit.slice(0, maxReports()).map((c) => c.i);
  list.exact = new Set(fit.filter((c) => c.exact).map((c) => c.i)); // cards whose age is exactly right
  if (wantAge && ageMatched.length) log(id, `Exact age ${wantAge}: ${list.exact.size} card(s); within a year: ${ageMatched.length - list.exact.size}`);
  // Nothing to tell people apart (no DOB, no phone) and more than one candidate: we can't know which one is
  // the customer. Too many to check → team; otherwise every one gets checked (see fetchReportText).
  list.ambiguous = !wantAge && !strongId && !String(idn.phone || '').replace(/\D/g, '') && fit.length > 1;
  if (list.ambiguous && fit.length > maxReports()) {
    throw new Stop(`${fit.length} people named ${idn.first_name} ${idn.last_name} in ${STATE_NAMES[st] || st} and no date of birth or phone to tell them apart — the team will review`);
  }
  if (list.ambiguous) log(id, `No date of birth or phone given — can't tell these ${fit.length} apart, so all of them are checked: any record → team review, all clean → clear`, 'warn');
  return list;
}
const maxReports = () => Math.max(1, Number(process.env.TF_MAX_REPORTS || 3));

// Back to the results page for the next candidate (re-search if the page can't be restored)
async function backToResults(page, id, idn, resultsUrl) {
  await goTo(page, id, resultsUrl);
  await waitForResults(page);
  if ((await markCards(page, idn)).out.length) return;
  log(id, 'Results page did not come back — searching again', 'warn');
  await goTo(page, id, DASHBOARD());
  await waitForSearchForm(page, id);
  await search(page, id, idn);
  await markCards(page, idn);
}

// Open a report (View → overview → View Detailed Report) and return its text; leaves only the main tab open
async function readReport(ctx, page, id) {
  setStage(id, 'reading_report');
  await sleep(1500);
  let report = ctx.pages()[ctx.pages().length - 1]; // the report may open in a new tab
  await report.waitForLoadState('domcontentloaded').catch(() => {});
  await report.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await assertNotBlocked(report, id);
  // TruthFinder first shows placeholder text while the report builds — wait for the subject's header
  // ("<name> NN years old" / "Born …") before reading anything or looking for "View Detailed Report"
  // header loaded, or TruthFinder's "not found" page (broken result link) — whichever comes first
  const loaded = await report.waitForFunction(() => /\b\d{2,3}\s+years?\s+old\b|\bBorn\b/i.test(document.body.innerText) || /not-found/.test(location.pathname),
    null, { timeout: 45000 }).then(() => true).catch(() => false);
  if (/not-found/.test(report.url())) {
    await snap(report, id, 'not-found');
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
    throw new BrokenResult(`TruthFinder opened its "not found" page (${report.url()})`);
  }
  if (!loaded) log(id, 'Report header ("NN years old" / "Born") did not appear within 45s', 'warn');
  await waitForReport(report, id);
  await snap(report, id, 'overview');
  const overviewText = await report.innerText('body').catch(() => '');

  const detailedLoc = report.getByRole('link', { name: /view detailed report/i }).or(report.getByRole('button', { name: /view detailed report/i })).or(report.getByText(/view detailed report/i));
  await detailedLoc.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const detailed = await firstVisible([report.getByRole('link', { name: /view detailed report/i }), report.getByRole('button', { name: /view detailed report/i }), report.getByText(/view detailed report/i)]);
  log(id, `Report overview open: ${report.url()}`);
  if (!detailed) log(id, '"View Detailed Report" not found on the overview — reading the page as is', 'warn');
  if (detailed) {
    log(id, 'Clicking "View Detailed Report"');
    const before = ctx.pages().length;
    await detailed.click();
    await sleep(1500);
    if (ctx.pages().length > before) report = ctx.pages()[ctx.pages().length - 1];
    await report.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await waitForReport(report, id);
  // the detailed report is one long page (its menu just scrolls), so the page text holds every section
  const text = [overviewText, await report.innerText('body').catch(() => '')].join('\n\n');
  log(id, `Read the detailed report (${text.length} characters)`);
  await snap(report, id, 'report');
  for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
  if (!text.trim()) throw new Error('report page was empty');
  return text;
}

async function fetchReportText(id, idn) {
  let ctx = await browser(), page;
  try {
    page = ctx.pages()[0] || (await ctx.newPage());
  } catch (e) {
    // the window was closed underneath us — open a fresh one once
    log(id, 'The Chrome window had been closed — opening a new one', 'warn');
    context = null;
    ctx = await browser();
    page = ctx.pages()[0] || (await ctx.newPage());
  }
  await ensureLoggedIn(page, id);
  await search(page, id, idn);
  const resultsUrl = page.url();
  const candidates = await findCandidates(page, id, idn);
  let ambiguousClean = null, broken = 0;

  // open the possible matches one by one until a report is this person (name + DOB/age + state)
  for (let k = 0; k < candidates.length; k++) {
    if (k > 0) await backToResults(page, id, idn, resultsUrl);
    const n = candidates[k];
    io.patchTf(id, { picked: n + 1 });
    log(id, `Opening result #${n + 1} (${k + 1} of ${candidates.length}) — clicking View`);
    await page.locator(`[data-apex-view="${n}"]`).click();
    let text;
    try {
      text = await readReport(ctx, page, id);
    } catch (e) {
      if (!(e instanceof BrokenResult)) throw e;
      // TruthFinder's "not found" can be temporary — try that card once more
      log(id, `Result #${n + 1}: ${e.message} — trying it once more`, 'warn');
      await sleep(3000);
      await backToResults(page, id, idn, resultsUrl);
      await page.locator(`[data-apex-view="${n}"]`).click();
      try {
        text = await readReport(ctx, page, id);
      } catch (e2) {
        if (!(e2 instanceof BrokenResult)) throw e2;
        // only an exact-age card that can't be opened might really be the customer; a ±1-year one is just a guess
        if (candidates.exact && candidates.exact.has(n)) {
          broken++;
          log(id, `Result #${n + 1} (exact age match) still can't be opened — it may be the customer`, 'warn');
        } else {
          log(id, `Result #${n + 1} still can't be opened — it was only a ±1-year age match, so it doesn't block the decision`, 'warn');
        }
        continue;
      }
    }
    const check = checkReport(text, idn);
    const ok = (v) => (v ? '✓' : '✗');
    log(id, `Result #${n + 1}: ${check.report.name || '?'} · DOB ${check.report.dob || '?'} · age ${check.report.age ?? '?'} — name ${ok(check.match.name)} · DOB/age ${check.match.dob === null ? 'not given' : ok(check.match.dob)} · state ${ok(check.match.state)}${phoneNote(check)}`);
    // couldn't tell whose report it is (page didn't load / layout changed): never treat as "someone else"
    // — that would clear the booking without a real check. Stop and let the team look.
    if (!check.identified) {
      throw new Stop(`could not read result #${n + 1}'s report (no name / age header found) — not deciding automatically`);
    }
    if (check.matched && candidates.ambiguous) {
      // can't tell which one is the customer: a record on ANY of them sends it to the team
      if (check.flags.length) { io.patchTf(id, { ambiguous: true }); log(id, `Result #${n + 1} has records (${check.flags.join(', ')}) — could be the customer`, 'warn'); return text; }
      log(id, `Result #${n + 1}: no flagged records`);
      ambiguousClean = ambiguousClean || text;
      continue;
    }
    if (check.matched) {
      io.patchTf(id, { picked_by: 'report matches name + DOB/age + state' });
      log(id, `Result #${n + 1} is this person`);
      return text;
    }
    // TruthFinder has no age/DOB for this person, so the DOB can't be confirmed either way
    if (check.match.name && check.match.state && check.match.dob === false && check.report.noAge && check.match.phone !== false) {
      if (check.flags.length) throw new Stop(`result #${n + 1} (${check.report.name}) may be the customer — TruthFinder has no age for them — and has records (${check.flags.join(', ')}): team review`);
      log(id, `Result #${n + 1}: TruthFinder has no age/DOB for this person, so it can't be confirmed — no records either, moving on`);
      continue;
    }
    log(id, `Result #${n + 1} is a different person`);
  }
  if (ambiguousClean && !broken) { log(id, 'All possible matches are clean'); return ambiguousClean; }
  // a result we couldn't open might have been the customer — don't clear on a guess
  if (broken) throw new Stop(`${broken} matching result(s) could not be opened on TruthFinder ("not found" page) and none of the others is a clear match — not deciding automatically`);
  throw new NoRecords(`No record found — the ${candidates.length} matching result(s) turned out to be someone else when opened`);
}

// Wait until the report has finished building (no "loading…" text and stopped changing)
async function waitForReport(page, id) {
  let prev = '';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    await assertNotBlocked(page, id);
    const text = await page.innerText('body').catch(() => '');
    const building = /generating|searching|loading|please wait|please be patient|charm cleric|compiling|building your report/i.test(text.slice(0, 3000));
    if (!building && text === prev) return;
    prev = text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshotPath(id, file) {
  if (!/^bk-[A-Za-z0-9-]{4,40}$/.test(id) || !/^[\w.-]+\.(png|html)$/.test(file)) return null;
  const p = path.join(SNAPS, id, file);
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  enabled, agentMode, enqueue, start, snapshotPath,
  // used by api/tf-agent.js (server) and agent/truthfinder-agent.js (client computer)
  update, log, applyResult, applyFail, errInfo, runBrowserCheck, closeBrowser, setIO, SNAPS, MAX_LOG
};
