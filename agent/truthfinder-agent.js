// TruthFinder agent — runs on the client's own computer, in a normal Chrome window.
// It asks the booking app (Railway) for step-2 checks, runs the TruthFinder flow (api/_truthfinder.js),
// and sends the log, screenshots and report text back. The app decides clear / review — not this agent.
// The TruthFinder login stays on this computer (agent/.env); the app never sees it.
//
// Start: double-click START-AGENT.bat (Windows), or:  cd agent && npm install && node truthfinder-agent.js
const fs = require('fs');
const path = require('path');

// ---- config: agent/.env -------------------------------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const APP = String(process.env.APP_URL || '').replace(/\/+$/, '');
const KEY = process.env.TF_AGENT_KEY;
for (const [k, v] of Object.entries({ APP_URL: APP, TF_AGENT_KEY: KEY, TF_EMAIL: process.env.TF_EMAIL, TF_PASSWORD: process.env.TF_PASSWORD })) {
  if (!v) { console.error(`Missing ${k} in agent/.env — copy .env.example to .env and fill it in.`); process.exit(1); }
}
// a normal, visible Chrome window by default
if (!process.env.TF_HEADLESS) process.env.TF_HEADLESS = 'false';
if (!process.env.TF_BROWSER_CHANNEL) process.env.TF_BROWSER_CHANNEL = 'chrome';
process.env.TF_PROFILE_DIR = process.env.TF_PROFILE_DIR || path.join(__dirname, 'chrome-profile');
const POLL_MS = Number(process.env.POLL_SECONDS || 10) * 1000;
const GAP_MS = Number(process.env.TF_MIN_GAP_SECONDS || 45) * 1000;

// playwright is installed in agent/node_modules; the shared code lives in ../api
module.paths.unshift(path.join(__dirname, 'node_modules'));
require('module').Module._initPaths();
process.env.NODE_PATH = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();
const tf = require('../api/_truthfinder');

// ---- talking to the app ----------------------------------------------------------------------------------
async function call(method, query, body) {
  const r = await fetch(`${APP}/api/tf-agent${query || ''}`, {
    method, headers: { 'x-agent-key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${d.error || ''}`.trim());
  return d;
}
// everything for one booking goes out in order through one chain
let chain = Promise.resolve();
const send = (body) => (chain = chain.then(() => call('POST', '', body)).catch((e) => console.error('  ! could not send to the app:', e.message)));
const remoteIO = {
  appendLog(id, line) {
    console.log(`  ${new Date(line.t).toLocaleTimeString()}  ${line.level === 'info' ? '' : line.level.toUpperCase() + '  '}${line.m}`);
    send({ action: 'log', booking: id, lines: [line] });
  },
  patchTf(id, obj) { send({ action: 'patch', booking: id, tf: obj }); },
  saveSnapshot(id, base, png, html) {
    const dir = path.join(__dirname, 'snapshots', id); // a local copy too
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, base + '.png'), png);
    fs.writeFileSync(path.join(dir, base + '.html'), html);
    return send({ action: 'snapshot', booking: id, name: base, png: png.toString('base64'), html });
  }
};
tf.setIO(remoteIO);

// ---- loop -------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0, stopping = false, lastErr = '';

async function main() {
  console.log(`TruthFinder agent — app: ${APP}`);
  console.log(`Checking for work every ${POLL_MS / 1000}s. Keep this window open. Ctrl+C to stop.\n`);
  while (!stopping) {
    let job = null;
    try {
      ({ job } = await call('GET', '?action=next'));
      if (lastErr) { console.log('Connected to the app again.'); lastErr = ''; }
    } catch (e) {
      if (e.message !== lastErr) console.error(`Could not reach the app: ${e.message}`);
      lastErr = e.message;
    }
    if (!job) { await sleep(POLL_MS); continue; }

    const id = job.booking_id;
    console.log(`\n=== ${new Date().toLocaleTimeString()}  Booking ${id}`);
    const wait = GAP_MS - (Date.now() - lastSearch);
    if (wait > 0) { tf.log(id, `Waiting ${Math.ceil(wait / 1000)}s before the next search (normal activity limit)`); await sleep(wait); }
    try {
      const text = await tf.runBrowserCheck(id, job.identity);
      await chain;
      const r = await call('POST', '', { action: 'result', booking: id, text });
      console.log(`  → ${r.clear ? 'CLEAR' : r.reject ? 'REJECTED — ' + r.reason : 'sent to team review — ' + r.reason}`);
    } catch (err) {
      const x = tf.errInfo(err);
      await chain;
      await call('POST', '', { action: 'fail', booking: id, message: x.msg, stopped: x.stopped, stack: x.stack, noRecords: x.noRecords }).catch((e) => console.error('  ! could not report the failure:', e.message));
      console.log(`  → ${x.noRecords ? 'no records found' : x.stopped ? 'stopped' : 'error'}: ${x.msg}`);
    }
    lastSearch = Date.now();
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  await tf.closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Setup mode (VERIFY-DEVICE.bat): open the agent's own Chrome profile on TruthFinder and leave it to a person —
// sign in and complete TruthFinder's one-time "verify this new device" email, so later runs are recognised.
async function setup() {
  const { chromium } = require('playwright');
  const opts = { headless: false, viewport: null, args: ['--start-maximized'] };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(process.env.TF_PROFILE_DIR, Object.assign({ channel: process.env.TF_BROWSER_CHANNEL || 'chrome' }, opts)); }
  catch (e) { ctx = await chromium.launchPersistentContext(process.env.TF_PROFILE_DIR, opts); }
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(process.env.TF_DASHBOARD_URL || 'https://app.truthfinder.com/dashboard');
  console.log('A Chrome window is open with the agent\'s profile.');
  console.log('1. Log in to TruthFinder if asked.');
  console.log('2. If it says "Please Verify This New Device Login": click "Send Verification Email",');
  console.log('   open the email, copy the link and paste it into THIS Chrome window.');
  console.log('3. When you see the TruthFinder dashboard, close the Chrome window. Then start the agent normally.');
  await new Promise((r) => ctx.on('close', r));
  console.log('Chrome closed — setup done.');
  process.exit(0);
}

(process.argv.includes('--setup') ? setup() : main()).catch(async (e) => { console.error(e); await tf.closeBrowser(); process.exit(1); });
