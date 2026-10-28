// Step ③ — insurance verification by an AI phone agent (Vapi). Spec: handoff/automation-2.
//   POST { booking, insurer, other_phone?, policy_number, consent, session_id? | holder_name?+dob?+address?, zip?, phone?, dates }
//        → places ONE real outbound call to the insurer; returns { status: "calling" }
//   GET  ?booking=... → { status: calling | verified | declined | needs_review }
//        (while calling, reads the call from Vapi; once ended, applies the pass/fail rule)
// VAPI_TEST_NUMBER, when set, is dialled instead of the insurer — use it while testing so
// made-up policy numbers never reach a real insurer.
const { load, save, diditDecision, identityFromDecision } = require('./_store');

const VAPI = 'https://api.vapi.ai';
const BOOKING = /^bk-[A-Za-z0-9-]{4,40}$/;
const VEHICLE = '2024 Chevrolet Corvette C8 Stingray';

// From handoff/insurance-provider-directory.md — validate each number before launch.
const INSURERS = {
  'State Farm': '+18007828332', 'GEICO': '+18002077847', 'Progressive': '+18007764737',
  'Allstate': '+18007266033', 'Liberty Mutual': '+18002908711', 'Farmers Insurance': '+18883276335',
  'Nationwide': '+18776696877', 'USAA': '+18005318722', 'Travelers': '+18662180397',
  'Erie Insurance': '+18004580811'
};

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    reached_representative: { type: 'boolean', description: 'A human representative (or an automated line) actually answered the verification questions' },
    policy_active: { type: ['boolean', 'null'], description: 'true if the representative said the policy is active / in force / valid; false if they said it is not active, cancelled, lapsed, expired or not found; null if they never said' },
    covers_vehicle: { type: ['boolean', 'null'], description: `Answer to "does the policy cover a ${VEHICLE} rental?": true only for a clear yes; false only for a clear no; null if they were unsure, said it depends, couldn't confirm, or it was never answered` },
    name_matches: { type: ['boolean', 'null'], description: 'false only if the representative said the policyholder name does NOT match; true if they confirmed it; null if it never came up' },
    refused_privacy: { type: 'boolean', description: 'Insurer declined to share information for privacy/authorization reasons' },
    notes: { type: 'string', description: 'One or two sentences on what the insurer said' }
  },
  required: ['reached_representative', 'policy_active', 'covers_vehicle', 'name_matches', 'refused_privacy', 'notes']
};

