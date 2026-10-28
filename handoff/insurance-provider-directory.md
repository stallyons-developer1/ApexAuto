# US Auto-Insurer Phone Directory (for Automation B)

These are the **publicly listed main customer-service lines** for the largest US auto insurers. The AI
voice agent dials these, then navigates the IVR to policy service / verification.

> **Important caveats for the developer:**
> - These are general customer/service lines. The exact **policy-verification** path is usually behind
>   an IVR menu ("policy service," "verify coverage") or a dedicated agent line — the agent must
>   navigate to it. Some insurers (Auto-Owners, Erie) are **agent-based**: verification often goes
>   through the renter's local agent, whose number is on the insurance card.
> - Numbers change. **Validate each before launch** and prefer the number printed on the renter's
>   insurance card when available.
> - Insurers will only verify to an **authorized** caller — see the consent requirement in
>   `automation-2-insurance-verification.md`.

| Company | Phone number | Notes |
|---|---:|---|
| State Farm | 800-782-8332 | Also agent-based; card shows local agent. |
| GEICO | 800-207-7847 | Central service line. |
| Progressive | 800-776-4737 | Central service line. |
| Allstate | 800-726-6033 | Also agent-based. |
| Liberty Mutual | 800-290-8711 | Central service line. |
| Farmers Insurance | 888-327-6335 | Also agent-based. |
| Nationwide | 877-669-6877 | Central service line. |
| USAA | 800-531-8722 | Members only; military-affiliated. |
| Travelers | 866-218-0397 | Central service line. |
| Erie Insurance | 800-458-0811 | Largely agent-based. |

## Machine-readable version (for the agent config)

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

Build the dropdown of insurers in the booking form from this list, and map the renter's selection to the
number the agent dials. Always allow a free-text "other" + the number from the renter's card.
