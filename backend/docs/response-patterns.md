# Response patterns learned from sales@jdhealthcare.com.au

Grounding notes from reading paired received/sent emails (Sent Items) in the
real mailbox, so the triage system reflects how staff actually work rather
than generic assumptions. This is the reference to use when building the
real AI classifier/reply-drafter (see README Roadmap) — either as a prompt
appendix or few-shot examples.

## Standard reply structure (very consistent across staff)

1. Greeting by first name: `Good afternoon/morning [Name],` or `Hi [Name],`
2. `Thank you for contacting us.` — almost universal opening line.
3. Category-specific body (see below).
4. If there was a delay: an apology line — `We sincerely apologize for the
   delay and any inconvenience this may cause. Thank you for your patience
   and understanding.`
5. Close: `Please let me know if you have any questions or require any
   further information.` / `Please feel free to reach out if you need any
   further assistance.`
6. Signature block:
   ```
   Best regards,
   PAULA PERDOMO
   Operations Coordinator
   1300 791 404
   3/22 Beaumont Rd, Mt. Kuring-Gai 2080
   JDHEALTHCARE.COM.AU
   ```

Tone is warm and personal — first names, occasional friendliness ("Happy
Friday!", emoji), not purely transactional. This is a relationship-driven
customer service culture.

## Category-specific patterns

**PO / ETA requests** — staff check stock/container status internally
*before* replying (see "Internal escalation" below); they don't answer from
the email alone. The reply is per-PO:
- Delivered → "Please note that PO `<number>` was delivered `<date>`. I have
  attached the Proof of Delivery for your reference." (POD is a screenshot/
  doc attachment, not just text.)
- Not yet delivered → "Regarding PO `<number>`, we are expecting to receive
  our container `<timeframe, e.g. 'this Monday or Tuesday'>`. As soon as the
  stock becomes available, we will arrange for the order to be dispatched
  promptly." + apology line.
- Buyer emails often include a structured table: PO number, PO line number,
  product item, supplier product number, **warehouse**, ETA — worth
  extracting warehouse/line number too, not just the PO number, if building
  richer extraction later.

**Equipment faults** — genuine hardware faults are *not* answered directly.
Staff forward internally to Purchasing with a short structured note:
> "The customer is looking for replacement clips for their Levabo Turn All
> system. They advised that the two clips that connect the hoses to the pump
> housing have broken due to frequent use. Could you please check with the
> manufacturer if these clips are available as replacement parts and, if so,
> confirm the price and availability?"

**Important distinction**: a customer sharing that they *already fixed* the
issue themselves, or leaving positive feedback with a minor comment, is a
completely different reply — warm, thankful, addresses the specific detail
(e.g. sizing) directly, no escalation. The "Push Ortho Thumb Brace" thread is
the concrete example: the customer said *"I have sorted my two braces out"*
after earlier positive feedback, and got a reply thanking them and offering
a different plastic-cap size — not an urgent fault escalation. Keyword
matching alone ("digs into", "broken") can't tell these apart; a real AI
classifier needs to weigh sentiment/resolution-status, not just fault
vocabulary.

**Invoice/billing** — staff check tracking/dispatch records and reply with
Proof of Delivery for delivery disputes, or forward to Accounts
(`accounts@jdhealthcare.com.au`) for billing corrections/remittances.

**Quotes/pricing** — if stock is available, send the quote attached; if
backordered, give a specific estimated window (e.g. "last week of
September") with an apology, same as PO/ETA handling.

**Spare part enquiries** — replies are structured with exact fields:
```
Code: PABM-FOOT PLATE NUT
Description: I-MOVE Plastic Nut for Locking Pin on Foot Plate
Price: $2.00 + GST each
```

**Product enquiries / sales leads** — many are *not* answered by the
sales@ team directly. They're forwarded internally to a named specialist
with a one-line intro: *"Could you please assist [name] when you get a
chance?"* — routing depends on topic (lifters/trials → Michael; general
product enquiries → Edan; equipment sourcing/faults → Scott/purchasing).
Only simple factual questions (e.g. cleaning instructions from a manual)
get answered directly by the ops team.

## Internal escalation is the default, not the exception

A large share of "enquiries" in this inbox aren't resolved by the person
reading them — they're triaged to the right internal person first:
- Stock/ETA questions → Purchasing (Scott/"Scotty")
- Equipment faults/spare parts → Purchasing + manufacturer
- Sales leads / trial requests / specialised product questions → named
  product specialists
- Billing/remittances → Accounts

This means the dashboard's "suggested action" is often correctly "route to
X" rather than "reply to customer" — the current rule-based classifier
reflects this now (see `classify.js`), and a future AI drafter should treat
routing as a first-class suggested action, not just reply drafting.
