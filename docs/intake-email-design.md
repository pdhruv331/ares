# ARES intake email: design (nothing set up yet)

Asked for in docs/phone-ui-prompt.md §8: an address to forward things to ("deal with this") that becomes a job with a
receipt. This is the proposal. **Nothing is created until you say go.**

## The cheapest private way

Use the Cloudflare account the relay already lives on (`relay/`, free tier):

1. **A domain on Cloudflare.** Email Routing needs a zone. Either a domain you already have on Cloudflare, or a cheap one
   bought there (~£8–10/yr). The address would be something like `ares@<your-domain>` or `do@<your-domain>`.
2. **Email Routing → an Email Worker.** Cloudflare delivers mail for that address to a Worker (`relay/intake.js`, same
   repo, deployed with the same wrangler). The Worker:
   - **Sender allow-list = your addresses only.** Anything else is `setReject`ed and never stored. Because the envelope
     sender can be spoofed, the Worker also requires the message to pass Cloudflare's authentication results
     (SPF/DKIM/DMARC on the sending domain) before trusting `From`. Gmail, iCloud and Outlook all sign.
   - Parses the message (subject, text body, attachments ≤ 10 MB) and puts it in **KV** (the relay's existing namespace)
     under a signed id, with a 24 h expiry. Nothing is pushed anywhere else; the body never leaves the account.
   - Pings the Mac through the existing path: a **normal-priority FCM data message** is not right (that's the phone), so
     the Worker instead sets a `pending-intake` flag the Mac already polls for (`/helper/poll` is the helper's; add a
     Mac-side `/intake/poll`, signed with the Mac's secret like `/notify`), and the Mac fetches the message over HTTPS.
3. **The Mac** (`intake.js`, main process): every 60 s while online, `GET /intake/poll` → for each message, start a job
   (`jobs.start({ title: subject, task: "Deal with this email…", inputs: attachments, source: 'email' })`), delete it
   from KV, and audit it. The job then has the normal receipt, approvals (tier 3 with the fingerprint), the outgoing check,
   and its result is pushed to the phone like any other job. A reply by email is NOT automatic: if the job wants to answer
   the sender, that is an outgoing send and goes through the approval + sentinel path.

Cost: £0 on the free tier (Email Routing and Workers are free; KV free tier covers it), plus the domain.

## What I'd ask you to decide

- The domain (existing or new) and the local part (`ares@` / `do@` / something nobody can guess, since the address is the
  only secret besides the allow-list).
- Your sending addresses for the allow-list (Gmail? iCloud? work?).
- Whether forwarded attachments should be allowed (PDFs yes, executables never) and the size cap.
- Whether a confirmation ("Got it: <subject> → job started") should come back by **phone notification** (recommended,
  free, private) or by email (needs Cloudflare Email Sending, also free but one more moving part).

## Alternatives considered

- **Gmail label + polling the Gmail API from the Mac**: no new infrastructure, but it needs a Google OAuth client and the
  Mac reading your mailbox; more access than the task needs.
- **A mailbox at a mail provider with IMAP**: another account and password on the Mac; the Worker route needs no inbox.
- **Zapier / Make**: a third party reading your mail. No.
