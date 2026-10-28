# Automation A — Background Check (Certn) + Standby / Manual Review

**Goal:** after ID is verified, run a background check on the verified identity. If it's clean, advance
automatically. If it flags a serious record, **stop the automatic flow and send the booking to a manual
review queue** where a team member approves or declines. Nothing auto-rejects a person.

**Trigger:** Didit `status === "Approved"`.
**Input:** verified identity from `data-contract.md` (name, DOB, license #, issuing state, address).
**Output:** `{ status: "clear" | "needs_review" | "declined", flags: string[], report_id }` — a real gate.

---

## Exact inputs — MUST be identical to the verified ID

The check is only valid if it runs on the **right person**. Do **not** re-ask the customer to type these
(typos = wrong-person matches). Pull them **straight from the Didit ID result** and pass them through
unchanged into the background provider (and into the ICM search box, if the reviewer uses that panel):

| Field to enter | Where it comes from (Didit) | Why it matters |
|---|---|---|
| **First name** | `id_verifications[0].first_name` | Exactly as printed on the license |
| **Last name** | `id_verifications[0].last_name` | Include suffix (Jr/Sr/III) if present |
| **Date of birth** | `id_verifications[0].date_of_birth` (`YYYY-MM-DD`) | The strongest way to confirm it's the same person |
| **State** | `id_verifications[0].issuing_state` (e.g. `FL`) | Narrows to the right person + the right MVR |
| Driver's license # + state | `document_number` + `issuing_state` | Needed for the MVR pull |
| Address | `id_verifications[0].address` | Extra disambiguation for common names |

**Rule:** first name + last name + DOB + state must match the ID **exactly**. If the provider (or ICM)
returns more than one possible person, do **not** guess — mark it `needs_review` and let a human confirm
identity before any decision.

## What the developer needs to do (checklist)
- [ ] Create the CRA business account (Certn), complete credentialing, get the **API key** (use the
      test/sandbox key while building).
- [ ] Add the **consent** checkbox + disclosure at booking; store consent timestamp + IP.
- [ ] Build `api/run-background.js`: read the booking (assert `id_approved`), submit the **exact inputs**
      above, poll/webhook until complete, apply the **flag criteria**, write `booking.background`, set
      status (`bg_clear` / `manual_review` / `declined_background`).
- [ ] Build the flag → `manual_review` → **review queue** path (see `review-queue-crm.md`).
- [ ] Wire the **adverse-action** notice + customer "not accepted" email on a decline.
- [ ] Replace the front-end background stub (continue silently if clean; show "under review" if flagged).

---

## Source: a compliant provider (Certn recommended)

Because this check can **stop or decline a rental**, the source must be an **FCRA-compliant Consumer
Reporting Agency** — not a people-search site. (A human reviewer looking at a people-search report and
declining is still the prohibited use; the compliant source is what makes a decline defensible.)

- **Recommended: Certn** — FCRA-compliant API, criminal + Motor Vehicle Record (MVR), faster onboarding
  than most. Alternatives: Checkr, Victig, TazWorks.
- **Cost:** MVR-only ~$10–15; MVR + national criminal ~$10–20 per check.
- **Consent:** the renter must agree to a disclosure + authorization at booking (checkbox + saved
  timestamp/IP) before the check runs. (Draft available for the attorney.)
- Put the provider key in env (`BGCHECK_API_KEY`) — start with the provider's test/sandbox key.

> **Instant Checkmate** may still be shown to the reviewer as *optional extra context* in the review
> queue, but it is **never** the recorded basis for a decline and never runs the flag logic. The flag,
> the standby, and any decline are driven by the compliant report only. (See "Optional ICM panel.")

---

## Flow

```
1. On booking.status = "id_approved", confirm consent was captured, then order the check
   from the compliant provider (candidate = the Didit identity).
2. Poll / webhook until the report is complete.
3. Evaluate against the FLAG CRITERIA below:
     - No flags        → booking.status = "bg_clear"        → start Automation B (insurance).
     - One+ flags      → booking.status = "manual_review"   → push to the REVIEW QUEUE (see
                          review-queue-crm.md), notify the team. PIPELINE PAUSES here.
4. A team member reviews and acts:
     - Approve → booking.status = "bg_clear" → start Automation B.
     - Decline → booking.status = "declined_background", charged=false,
                 send the FCRA adverse-action notice, STOP.
```

**Key point:** a flag never auto-declines. It moves the booking to **standby (`manual_review`)** and a
human decides. Clean checks pass through automatically.

## Flag criteria (Bart's list — attorney to approve wording)

Send the booking to manual review if the report shows any of:
- Theft / larceny
- Grand theft auto (motor-vehicle theft)
- DUI / DWI
- Reckless driving
- Drug possession
- Felony
- Suspended / revoked / expired driver's license
- Anything that puts the vehicle at risk of being **stolen or seized/impounded** (e.g. outstanding
  warrants, prior auto-theft, certain drug-trafficking involving vehicles)

Record the specific matched item(s) in `flags[]` for the reviewer and the audit trail. Everything else
→ `clear`.

## Consent + adverse action (required when a decline can happen)
- **Before** the check: renter agrees to a clear disclosure + authorization.
- **On decline:** FCRA adverse-action — notify the applicant, give them the CRA's name/contact + a copy
  of the report + a summary of their rights, allow dispute. Certn/Checkr provide adverse-action tooling.
- Keep records of the report, the flags, who reviewed, the decision, and the notice sent.

## Where flagged renters go → the review queue / CRM
Flagged bookings (and their customer info) are sent to a review destination so the team can check them
later and approve/decline. See **`review-queue-crm.md`** — recommended is a lightweight internal
dashboard in this app ("our own system"), with an option to also push to an external CRM.

## Optional ICM panel (extra context only)
If Bart wants it, the review screen can show an "extra info" link that runs an Instant Checkmate lookup
for the reviewer's awareness. Rules: it's clearly labelled non-decisioning, it never sets the flag or
the status, and the decline reason recorded is always the **compliant** report — never ICM. If this adds
confusion or risk, skip it; the compliant report already covers the decision.

## What replaces the front-end stub
Today `index.html` shows a simulated "background check" that auto-passes. Replace it so that after ID:
- clean → silently continue to insurance;
- flagged → show the customer a neutral "Your booking is under review — we'll email you shortly" state
  (never show them the report or the reason), while the team handles it in the queue.