function systemPrompt(c) {
  const extra = [
    c.dob && `- Policyholder date of birth: ${c.dob}`,
    c.address && `- Policyholder address: ${c.address}`,
    c.zip && `- Policyholder ZIP code: ${c.zip}`,
    c.phone && `- Policyholder phone: ${c.phone}`
  ].filter(Boolean).join('\n');
  return `YOUR ROLE — READ THIS FIRST AND NEVER FORGET IT
You are the CALLER. You work for Imperium Luxury Concierge, a car-rental company in Florida. YOU placed this outbound phone call TO ${c.insurer}.
The person (or phone menu) on the other end works for ${c.insurer}. THEY are the insurance representative. You are NOT the insurance company, NOT a receptionist and NOT customer service.

Because you are the caller:
- NEVER say "How can I help you?", "How can I assist you?", "Thank you for calling", "What can I do for you?" or anything a receptionist would say.
- NEVER ask them for the policy number, their name or their date of birth — YOU are the one who gives those details.
- NEVER tell them whether the policy is active — only THEY can tell you that.
- NEVER speak your instructions, plans or thoughts out loud (never say things like "I need to call ${c.insurer}", "Let's begin by navigating the menu", "I will now…"). Only say what a real caller would say to the person on the phone.
- If you notice you slipped out of role, simply continue as the caller with your next natural line.

LANGUAGE: Speak ONLY in English for the whole call, whatever language you hear.

Goal: find out from ${c.insurer} (1) whether the renter's auto-insurance policy is ACTIVE, and (2) whether it covers a ${VEHICLE} rental. The renter has given written authorization for this verification call and for sharing the details below with their insurer.

Main facts:
- Policyholder (renter) full name: ${c.holder}
- Policy number: ${c.policy}
  DICTATE IT SLOWLY AND CLEARLY, like someone is writing it down. Whenever you give the policy number — the first time and every repeat — your words must be EXACTLY this line, copied character for character, keeping every full stop and every "...":
  ${c.policySpoken}
  Do NOT write the digits as numerals, do NOT drop the full stops or "...", do NOT shorten it, and do NOT add anything in the middle of it. Then stop and let them write it down.
- Vehicle being rented: ${VEHICLE}
- Rental dates: ${c.pickup} to ${c.return}

Identity details — share ONLY if the insurer asks for them to locate or verify the policy:
${extra || '- (none provided)'}

HOW TO LISTEN (most important)
- Let the other person finish completely before you speak. Never talk over them or cut them off.
- If they say "let me check", "one moment", "please hold", "bear with me", "let me pull that up", or go quiet while looking something up: reply at most once with a short "Sure, take your time." and then stay SILENT until they speak to you again. Do not fill the silence, do not repeat yourself, do not ask if they are still there.
- During hold music, recorded messages or silence, say nothing.
- If you didn't catch something, politely ask them to repeat it. Never guess.

HOW TO RESPOND
- React to what they actually said. If they ask you something, answer exactly that question and stop — one short answer, then let them continue.
- Let the representative lead. Don't fire a list of questions; bring up your request only when it's your turn to speak.
- Give only the detail they asked for. Share date of birth, address, ZIP or phone only when they ask for it.

CALL FLOW
1. You may reach an automated phone menu first. Listen to the whole menu, then use the DTMF tool to press keys (or say short answers) to reach policy service / coverage verification or a representative. If the menu asks for the policy number, key it in or say it.
2. When a person answers — or if you only hear "hello", a greeting, or nothing clear at the start — your first words are your introduction, once: "Hi, this call may be recorded. I'm calling from Imperium Luxury Concierge on behalf of ${c.holder}, who has authorized us to verify their auto policy for a vehicle rental. Could you help me check whether their policy is active?"
3. Answer their questions (policy number, name, identity details) as they ask them.
4. When they're ready to help, your request is: "Could you confirm whether this policy is currently active?" If they've already told you, don't ask again.
5. When they tell you the policy status:
   - If it's NOT active / cancelled / lapsed / expired / not found: say "Understood, thank you so much for checking. Have a great day." and end the call with the endCall tool. Don't ask anything else.
   - If it IS active / in force / valid: say exactly "Perfect, and does the policy cover a ${VEHICLE} rental?" and then listen to their full answer.
6. When they answer the coverage question:
   - Clear YES: say "Wonderful, thank you so much for confirming. Have a great day." and end the call with the endCall tool.
   - Clear NO: say "Understood, thank you so much for checking. Have a great day." and end the call with the endCall tool.
   - If you didn't clearly hear a yes or a no (the answer was cut off, garbled, or doesn't make sense), do NOT end the call. Ask once: "Sorry, I didn't quite catch that — just to confirm, does the policy cover the rental?" and listen again.
   - Only if they clearly say they're unsure / "it depends" / "I can't confirm that" / they don't know: don't push; say "No problem, thank you so much for your help. Have a great day." and end the call with the endCall tool.
   - If they say "let me check", wait silently for the answer first.
   Always close with one of the lines above — never just "Goodbye".
7. If they say the policyholder name does not match, or they can't or won't help, thank them warmly, say "Have a great day.", and end the call.
Never say "Have a great day" until you are ending the call — saying it hangs up.

RULES
- Sound like a friendly, patient professional: short, natural sentences ("sure", "of course", "thank you so much"). No robotic phrasing.
- You don't need to announce that you are automated. But if anyone asks whether you are a person, a robot, an AI or an automated system, answer honestly that you're an AI assistant for Imperium, then carry on.
- Never claim to be the policyholder.
- Share only the details listed above. Never give or invent a Social Security number, driver's license number, bank details or anything not listed; if they require it, thank them and end the call.
- If they refuse for privacy reasons, thank them and end the call. Do not argue or retry.

EXAMPLE OF A GOOD CALL (you = Caller, them = ${c.insurer} rep)
Rep: "Thank you for calling ${c.insurer}, this is Sam, how can I help you?"
Caller: "Hi Sam, this call may be recorded. I'm calling from Imperium Luxury Concierge on behalf of ${c.holder}, who has authorized us to verify their auto policy for a vehicle rental. Could you help me check whether their policy is active?"
Rep: "Sure, what's the policy number?"
Caller: "It's ${c.policySpoken}."
Rep: "Okay, let me check."
Caller: "Sure, take your time."
Rep: (silence while checking) — Caller says nothing.
Rep: "Can I get the date of birth?"
Caller: "${c.dob || 'I don\'t have that on file, I\'m sorry.'}"
Rep: "Thanks. Yes, that policy is active."
Caller: "Perfect, and does the policy cover a ${VEHICLE} rental?"
Rep: "Yes, rentals are covered under this policy."
Caller: "Wonderful, thank you so much for confirming. Have a great day." (then end the call)

REMEMBER: you are always the CALLER from Imperium asking ${c.insurer} a question. Never act as the insurance company.`;
}

