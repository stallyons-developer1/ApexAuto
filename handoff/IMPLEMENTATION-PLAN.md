# Implementation Plan — Imperium Rental Verification

_Last updated: 2026-09-24_

## 0. The pipeline (how it all fits together)

```
   Customer books (dates + pickup/drop-off)
              │
              ▼
   ① ID VERIFICATION  ── Didit ─────────────────────────►  DONE ✅   (real gate)
              │  Approved?
              ▼  yes
   ② BACKGROUND CHECK ── Automation A (compliant CRA) ───►  TO BUILD 🔨   (real gate)
              │
              ├─ clean ──────────────────────────────► continue
              └─ flagged ─► STANDBY: manual review queue ─► team APPROVES or DECLINES
              ▼  (clean, or manually approved)
   ③ INSURANCE VERIFICATION ── Automation B ─────────────►  TO BUILD 🔨   (real gate)
              │  covers car + in renter's name?
              ▼  verified
   ④ PAYMENT  ── WooCommerce order + iPOSpays ───────────►  DONE ✅ (fee/credit optional, below)
              ▼
   Car released to the verified driver only.
```

**Real gates: ① ID, ② background, ③ insurance.** At each gate a fail stops the pipeline, does not charge,
and sends a "not accepted" email. **Background never auto-rejects:** a flagged report moves the booking
to **standby (manual review)** where a team member approves or declines — a clean report passes through
automatically.

---

## 1. What's already built ✅

The verification app is live on Vercel and these pieces work end-to-end:

| Component | File | Status |
|---|---|---|
| Booking front-end (dates, pickup/drop-off, verification UI) | `apex-rental/index.html` | Live |
| ① Create ID session (Didit) | `apex-rental/api/didit-session.js` | Live, tested |
| ① Read ID result (Didit) | `apex-rental/api/didit-status.js` | Live, tested |
| ④ Create WooCommerce order → iPOSpays pay URL | `apex-rental/api/create-order.js` | Live, tested |
| Return-from-Didit resume logic | `index.html` (boot) | Fixed & live |
| Env vars | see `.env` | To fill in |

**ID verification is real.** A live test returned `Approved` (ID + face match + liveness). The data that
comes back from Didit is the input to Automation A — see `data-contract.md`.

Currently **Automation A (background) and B (insurance) are simulated** in the front-end (they auto-pass
and are labelled "Test build"). This handoff replaces those stubs with the real agents.

---

## 2. What's left to build 🔨

### A. Background check + standby / manual review  → `automation-1-background-check.md` + `review-queue-crm.md`
- Trigger: fires after Didit status = `Approved` (and renter consent captured).
- Source: an **FCRA-compliant CRA** (Certn recommended) — required because this check can stop/decline a
  rental. Criminal + Motor Vehicle Record. ~$10–20/check.
- Action & decision:
  - **clean** → advance automatically to insurance.
  - **flagged** (theft, grand theft auto, DUI/DWI, reckless driving, drug possession, felony, suspended/
    invalid license, or anything risking the car being stolen/impounded) → booking goes to **standby
    (`manual_review`)**; customer info + flags land in the **review queue / CRM**; a team member
    **approves** (advance) or **declines** (adverse-action + "not accepted" email).
- **Never auto-rejects** — a human always makes the final call on a flag.
- Optional: an Instant Checkmate "extra info" panel may be shown to the reviewer for context only —
  never the recorded basis for a decline.
- Output: `booking.background = { status, provider, report_id, flags[] }` + review-queue entry when flagged.

### B. Insurance verification (AI voice agent)  → `automation-2-insurance-verification.md`
- Trigger: fires only if Automation A = `clear`.
- Input: insurer, policy number, renter's full name, the vehicle (2024 Corvette C8 Stingray).
- Action: AI voice agent calls the insurer and confirms (1) policy active + covers this vehicle,
  (2) policy is in the renter's name.
- Output: `{ status: "verified" | "declined", details: {...} }` → if verified, advance to payment.

### Supporting work (smaller, still required)
1. **Orchestration** — chain ①→②→③→④ server-side with the "any fail = stop, no charge" rule. Today the
   front-end drives it; move the gating server-side so it can't be skipped (see §4).
2. **Decline email** — send the "rental not accepted" email on any failure (SendGrid/Postmark/Resend).
3. **$15 driving-record fee + −$15 credit** (business decision already made): charge a $15
   non-refundable fee before running the paid background check; if the renter passes and books, credit
   $15 off the rental total. Runs through the existing iPOSpays/WooCommerce setup. _Optional to build
   now, but the model is decided._
4. **Persistence** — store each booking's state + check results (Supabase recommended) so results
   survive redirects and are auditable (required for FCRA adverse-action records).
5. **Webhooks over polling** — Didit can POST results (HMAC-signed) instead of the app polling; more
   robust. Optional but recommended.

---

## 3. Accounts / services the developer needs

