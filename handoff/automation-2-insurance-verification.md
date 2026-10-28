# Automation B — Insurance Verification (AI voice agent)

**Goal:** confirm the renter's auto-insurance policy (1) is active and covers the rented vehicle, and
(2) is in the renter's name — before the car is released.

**Trigger:** only fires once Automation A is `bg_clear` (clean, or manually approved).
**Output:** `{ status: "verified" | "declined", covers_vehicle, name_matches, notes, call_id, transcript_url }`.

## Exact inputs — what the agent must have to get the right answer

| Field the agent gives the insurer | Source | Must match |
|---|---|---|
| **Policyholder full name** | the renter's **verified** name from the Didit ID | must equal the name on the policy (that's question 2) |
| **Policy number** | collected from the renter at booking (form field) | the renter's own auto policy |
| **Insurer** | renter selects from the list (`insurance-provider-directory.md`) | determines which number to dial |
| **Vehicle being rented** | fixed: `2024 Chevrolet Corvette C8 Stingray` (exotic / non-owned) | the agent must confirm coverage for **this** vehicle/class |
| **Rental dates** | from the booking | policy must be active for these dates |

The renter's **name and DOB used to verify identity come from the Didit ID** (already verified in step ①)
— reuse them; don't re-ask. The **policy number + insurer** are the only new fields you collect at
booking (add them to the form). If the renter also uploads their insurance card/dec page (recommended
document step), OCR must confirm the **policyholder name matches the verified ID name**.

## What the developer needs to do (checklist)
- [ ] Add **policy number** + **insurer** fields (and optional insurance-card upload) to the booking form.
- [ ] Add the renter's **authorization** to contact their insurer (checkbox + text; store timestamp).
- [ ] Pick a voice platform (Bland.ai / Vapi / Retell), get the API key + a caller number.
- [ ] Build `api/verify-insurance.js` (place the call with the exact inputs) and
      `api/verify-insurance-callback.js` (receive the structured result).
- [ ] Implement the pass/fail + `needs_review` logic and the decline email.
- [ ] (Recommended) build the document-first OCR check before the call.

---

## Insurer phone numbers (the agent's dial map)

Build the insurer dropdown on the booking form from this list; the renter's selection maps to the number
the agent dials. Always also allow **"Other"** + the number printed on the renter's insurance card.

| Company | Phone number |
| --- | ---: |
| State Farm | 800-782-8332 |
| GEICO | 800-207-7847 |
| Progressive | 800-776-4737 |
| Allstate | 800-726-6033 |
| Liberty Mutual | 800-290-8711 |
| Farmers Insurance | 888-327-6335 |
| Nationwide | 877-669-6877 |
| USAA | 800-531-8722 |
| Travelers | 866-218-0397 |
| Erie Insurance | 800-458-0811 |

```json
{
  "State Farm":        "+18007828332",
  "GEICO":             "+18002077847",
  "Progressive":       "+18007764737",
  "Allstate":          "+18007266033",
  "Liberty Mutual":    "+18002908711",
  "Farmers Insurance": "+18883276335",
  "Nationwide":        "+18776696877",
  "USAA":              "+18005318722",
  "Travelers":         "+18662180397",
  "Erie Insurance":    "+18004580811"
}
```

After dialing, the agent navigates the IVR to policy service / verification (or asks the rep). See
`insurance-provider-directory.md` for notes on agent-based insurers and IVR caveats.

## ⚠️ Read first: what an insurer will and won't tell an AI caller

Insurers are bound by **GLBA privacy** — they will **not** disclose policy details to a random third
party. A cold AI call ("does policy X cover car Y for person Z?") will usually be refused, or worse,
sound like a social-engineering attempt. Build it so it's legitimate:

- **Get the renter's written authorization** at booking to contact their insurer and verify coverage on
  their behalf (checkbox + timestamp; store it). This is what makes the call legal and answerable.
- **Florida is a two-party consent state.** If the call is recorded, the agent must disclose the
  recording at the start of the call.
- Identify truthfully: "I'm calling on behalf of {renter}, who has authorized a coverage verification
  for a vehicle rental." Never impersonate the policyholder.