// "VA-101452154" → "V as in Victor. A as in Alpha. Dash. ... 1. 0. 1. ... 4. 5. 2. ..." — the full stops
// and "..." make the voice pause after each character and longer after every group of three
const NATO = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India',
  J: 'Juliet', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra',
  T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu' };
const DIGITS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
function spell(s) {
  // digits as words so the voice says each one separately instead of rattling off "101452154"
  const parts = String(s).toUpperCase().split('').filter((ch) => ch.trim()).map((ch) =>
    NATO[ch] ? `${ch} as in ${NATO[ch]}` : /\d/.test(ch) ? DIGITS[ch] : ch === '-' ? 'Dash' : ch);
  const groups = [];
  for (let i = 0; i < parts.length; i += 3) groups.push(parts.slice(i, i + 3).join('. ') + '.');
  return groups.join(' ... ');
}

function buildAssistant(ctx) {
  return {
    name: 'Imperium insurance verifier',
    firstMessageMode: 'assistant-waits-for-user', // insurers answer with an IVR menu
    maxDurationSeconds: 1800, // allow for long holds
    silenceTimeoutSeconds: 300, // don't hang up while the rep checks or during quiet hold
    // nova-3 + key terms: better at catching a rep's short "yes" / "active" / "covered" on a phone line
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en', keyterm: ['active', 'covered', 'coverage', 'policy', 'rental', ctx.insurer] },
    // Wait for the rep to really finish before replying; stop at once if they start talking
    startSpeakingPlan: { waitSeconds: 1.2, smartEndpointingPlan: { provider: 'livekit' } },
    // A rep's "okay" / "uh-huh" while writing the policy number down shouldn't cut the dictation off
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 1.5,
      acknowledgementPhrases: ['okay', 'ok', 'uh-huh', 'mhmm', 'got it', 'yeah', 'yes', 'go ahead', 'right'] },
    backgroundDenoisingEnabled: true,
    endCallPhrases: ['have a great day'], // safety net: hang up after the closing line even if the tool isn't called
    model: {
      provider: 'openai', model: 'gpt-4o', temperature: 0.3,
      messages: [{ role: 'system', content: systemPrompt(Object.assign({ policySpoken: spell(ctx.policy) }, ctx)) }],
      tools: [{ type: 'dtmf' }, { type: 'endCall' }]
    },
    voice: { provider: 'vapi', voiceId: 'Elliot', speed: 0.85 }, // slower overall (client feedback)
    artifactPlan: {
      recordingEnabled: true,
      structuredOutputs: [{ name: 'insurance_verification', description: 'Outcome of the insurance coverage verification call', schema: RESULT_SCHEMA }]
    },
    analysisPlan: { structuredDataPlan: { enabled: true, schema: RESULT_SCHEMA } }, // legacy fallback
    // Live progress for the customer's page: Vapi posts each turn to api/vapi-webhook (needs a public https APP_URL)
    ...(webhookUrl() && {
      server: { url: webhookUrl(), secret: process.env.VAPI_WEBHOOK_SECRET },
      serverMessages: ['status-update', 'conversation-update', 'end-of-call-report']
    })
  };
}
function webhookUrl() {
  const base = String(process.env.APP_URL || '').replace(/\/+$/, '');
  return process.env.VAPI_WEBHOOK_SECRET && /^https:\/\//.test(base) ? base + '/api/vapi-webhook' : '';
}