| Purpose | Service | Notes |
|---|---|---|
| ID verification | **Didit** | Already integrated. Keys in Vercel. |
| Background check | **Certn** (recommended, compliant CRA) | Criminal + MVR via API. ~$10–20/check. Powers the flag → standby → manual review. See Automation A. |
| Review queue / CRM | **Internal dashboard** (Supabase) ± external CRM | Where flagged bookings land for manual approve/decline. See `review-queue-crm.md`. |
| Insurance voice agent | **Bland.ai / Vapi / Retell AI** (pick one) | AI phone agent platform. See Automation B. |
| Insurance doc OCR (recommended companion) | Any OCR/LLM vision | Read the renter's insurance card/dec page as the primary check; phone call confirms. |
| Store | **WooCommerce** on imperiumway.com | Product 381. REST keys in Vercel. |
| Payments | **iPOSpays** WooCommerce plugin | Already installed. |
| App hosting | **Vercel** (`apex-rental`) | Serverless functions in `api/`. |
| Database | **Supabase** (recommended) | Booking + audit state. |
| Transactional email | SendGrid / Postmark / Resend | Decline + confirmation emails. |

---

## 4. Orchestration (make the gate un-skippable)

Today the browser calls each `api/*` endpoint in turn. For a real gate, the server should own the
sequence and each step should verify the previous step actually passed (don't trust the client). A
booking record (Supabase) tracks the state machine:

```
booking.status:  pending_id → id_approved → bg_clear → insurance_verified → paid
                     │             │            ▲  │          │
                   (Didit)   (Automation A)     │  │      (Automation B)   (iPOSpays)
                                   │            │  └─ clean → bg_clear
                                   └─ flagged → manual_review ─► approve → bg_clear
                                                              └► decline → declined_background
   any real-gate fail → declined_id | declined_background | declined_insurance
                        (charged=false, email_sent=true)
```
`create-order.js` must refuse unless `status === insurance_verified`.

- Each `api` endpoint reads the booking, checks the prior status is correct, does its work, writes the
  new status. `create-order.js` must refuse unless `status === insurance_verified`.
- This prevents a customer (or a bug) from jumping straight to payment.

---

## 5. Compliance & legal (must-do before real customers)

| Area | What it governs | What to do |
|---|---|---|
| **FCRA** | Any background report used to decide on someone | Automation A uses an **FCRA-compliant CRA** (Certn). Capture written consent before the check; on a decline (after manual review), send the **adverse-action** notice (CRA name/contact + copy of report + rights + dispute window). Keep records of report, flags, reviewer, decision, notice. |
| **DPPA** | Pulling driving records (MVR) | Requires the driver's consent + permissible purpose; the CRA handles the credentialing. |
| **GLBA privacy** | Insurers releasing policy info | Insurers won't disclose policy details to a third party without the policyholder's authorization. Get the renter's written consent; consider document upload + a 3-way/renter-present call. See Automation B. |
| **TCPA + call recording** | Automated calls / recording | Florida is a **two-party consent** state — the AI agent must disclose the call is recorded. Get the renter's consent to place the verification call on their behalf. |

**Action for Bart:** have Imperium's attorney approve (a) the exact auto-decline list, (b) the consent
language shown at booking, and (c) the adverse-action email. Drafts of all three can be prepared for the
lawyer to review.

---

## 6. Suggested build order (milestones)

1. **M1 — Persistence + orchestration.** Add Supabase booking records and move gating server-side (§4).
2. **M2 — Automation A + review queue.** Compliant background check (Certn), flag logic, the standby
   `manual_review` state, the internal review dashboard (approve/decline + adverse-action), and the
   decline email. Replace the front-end stub. _Unblocks the biggest risk._
3. **M3 — Consent + fee.** Add the consent checkbox/language and the $15 fee + −$15 credit.
4. **M4 — Automation B (insurance).** Document-upload check first, then the AI voice-call confirmation.
5. **M5 — Hardening.** Didit webhook + HMAC, retries, monitoring, audit export for FCRA.
6. **M6 — Legal sign-off + go-live.** Attorney approves criteria/consent/adverse-action; rotate keys;
   put on a real domain (e.g. book.imperiumway.com).

---

## 7. Open decisions for Bart

- **Background source:** decided — **compliant CRA (Certn recommended)** running the check, with a
  **flag → standby → manual approve/decline** workflow and a **review queue/CRM**. Instant Checkmate may
  appear only as optional reviewer context, never the recorded basis. Confirm Certn vs. another CRA.
- **Insurance method:** document-upload-first + phone confirmation (recommended) vs phone-only.
- **Voice platform:** Bland.ai vs Vapi vs Retell (Automation B lists tradeoffs).
- **Fee:** confirm the $15 non-refundable / credit-on-pass model goes live with M3.

---

## 8. Security handoff notes

- Regenerate the WooCommerce REST keys and rotate the Didit key before go-live (they were shared during
  development).
- All secrets live in Vercel env vars — never in the repo. See `.env`.
- `.vercelignore` already blocks helper/secret files from being deployed to the public site.