Because of the above, the **recommended primary method is document-based**, with the phone call as
confirmation/escalation:

### Recommended: document-first, phone-confirm
1. **Primary — document check.** Renter uploads their **insurance card or declaration (dec) page**. An
   OCR/LLM-vision step extracts: policyholder name, policy number, insurer, covered vehicles (VIN /
   year-make-model), coverage limits, effective + expiration dates. Verify:
   - `name_matches` = policyholder name ≈ renter's verified name (from Didit).
   - `covers_vehicle` = the rented vehicle (or "any vehicle you drive" / non-owned coverage) is covered
     and the policy is in effect for the rental dates.
   Most renters pass here in seconds, no call needed.
2. **Confirmation / fallback — AI voice call.** When the document is missing, ambiguous, or high-value
   confirmation is wanted, place the AI call (below).

Bart specifically asked for the phone agent, so it's fully specified below — just pair it with the
authorization + (ideally) the document step.

---

## The AI voice agent

### Platform options (pick one)
| Platform | Notes |
|---|---|
| **Bland.ai** | Purpose-built for automated outbound phone agents; pathways/IVR navigation, recording, webhooks. Good default. |
| **Vapi** | Developer-friendly, bring-your-own LLM/voice, good call-control + function calling. |
| **Retell AI** | Low-latency conversational voice; solid IVR handling. |

All three: give it a system prompt + the booking data, it dials, navigates the IVR, talks to a rep,
captures a structured result, and posts a webhook back to `api/verify-insurance-callback.js`.

### Call flow / script (the agent's job)
```
1. Dial the insurer's line (see insurance-provider-directory.md).
2. Navigate IVR → "policy service / verification" (or ask the rep).
3. Disclosure: "This call may be recorded. I'm an authorized representative calling on behalf of
   {renter_full_name} to verify their auto policy for a vehicle rental."
4. Provide: policy number {policy_number}, policyholder name {renter_full_name}.
5. Ask exactly two questions:
      Q1. "Is policy {policy_number} active and does the coverage extend to {renter} driving a
           {vehicle} (a rented/non-owned exotic vehicle) on {pickup_date}–{return_date}?"
      Q2. "Is the named policyholder on this policy {renter_full_name}?"
6. Capture structured result and end politely.
```

### Pass / fail logic
```
verified   = policy_active AND covers_vehicle AND name_matches
declined   = any of the above is false, OR the insurer cannot confirm
             (do NOT auto-approve on "couldn't confirm" — treat as declined / manual review)
```
- `verified` → booking.status = "insurance_verified", advance to payment (④).
- `declined` → booking.status = "declined_insurance", charged=false, send "not accepted" email, STOP.
- Optional middle state `needs_review` → route to a human if the rep was unclear (recommended for a
  premium exotic rental rather than a hard auto-decline on ambiguity).

### Structured output the agent returns (webhook → `api/verify-insurance-callback.js`)
```jsonc
{
  "booking_id": "bk_...",
  "policy_active": true,
  "covers_vehicle": true,
  "name_matches": true,
  "insurer_rep_notes": "Confirmed active, non-owned coverage applies, policyholder name matches.",
  "call_id": "call_...",
  "recording_url": "https://.../rec.mp3",
  "transcript_url": "https://.../transcript.txt",
  "status": "verified"
}
```

### Guardrails / edge cases
- **Rep refuses (privacy):** fall back to the document method or a 3-way call with the renter present.
  Log as `needs_review`, not a silent pass.
- **Long hold / IVR dead-end:** set a max call duration; retry once; else `needs_review`.
- **Rented exotic + "non-owned" coverage:** many personal policies exclude high-value/exotic or
  business use. The agent must specifically confirm the *rented* vehicle class is covered — this is the
  whole point.
- **Store the recording + transcript** (with consent) for the audit trail.
- Rate-limit and cache: never call the same insurer/policy twice for one booking.

## Environment
`VOICE_AGENT_API_KEY`, `VOICE_AGENT_WEBHOOK_SECRET`, plus (recommended) an OCR/vision key for the
document step. See `.env`.
