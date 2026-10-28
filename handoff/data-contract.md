# Data Contract — what flows between the steps

This is the "glue" the automations read and write. Keep one **booking record** (Supabase table
`bookings` recommended) that every step updates.

## The booking record

```jsonc
{
  "id": "bk_20260924_ab12",            // your internal id (also sent to Didit as vendor_data)
  "created_at": "2026-09-24T14:00:00Z",
  "status": "pending_id",              // state machine — see IMPLEMENTATION-PLAN §4
  "charged": false,
  "email_sent": false,

  // booking details (from the front-end)
  "vehicle": { "product_id": 381, "name": "Corvette C8 Stingray 2024", "class": "Exotic" },
  "dates":   { "pickup": "2026-10-01T10:00", "return": "2026-10-03T10:00", "days": 2 },
  "location":{ "pickup": "Apex Lot — Downtown", "dropoff": "Airport Terminal" },
  "renter":  { "name": "", "email": "", "phone": "" },   // filled at checkout / from ID

  // ① ID (from Didit) — see below
  "id_check": { "session_id": "", "status": "", "identity": { /* extracted fields */ } },

  // ② background check (Automation A writes this)
  "background": { "status": "", "provider": "certn", "report_id": "", "report_url": "",
                  "flags": [],                         // matched items, e.g. ["DUI (2023)"]
                  "reviewed_by": "", "reviewed_at": "", "decision": "" },  // for manual_review

  // ③ insurance (Automation B writes this)
  "insurance": { "status": "", "policy_number": "", "insurer": "", "covers_vehicle": null,
                 "name_matches": null, "call_id": "", "transcript_url": "" },

  // ④ payment
  "order": { "wc_order_id": null, "pay_url": "", "paid_at": null }
}
```

`status` values: `pending_id → id_approved → bg_clear → insurance_verified → paid`.
A flagged background check sets `manual_review` (standby); a reviewer moves it to `bg_clear` (approve) or
`declined_background` (decline). Other failures: `declined_id | declined_insurance`.

## ① Identity fields available from Didit

After ID passes, `GET https://verification.didit.me/v3/session/{session_id}/decision/`
(header `x-api-key: <DIDIT_API_KEY>`) returns a top-level `status` and `id_verifications[0]` with the
extracted document fields. **These are the inputs to Automation A and B** (verified: 2026-08 against a
live Approved session):

| Field | Example / meaning | Used by |
|---|---|---|
| `status` (top level) | `Approved` \| `Declined` \| `In Review` \| `Not Started` \| `Abandoned` | gate ① |
| `id_verifications[0].first_name` | given name | A, B |
| `id_verifications[0].last_name` | surname | A, B (name match) |
| `id_verifications[0].full_name` | full legal name | A, B |
| `id_verifications[0].date_of_birth` | `YYYY-MM-DD` | A (MVR/criminal) |
| `id_verifications[0].document_number` | driver's license number | A (MVR) |
| `id_verifications[0].issuing_state` | e.g. `FL` | A (MVR is per-state) |
| `id_verifications[0].expiration_date` | license expiry | A (invalid/expired license = decline) |
| `id_verifications[0].address` | address on license | A (Checkr candidate) |
| `id_verifications[0].portrait_image` | signed URL to the face image | audit |

> Full field list also includes `age`, `gender`, `nationality`, `formatted_address`, `mrz`,
> `extracted_data`, `face_matches[]`, `liveness_checks[]`. Do **not** log the full record in plaintext;
> it contains PII. Store only what each check needs + an audit reference.

## Hand-off shapes between automations

**A receives (MUST match the verified ID exactly — see Automation A):**
`{ booking_id, first_name, last_name, date_of_birth, issuing_state, address }`
**A returns:** `{ status: "clear" | "needs_review" | "declined", flags: string[], report_id, report_url }`.
`needs_review` → booking goes to `manual_review` and the review queue; a human sets clear/declined.

**B receives (only after ② is clear or manually approved):**
`{ booking_id, renter_full_name, insurer, policy_number, vehicle: "2024 Chevrolet Corvette C8 Stingray" }`
**B returns:** `{ status: "verified" | "declined", covers_vehicle: bool, name_matches: bool, notes, call_id, transcript_url }`
