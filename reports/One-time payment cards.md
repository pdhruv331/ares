# One-time payment cards for ARES: options (research only, 2026-10-10)

Asked for in docs/phone-ui-prompt.md §8: which services issue single-use virtual cards to a personal account, and how ARES
would request one per purchase with your fingerprint. **No accounts were opened and nothing was bought.** Purchases stay
prohibited for ARES until you decide otherwise; this only maps the ground.

## The idea (from Meta Muse)

Muse pays with one-time cards so the agent never holds a reusable card number: each purchase gets a card that dies after
one charge (or is locked to one merchant with a cap). For ARES the equivalent would be: the brain asks for a card for a
specific purchase → the phone shows the exact merchant, amount and purpose → your fingerprint (tier 3, the same
`Approvals.approve` path as job approvals) → ARES receives a card number that is good for that one charge → the worker pays →
the card is closed. The number never reaches the model's context in reusable form, and the receipt records it.

## Who issues single-use cards to a *personal* account

| Service | Where | Single-use? | API for a personal account? | Notes |
|---|---|---|---|---|
| **Privacy.com** | US only (SSN for KYC) | Yes: single-use cards close after the first charge; merchant-locked cards lock to the first merchant, with spend limits | Their card-issuing API is business-oriented (launched 2020); I found no 2026 personal-account API. Personal tiers: free, Plus $5/mo, Pro $10/mo, Premium $25/mo (unverified for 2026) | Funded from a bank account/debit card. The best fit *if* you're US-based |
| **Revolut** | UK/EU (and US) | Yes: "disposable" virtual cards, the number is replaced after each purchase; 1 disposable + up to 20 virtual cards per account | No consumer API. Revolut's APIs are Business and Open Banking | Historically a paid-tier feature (Premium £6.99/mo at launch); check the current plan |
| **Monzo** | UK | Virtual cards (multiple, cancellable), but not true one-shot cards from what I found | No consumer card-creation API | Virtual cards draw from the same account |
| **Wise** | UK/EU + | Virtual cards, cancellable; disposable-style behaviour reported but not confirmed as single-use | No | |
| **Bank "virtual card numbers"** (Capital One Eno, Citi, Amex in some markets) | US mostly | Merchant-locked, not single-use | No public API | Browser extension flows only |
| **Fluz** | US | Documented single-use virtual cards with a "lock on next use" setting, which is reversible, so not a hard one-time guarantee | Has an API (docs.fluz.app) | Cashback-oriented; needs scrutiny before trusting |

Apple Pay / Google Pay tokens are per-device, not per-purchase, so they don't give the one-charge property.

## How ARES would request one per purchase

There is **no personal-account API** from any of these that ARES could call directly. Two honest ways:

1. **Human-in-the-loop (works today, no API):** ARES assembles the purchase (merchant, amount, what for) as an `approval`
   card; you approve with the fingerprint; the receipt tells you to create a disposable card in Revolut/Privacy and paste it
   into the phone (a one-time secret field that goes to the Mac over the paired channel and is wiped after the worker uses
   it). Clunky, but the number is single-use and never typed into a chat.
2. **Business API (Privacy.com Card Issuing / Lithic):** a *business* account (Lithic is Privacy's issuing arm) exposes
   create-card-with-spend-limit / single-use endpoints. That means a business entity, KYB, and fees, which is out of
   proportion for personal errands. Not recommended now.

## Recommendation

Don't build anything yet. If you have (or want) a Revolut account, option 1 gives the Muse property with zero integration:
the disposable card, your fingerprint on the phone, the receipt. If a personal API appears (Privacy.com has hinted at
consumer developer access before), the request-per-purchase flow above drops straight into the existing tier-3 path.

Sources: [Privacy.com merchant-locked cards](https://www.privacy.com/blog/virtual-card-business), [Privacy.com virtual card companies](https://privacy.com/blog/virtual-card-companies), [Privacy.com App Store](https://apps.apple.com/app/id1040298266), [Privacy.com 2026 explainer (third party)](https://joingerald.com/learn/banking--payments/privacy-com-virtual-cards-explained-2026), [Privacy.com card-issuing API funding/launch coverage](https://www.electronicpaymentsinternational.com/news/virtual-card-payment-startup-privacy-com-secures-10-2m-funding), [Fluz single-use cards docs](https://docs.fluz.app/Create-Single-Use-Virtual-Cards), [Which? on Revolut disposable cards](https://www.which.co.uk/news/article/revolut-launches-disposable-virtual-cards-to-fight-online-fraud-aj7Ww9v00DXV), [finder.com UK virtual debit cards](https://www.finder.com/uk/virtual-debit-cards), [Wise: virtual debit cards UK](https://wise.com/gb/blog/virtual-debit-cards-uk).