// Live call stage from the transcript so far, shown to the customer while the call runs:
//   menu → policy_given → reviewing ⇄ on_hold → confirmed
const HOLD = /\b(on hold|put you on (a )?(brief |quick )?hold|place you on (a )?(brief |quick )?hold|please hold|hold on|hold please|hold the line|hold for (a|one) (moment|second|minute))\b/i;
const REVIEW = /\b(let me (check|see|look|pull|verify|find|confirm)|one (moment|second|sec)|just a (moment|second|sec)|give me (a|one) (moment|second|sec|minute)|bear with me|got it|okay|ok|alright|all right|sure|looking (it|that|this) up|pulling (it|that|this) up|checking)\b/i;
const NOT_ACTIVE = /\b(not active|inactive|isn'?t active|not in force|cancel+ed|lapsed|expired|terminated|not found|can'?t find|cannot find|couldn'?t find|no (such )?policy)\b/i;
const ACTIVE = /\b(active|in force|valid)\b/i;
const ANSWER = /\b(yes|yeah|yep|no|nope|covered|covers|does cover|doesn'?t cover|does not cover|not covered|excluded|not sure|depends|can'?t (confirm|say)|cannot (confirm|say)|don'?t know|unable)\b/i;

//   menu → policy_given → reviewing ⇄ on_hold → active → coverage → confirmed
function deriveStage(messages, policy) {
  const digits = String(policy || '').replace(/\D/g, '');
  const tail = digits.slice(-4);
  let stage = 'menu', given = false, active = false, asked = false;
  for (const m of messages || []) {
    const text = String(m.message || m.content || '');
    if (!text) continue;
    const role = m.role === 'bot' || m.role === 'assistant' ? 'agent' : m.role === 'user' ? 'rep' : '';
    const question = /\?\s*$/.test(text);
    if (role === 'agent') {
      if (active && /\bcover/i.test(text)) { asked = true; stage = 'coverage'; }
      else if (!active && (/ as in /i.test(text) || (tail && text.replace(/\D/g, '').includes(tail)) ||
               (text.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi) || []).length >= 4)) { given = true; if (stage !== 'on_hold') stage = 'policy_given'; }
    } else if (role === 'rep') {
      if (asked && ANSWER.test(text) && !question) return 'confirmed';     // answered the coverage question
      if (given && !active && NOT_ACTIVE.test(text) && !question) return 'confirmed'; // not active — call ends
      if (given && !active && ACTIVE.test(text) && !question) { active = true; stage = 'active'; continue; }
      if (HOLD.test(text)) stage = 'on_hold';
      else if (given && REVIEW.test(text)) stage = asked ? 'coverage' : active ? 'active' : 'reviewing';
      else if (stage === 'on_hold') stage = asked ? 'coverage' : active ? 'active' : given ? 'reviewing' : 'menu'; // back on the line
    }
  }
  return stage;
}

// Apply an ended call (from polling or the end-of-call webhook) to a booking entry
function finish(entry, call) {
  const result = readResult(call);
  entry.status = decide(result);
  entry.stage = 'done';
  entry.result = result;
  entry.ended_reason = call.endedReason || '';
  entry.recording_url = (call.artifact && call.artifact.recordingUrl) || call.recordingUrl || '';
  entry.ended_at = new Date().toISOString();
}

async function vapi(p, opts) {
  const r = await fetch(VAPI + p, Object.assign({ headers: { Authorization: 'Bearer ' + process.env.VAPI_API_KEY, 'Content-Type': 'application/json' } }, opts || {}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('vapi_error'); e.detail = d; throw e; }
  return d;
}

// Pull our structured result from the ended call (structured outputs, falling back to legacy analysis)
function readResult(call) {
  const outs = (call.artifact && call.artifact.structuredOutputs) || {};
  for (const o of Object.values(outs)) {
    if (o && o.name === 'insurance_verification' && o.result && typeof o.result === 'object') return o.result;
  }
  return (call.analysis && call.analysis.structuredData) || null;
}

// Pass/fail (client rule): active AND a clear "yes" to covering the rental = verified.
// Not active, a clear "no" on coverage, or a name mismatch = declined. Anything unclear (unsure on
// coverage, refused, IVR dead-end, no answer) = needs_review for the team, never a silent pass.
function decide(res) {
  if (!res || !res.reached_representative) return 'needs_review';
  if (res.policy_active === false || res.covers_vehicle === false || res.name_matches === false) return 'declined';
  if (res.policy_active === true && res.covers_vehicle === true) return 'verified';
  return 'needs_review';
}

module.exports = async function handler(req, res) {
  try {
    if (!process.env.VAPI_API_KEY || !process.env.VAPI_PHONE_NUMBER_ID) {
      return res.status(503).json({ error: 'Insurance calls not configured (VAPI_API_KEY / VAPI_PHONE_NUMBER_ID)' });
    }
    const all = load('insurance');

    if (req.method === 'GET') {
      const bk = req.query && req.query.booking;
      const entry = BOOKING.test(bk || '') && all[bk];
      if (!entry) return res.status(404).json({ error: 'not found' });
      if (entry.status === 'calling') {
        const call = await vapi('/call/' + encodeURIComponent(entry.call_id));
        if (call.status === 'ended') {
          finish(entry, call);
          save(all, 'insurance');
        } else if (!entry.stage_from_webhook) {
          // No webhook (e.g. running locally): best-effort stage from whatever the call object carries
          const msgs = (call.artifact && call.artifact.messages) || call.messages;
          entry.stage = msgs && msgs.length ? deriveStage(msgs, entry.policy_number) : call.status === 'in-progress' ? 'menu' : 'dialing';
        }
      }
      // the customer sees only the status + stage, never the notes/transcript
      return res.status(200).json({ status: entry.status, stage: entry.stage || 'dialing' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    const b = req.body || {};
    if (!BOOKING.test(b.booking || '')) return res.status(400).json({ error: 'invalid booking id' });
    if (b.consent !== true) return res.status(400).json({ error: 'authorization required' });
    if (all[b.booking]) return res.status(200).json({ status: all[b.booking].status }); // one call per booking

    const policy = String(b.policy_number || '').trim().slice(0, 40);
    if (!/^[A-Za-z0-9 -]{4,40}$/.test(policy)) return res.status(400).json({ error: 'invalid policy number' });

    let insurerPhone = INSURERS[b.insurer];
    let insurer = b.insurer;
    if (b.insurer === 'Other') {
      insurerPhone = String(b.other_phone || '').replace(/[^\d+]/g, '');
      if (/^\d{10}$/.test(insurerPhone)) insurerPhone = '+1' + insurerPhone;
      if (!/^\+1\d{10}$/.test(insurerPhone)) return res.status(400).json({ error: 'enter the US phone number from your insurance card' });
      insurer = String(b.other_name || 'the insurer').trim().slice(0, 60) || 'the insurer';
    }
    if (!insurerPhone) return res.status(400).json({ error: 'select your insurance provider' });

    // Policyholder name must be the verified ID name (not re-typed) — test mode allows typing it
    // Identity details the agent may give the insurer if asked (DOB/address come from the ID when verified)
    const clean = (v, n) => String(v || '').trim().slice(0, n);
    let holder, dob, address;
    if (b.session_id) {
      const d = await diditDecision(b.session_id);
      if (d.status !== 'Approved') return res.status(409).json({ error: 'ID not approved' });
      const id = identityFromDecision(d);
      holder = id.full_name; dob = id.date_of_birth; address = id.address;
    } else {
      if (process.env.ALLOW_ID_SKIP !== 'true') return res.status(400).json({ error: 'ID verification required' });
      holder = clean(b.holder_name, 100); dob = clean(b.dob, 10); address = clean(b.address, 200);
    }
    if (!holder) return res.status(400).json({ error: 'policyholder name required' });

    const dates = b.dates || {};
    const ctx = { insurer, holder, policy, dob, address, zip: clean(b.zip, 10), phone: clean(b.phone, 20),
                  pickup: String(dates.pickup || 'the pickup date'), return: String(dates.return || 'the return date') };
    // TEST ONLY: number typed on the form (test mode), else VAPI_TEST_NUMBER, else the real insurer
    const usNumber = (v) => { let n = String(v || '').replace(/[^\d+]/g, ''); if (/^\d{10}$/.test(n)) n = '+1' + n; if (/^1\d{10}$/.test(n)) n = '+' + n; return n; };
    let formTest = '';
    if (b.test_number) {
      if (process.env.ALLOW_ID_SKIP !== 'true') return res.status(400).json({ error: 'test number not allowed' });
      formTest = usNumber(b.test_number);
      if (!/^\+1\d{10}$/.test(formTest)) return res.status(400).json({ error: 'test number must be a US number, e.g. +1 555 010 0100' });
    }
    const testNumber = formTest || usNumber(process.env.VAPI_TEST_NUMBER); // "+1 (555) 010 0100" → "+15550100100"
    const dialled = testNumber || insurerPhone;

    const call = await vapi('/call', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Insurance ' + b.booking,
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: { number: dialled },
        assistant: buildAssistant(ctx)
      })
    });

    all[b.booking] = {
      booking_id: b.booking, call_id: call.id, status: 'calling', stage: 'dialing',
      insurer, insurer_phone: insurerPhone, dialled, test_call: dialled !== insurerPhone,
      policy_number: policy, holder_name: holder, name_source: b.session_id ? 'didit' : 'typed (test)',
      consent_at: new Date().toISOString(),
      consent_ip: String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || ''),
      started_at: new Date().toISOString()
    };
    save(all, 'insurance');
    return res.status(200).json({ status: 'calling' });
  } catch (e) {
    const upstream = e.message === 'vapi_error' || e.message === 'didit_error';
    const msg = upstream && e.detail && (e.detail.message || e.detail.detail);
    return res.status(upstream ? 502 : 500).json({ error: msg ? String(msg) : e.message, detail: e.detail });
  }
};

module.exports.buildAssistant = buildAssistant; // reused to create a dashboard test assistant
module.exports.deriveStage = deriveStage;       // used by api/vapi-webhook.js
module.exports.finish = finish;
module.exports.readResult = readResult;
