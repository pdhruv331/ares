# Meta Muse (as of 2026-10-10)

Research done 2026-10-10. Most launch coverage is from September 2026, so it is fresh and sometimes inconsistent. Where outlets disagree, both versions are given. Primary sources: Meta newsroom (about.fb.com), Meta research blog (research.meta.ai), Artificial Analysis. Several secondary sources are aggregators or blogs; they are flagged where a claim rests only on them.

## 1. What exactly is Meta Muse, who built it, when, and what does it do?

### Takeaway
"Meta Muse" is not one thing. It is Meta Superintelligence Labs' (MSL) **Muse** brand, which covers (a) the **Muse Spark** family of proprietary LLMs (first released 2026-04-08, now at 1.3), and (b) **Muse**, a consumer **personal AI agent app** launched 2026-09-08 in the US. The agent runs on Muse Spark inside a per-user cloud VM and does real tasks: email, bookings, forms, shopping and payments. The family also includes an open-weights 30B model, **Muse Glimmer** (2026-08-10, Apache 2.0), plus Muse Image, Muse Video and Muse Realtime Avatar. When people say "Meta Muse" in autumn 2026, they almost always mean the agent app.

### Cited Findings

**Timeline**
- **2026-04-08: Muse Spark.** First model in the new "Muse" series from Meta Superintelligence Labs, announced as powering the Meta AI app and meta.ai. Meta calls it "small and fast by design" yet able to reason through science, math and health questions, and says larger models are in development. The post was updated 2026-05-12 for the expanded rollout. — [Meta newsroom](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)
- MSL is led by chief AI officer Alexandr Wang. Muse is a break from the Llama line: the lab "rebuilt Meta's AI stack from the ground up". — [eWeek](https://www.eweek.com/news/meta-muse-spark-ai-launch-multimodal-reasoning/); [DataNorth](https://datanorth.ai/news/meta-releases-muse-spark-first-model-from-superintelligence-labs)
- **2026-07-09: Muse Spark 1.1** and a public preview of the **Meta Model API**, Meta's first paid model API. The preview is open to US developers only. — [Trending Topics](https://www.trendingtopics.eu/meta-opens-muse-spark-1-1-to-developers-and-bets-on-aggressive-pricing/); [The Star](https://www.thestar.com.my/tech/tech-news/2026/07/09/meta-debuts-muse-spark-11-with-preview-open-to-developers)
- **2026-08-10: Muse Glimmer.** A 30B open-weights model (Apache 2.0) for "always-on local agent workflows". — [Meta research blog](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)
- **~2026-09-02: Muse Spark 1.3.** Release date per Artificial Analysis's FAQ. — [Artificial Analysis](https://artificialanalysis.ai/models/muse-spark-1-3)
- **2026-09-08: Muse, the agent app.** "Doesn't just answer questions, it actually does the work." Powered by Muse Spark, and Spark 1.3 according to secondary sources. Rolling out in the US on iOS, Android and muse.ai, and also usable by messaging it in WhatsApp. Glasses support is "coming soon". — [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/); [Let's Data Science](https://letsdatascience.com/news/meta-launches-muse-personal-ai-agent-403f80e4)
- Meta's VP of AI products Vishal Shah said the agent was **delayed from an April release to work through security concerns**. — reported via [The Next Web](https://thenextweb.com/news/meta-muse-personal-ai-agent-launch) / [Let's Data Science](https://letsdatascience.com/news/meta-launches-muse-personal-ai-agent-403f80e4) (secondary, citing Axios)
- **2026-09-23: Meta Connect.** Announcements:
  - Muse **Realtime Avatar** model: real-time video chat with the agent's own avatar. Demoed, "soon".
  - Glasses integration via a wake word: workouts, meal logging, booking, "buy what you see". "Coming months".
  - **Mac computer use**: "operate any app on the desktop", keeps working while you're away. No date.
  - Muse gets its **own email address**, so you can CC it or forward mail to it. "Soon".
  - Shopify full-catalog search; Shop Pay and PayPal.
  - Retail partners: Best Buy, Gap, Sephora, Walmart, Wayfair, Expedia, and Instacart (coming soon).
  - Connectors: GitHub, Granola and Notion.
  - A connector developer platform, which got over 1,500 applications in under a week (per Wang).

  — [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)

**The model family**
- MSL produces the Muse family: the Muse Spark LLM, Muse Image and Muse Video. — [Wikipedia: Meta Superintelligence Labs](https://en.wikipedia.org/wiki/Meta_Superintelligence_Labs) (tertiary)

**Muse Spark capabilities (as shipped in Meta AI, April)**
- Instant and Thinking modes.
- Parallel subagents. Meta's example is a trip plan split three ways: itinerary, destination comparison, kids' activities.
- Image understanding of photos and products.
- "Visual coding": websites, dashboards and mini-games from a prompt.
- Voice conversations with interruption, topic switching and language switching.
- Live AI camera mode in the app.
- Health answers developed with physicians.
- Shopping mode that includes Facebook Marketplace.

  — [Meta newsroom](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)
- Secondary sources add "thought compression": RL penalises excess reasoning tokens. They also report Meta's claim of Llama 4 Maverick-level capability for over 10× less compute, and a third "Contemplating" mode. Meta's own newsroom post mentions only Instant and Thinking. — [DataNorth](https://datanorth.ai/news/meta-releases-muse-spark-first-model-from-superintelligence-labs); [eWeek](https://www.eweek.com/news/meta-muse-spark-ai-launch-multimodal-reasoning/)

**What the Muse agent does**
- Proactive suggestions, plus goals and plans.
- Memory: it can act on details you mention once.
- User-chosen connected accounts (e.g. email).
- Tasks: sending email, booking travel, filling forms, **negotiating on your behalf**.
- **Keeps working after the app is closed** and comes back when something changes or needs approval.
- Example: turns a saved Instagram recipe reel into a grocery list.

  — [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

**Architecture and safety**
- Runs in **Muse Secure VM**, a dedicated cloud VM that holds both the agent and the user's data.
- A separate **Sentinel agent** must approve anything Muse sends to the internet.
- Muse can't see stored passwords or payment methods; credentials go into secure storage.
- It asks before sensitive actions (sending email, purchases) and keeps an **audit trail of past and planned actions**.
- **Muse Confidential VM**, encrypted with a user-held key, is planned "later this year".

  — [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

**Payments**
- Checkout uses Link by Stripe with a **one-time-use card**. Meta says Muse is the first AI agent covered by Link's purchase protections. 1Password support is "coming soon". — [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

**Business model**
- Zuckerberg: free for "a huge number of tokens"; Meta expects to earn a small fee on transactions over time.
- The agent's physical avatar is called "Jolly".

  — [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)

**Other "Muse" products (not Meta's)**

Background knowledge; not re-fetched in this session:
- **Microsoft Muse** (Feb 2025): a "World and Human Action Model" for game ideation, trained on Ninja Theory's *Bleeding Edge*. — [Microsoft Research](https://www.microsoft.com/en-us/research/blog/introducing-muse-our-first-generative-ai-model-designed-for-gameplay-ideation/)
- **Muse EEG headband** by Interaxon, a meditation and sleep wearable. — [choosemuse.com](https://choosemuse.com/)
- **Google's Muse** (Jan 2023): a text-to-image transformer research model. — [muse-model.github.io](https://muse-model.github.io/)

### Inferences
- For a phone user in October 2026, "Meta Muse" = the Muse agent app (and WhatsApp chat). For a developer, it = Muse Spark via the Meta Model API, or Muse Glimmer weights.
- This is a strategic pivot. Meta's frontier models are now closed and paid (Spark), with only a distilled mid-size model open (Glimmer). That reverses the Llama-era "open everything" posture.
- Product shape: Muse is closer to Claude/ChatGPT "agent with a cloud computer" products than to a classic phone assistant. It does not control the phone itself; it acts on the web and on connected accounts from a cloud VM.

### Gaps
- No primary source found for Muse Spark's parameter count or architecture. Artificial Analysis lists it as undisclosed.
- "Muse by Meta for creators" (named in the brief): found no evidence that such a product exists separately from Muse Image/Video.
- Exact launch markets are unconfirmed. Meta says "US". One secondary source says US and Canada (see section 4).

## 2. How is it delivered to phones, and what is it good at?

### Takeaway
On phones, Muse is a standalone iOS/Android app plus a WhatsApp contact (US only). The Muse Spark model also powers the ordinary Meta AI assistant in the Meta AI app, WhatsApp, Instagram, Facebook, Messenger, Threads and Ray-Ban/Oakley Meta glasses. Hands-on reviews (Sept 2026) find it strongest at **planning and multi-step errands with clear guidance and approvals**, and weaker at **browser shopping on bot-hostile sites** and **factual freshness**. It hit #1 free on the US App Store.

### Cited Findings

**Delivery**
- Muse is reached in the Muse app (iOS/Android) or directly in **WhatsApp**, "just like messaging another person". — [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- Muse Spark in Meta AI goes to the Meta AI app and meta.ai first (US). Rollout to WhatsApp, Instagram, Facebook, Messenger and Threads covers search bars, group chats (side chats) and @meta.ai mentions. It reaches Ray-Ban Meta and Oakley Meta glasses in the US and Canada, and Meta Ray-Ban Display in summer 2026. — [Meta newsroom](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)

**Pricing**
- Free tier plus **Power at $20/month** and **Maximum at $100/month**. Wang (to Axios): the paid tiers cover heavy users' compute; most people should manage on free.
- A card is required on file even for the free tier, and reviewers flagged this as friction.
- One source claims a free allowance of ~100M tokens/week. This is single-source and unverified.

  — [Let's Data Science](https://letsdatascience.com/news/meta-launches-muse-personal-ai-agent-403f80e4); [codersera guide](https://codersera.com/blog/meta-muse-ai-agent-app-guide-2026/amp/) (secondary)
- Meta's own wording: "free for most of what people need, with subscription plans for people who want to do more." — [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

**Adoption**
- Muse overtook ChatGPT as the **#1 free app on Apple's US App Store**. — [Fortune, 2026-09-22](https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/)
- Download estimates (third-party, not Meta numbers): >3.4M (Sensor Tower, reported by TechCrunch on 2026-09-25) and 2.8M installs in 12 days (Apptopia). — via [search summary of TechCrunch/YourStory](https://yourstory.com/ai-story/meta-muse-chatgpt-early-ai-app-downloads)

**Reviews: what worked**

Yahoo Finance (Daniel Howley, 2026-09-23):
- **Moving quotes**: contacted 4 movers; two called back within ~2 minutes.
- **Date-night booking** via OpenTable.
- **Fantasy football**: linked Yahoo account, filed a waiver claim, set the lineup the next day.
- **Nintendo Switch 2 game purchase**: summarised the total before the user pressed buy. "Pretty seamless", but slower than buying directly.

— [Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html)

**Reviews: what failed**
- Recommended a bar that had **closed years ago** (it blamed stale data).
- **Fabricated a phone number**, then admitted it had invented it.
- The verdict: "a solid helper for a host of multi-step tasks", but hallucinations make it "difficult to trust AI outputs outright".

— [Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html)

**Other reviews**
- CNN (2026-09-23): booked a date night and built a day-by-day packing schedule for a move. It gives more guidance than ChatGPT/Gemini, which "can feel like a blank canvas". This is from a search summary only; the page returned HTTP 451 to the fetcher. — [CNN](https://www.cnn.com/2026/09/23/tech/meta-muse-ai-agent)
- Lenny's Newsletter / How I AI:
  - The **activity feed shows tool calls as a step-by-step "task lineage"**.
  - An **"Ideas" prompt library** helps onboarding.
  - A **library** holds docs, sites, images, videos and podcasts.
  - A one-shot family morning-newsletter PDF built from calendar, email and kids' schedules was judged "more beautiful than anything I've ever made with Claude or Codex".
  - Browser shopping was poor at New Balance but good for IMAX tickets.
  - The animated avatar persona stood out.

  — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent)

**Platform conflict**
- **Amazon blocked Muse** from its store: "continued access by an unauthorized AI agent violates Amazon's Conditions of Use". Amazon says Meta never asked permission, and the stated concern is that agents skip ad-bearing visits. — [Fortune](https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/)

### Inferences
- What it is good at on phones: delegating errands that need outbound contact (quotes, bookings, reservations) and planning with structure. It also lives inside WhatsApp, where many people already are.
- What it is not: a phone-control assistant. Nothing found shows Muse acting on Android apps, notifications or system settings the way Gemini on Android does. It works from a cloud VM against the web and connected accounts.
- Reliability ceilings are the usual agent ones: hallucinated facts, stale local data, and sites that block bots (Amazon).

### Gaps
- No official usage or MAU numbers from Meta for Muse.
- No measured latency or battery data for the Android app.
- No review found that specifically covers the Android app, as opposed to iOS or web.
- Could not read full CNN text (HTTP 451).

## 3. Developer access: API, SDK, open weights, licence terms

### Takeaway
There are two developer routes.

- **Muse Spark** (proprietary, closed weights) is available through the paid **Meta Model API**: public preview, **US developers only**, $1.25 / $4.25 per M input/output tokens, 1M context. It reportedly accepts OpenAI-style and Anthropic Messages-style requests.
- **Muse Glimmer 30B** is **open weights under Apache 2.0** on Hugging Face. It needs a Mac/PC with roughly 24–32 GB of memory when 4-bit quantised, so it is **not a phone model**.

The Muse **agent** itself has no public API; there is a connector developer platform for plugging services into it.

### Cited Findings

**Muse Spark via the Meta Model API**
- The Meta Model API public preview opened **2026-07-09** with Muse Spark 1.1. It is Meta's first paid model access and limited to US developers.
- Pricing: $1.25/M input, $4.25/M output, $20 free credits per new account.

— [Trending Topics](https://www.trendingtopics.eu/meta-opens-muse-spark-1-1-to-developers-and-bets-on-aggressive-pricing/)

Further details, all from secondary sources:
- Cached input is $0.15/M.
- Web-search grounding costs $2.50 per 1,000 queries.
- The API is OpenAI-SDK compatible with structured output, parallel tool calling and prompt caching.
- One source says it also natively supports the **Anthropic Messages format**.
- Not yet open in the EU.

— [aiweekly](https://aiweekly.co/alerts/meta-prices-muse-spark-11-api-at-125425-per-m-tokens); [developersdigest guide](https://www.developersdigest.tech/blog/meta-muse-spark-1-1-developer-guide-2026); [runtimewire](https://runtimewire.com/article/meta-opens-muse-spark-to-developers-with-a-low-priced-coding-model-and-1m-contex)

Artificial Analysis on **Muse Spark 1.3 (Max)**:

| Measure | Value |
|---|---|
| Released | ~2026-09-02 |
| Providers | 1 (Meta's API) |
| Price | $1.25 / $4.25 per M tokens |
| Output speed | 122.5 tok/s |
| Time to first token | **~57 s**, reasoning (median 3.8 s) |
| Context | 1M |
| Input | Text, image, video |
| Output | Text only |
| Weights | Proprietary, parameters undisclosed |
| Verbosity | 170M tokens on the index (median 82M) |

— [Artificial Analysis](https://artificialanalysis.ai/models/muse-spark-1-3)

**Benchmarks (they conflict)**
- The AA page fetched today shows **48 on the Intelligence Index, #23 of 227**.
- AA search snippets show **62** for 1.3 (max) and 61 (xhigh).
- AA's April article put the original Spark at **52**, just behind Gemini 3.1 Pro, GPT-5.4 and Claude Opus 4.6, and ahead of Claude Sonnet 4.6.
- The difference likely reflects AA's index version change (v4.1.1, 9 evals). Treat absolute numbers as version-dependent.

— [AA 1.3 page](https://artificialanalysis.ai/models/muse-spark-1-3); [AA April article](https://artificialanalysis.ai/articles/muse-spark-everything-you-need-to-know)

- Meta-claimed (via secondary sources): 50.2% on Humanity's Last Exam in Contemplating mode (vs Gemini 3.1 Deep Think 48.4%, GPT-5.4 Pro 43.9%); HealthBench Hard 42.8 (vs GPT-5.4 40.1). These are vendor claims and not independently verified. — [search summary of eWeek/DataNorth](https://www.eweek.com/news/meta-muse-spark-ai-launch-multimodal-reasoning/)

**Muse Glimmer (open weights)**

| Detail | Value |
|---|---|
| Released | 2026-08-10 |
| Size | 30B parameters |
| Licence | **Apache 2.0**, no EU or MAU restrictions stated |
| Weights | Hugging Face `meta-models/Muse-Glimmer-30B` |
| Memory, full precision | >55 GB |
| Memory, ~4-bit | <20 GB for the LLM; with KV cache, perception encoder and drafter it fits a **24–32 GB** envelope |
| Speculative decoding | DFlash drafter, decode speedups of 3.1× (RTX 5090), 1.8× (M5 Max), 1.5× (M4 Max) |
| Inputs | Text and images |
| Languages | 100+ |
| Agentic focus | Tool use with precise function schemas, retrying failed tool calls, adjustable reasoning effort |

- Evaluated on DeepSearch QA, MCP-Atlas, τ-Bench and SWE-Bench.
- Runtimes: llama.cpp, MLX, ExecuTorch, Ollama, LM Studio, vLLM, SGLang, OpenRouter and others.
- Distilled from Muse Spark.
- Compared against Gemma4-31B and Qwen3.6-27B, but scores are only in an image.
- **No phone or Android target named.**

— [Meta research blog](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)

**Muse agent**
- Meta opened a developer platform for **connectors** into Muse (1,500+ applications in under a week). — [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)
- Meta says it "hope[s] to open-source future versions"; this is not a commitment for Spark itself. — [Meta newsroom](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)

### Inferences
- ARES as a model consumer: Muse Spark is cheap per token and reportedly speaks the Anthropic Messages format, so it could be a drop-in secondary model for ARES's Mac brain. It would be pay-per-token, separate from the Claude subscription. Two drawbacks: preview status, and the ~57 s time-to-first-token in max reasoning (Instant/low effort would be needed for voice).
- ARES's owner is outside the US: his Samsung phone and prior context suggest non-US use, but this is not confirmed. If so, the US-only restrictions on both the API and the agent may block him outright.
- ARES on-device: Glimmer 30B is a candidate for a **local Mac fallback brain**. A 32 GB+ Apple Silicon Mac could run it 4-bit through MLX or Ollama for offline or no-credit use, much as Kokoro is the local fallback voice. It will not run on the Galaxy phone.

### Gaps
- API data-retention and training-on-API-data terms not found.
- Rate limits not found.
- Whether the Anthropic Messages compatibility is real: a single secondary source, not verified against Meta docs.
- Exact Glimmer benchmark numbers (in an image only).
- Glimmer context length not stated.

## 4. Privacy, data use, EU availability and criticisms

### Takeaway
Muse asks for unusually deep access (email, payments, travel documents, sometimes bank data) and keeps it in a per-user cloud VM, behind a separate approval agent and an audit trail. Training on your Muse interactions is **on by default** (opt-out). It is **US-only**, with **no EU/UK date**, because of GDPR and AI Act hurdles. Main criticisms: trust in Meta with this data, hallucinations, card-on-file friction, and platform pushback (Amazon block).

### Cited Findings

**Meta's stated controls**
- Users can opt out of interactions training Meta's models.
- Conversations and VM data are not shared with Meta's ad systems.
- "Forget" commands are supported, and access can be disconnected at any time.

— [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

**Defaults and data asks**
- The model-improvement setting is **on at first use** and can be turned off in Data controls. — [search summary citing Meta](https://www.neoteo.com/en/a-meta-muse-hands-on-review-found-task-help-and-data-prompts)
- One hands-on (2026-09-20) reported prompts to connect financial accounts, email, documents, and passport or licence expiry details. — [Neoteo](https://www.neoteo.com/en/a-meta-muse-hands-on-review-found-task-help-and-data-prompts) (secondary)
- Muse requires sensitive data, such as bank access, to work fully. Meta says logins are kept secret and purchases use one-time card numbers. — [Fortune](https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/)

**Meta's track record**
- Meta faces proposed class actions alleging smart-glasses footage was sent to human reviewers for AI annotation; Meta disputes this. — [Fortune](https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/)
- Reviewers cite Meta's 2019 $5B FTC settlement as a trust overhang. — [Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html)

**Europe**
- Not in the UK or EU, with no date. A Spanish report (2026-10-07) says Meta "stumbled" on European law and is holding back an immediate launch. — [merca2.es](https://www.merca2.es/2026/10/07/meta-muse-europa-leyes-2468346/)
- TechRepublic: Meta's 29 July earnings call gave no European plan. It also notes that AI Act Article 50 transparency duties applied from 2 August 2026. — [TechRepublic](https://www.techrepublic.com/article/news-meta-ai-agents-eu-rules-emea/)
- Conflicting market lists: Meta says the US. One source says the US and Canada. — [nssmag](https://www.nssmag.com/en/lifestyle/47073/muse-meta-how-it-works) vs [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

**Security framing**
- An outlet headline claims Meta made "a public admission it can be exploited". The page was inaccessible (HTTP 403), so the claim is unverified. — [FourWeekMBA](https://fourweekmba.com/ai-meta-muse-personal-ai-agent-trust-liability-frontier/)

### Inferences
- The design answer to "agent with your accounts" is defence in depth: an isolated VM, an independent egress gatekeeper (Sentinel), a credential vault the model can't read, one-time cards, approvals before irreversible actions, and a visible audit trail. ARES already has most of these: control.js tiers, audit.jsonl, the tier-3 "yes" gate, and the redact.js egress cleaning.
- The Amazon block shows the strategic risk of web-automation agents. ARES's local-Mac, user-session approach is less exposed but faces the same per-site fragility.

### Gaps
- No regulator statement specific to Muse found.
- The "exploitable" admission is unverified.
- Exact data-retention periods are not found.

## 5. What should ARES take from it, and is it worth integrating?

### Takeaway
**Don't integrate the Muse agent.** It has no API, is US-only, and duplicates ARES. **Optional and low priority:** try Muse Spark through the Meta Model API as a cheap secondary model, if the owner is US-eligible, or **Muse Glimmer 30B locally** as an offline or no-credit fallback brain on the Mac. The **biggest value is as a UX reference**: Muse is the first mass-market personal agent, and its reviewed strengths map directly onto ARES features.

### Cited Findings (the features worth copying)
- **Task lineage**: a step-by-step activity feed of tool calls and the action audit trail. Reviewers singled it out. — [Lenny's](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent); [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- **Background work with return-on-change**: the agent keeps working after the app closes and pings when something changes or needs approval. — [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- **"Ideas" starter library and guided structure** instead of a blank chat. CNN contrasted this with ChatGPT/Gemini. — [Lenny's](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent); [CNN](https://www.cnn.com/2026/09/23/tech/meta-muse-ai-agent)
- **Goals with tracking** (water intake, sleep training) and proactive plan-building. — [Lenny's](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent); [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- **Polished one-shot artifacts** from personal data, such as the family-morning newsletter PDF from calendar, email and schedules. — [Lenny's](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent)
- **Messaging-native access**: talk to the agent in WhatsApp like a person. Coming: its **own email address** to CC or forward to. — [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/); [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)
- **Outbound real-world contact**, e.g. requesting quotes from movers, which was the best-reviewed task. — [Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html)
- **A persona avatar** and **real-time avatar video chat**. — [Lenny's](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent); [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)
- **Safe payments**: a one-time virtual card via Link by Stripe, credentials in a vault the model can't read, and 1Password integration planned. — [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- **Glasses with a wake word**, "buy what you see", and meal logging. — [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)
- **Desktop computer use on the Mac** ("operate any app"). ARES already does this locally through control.js and ares-control. — [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)

**How the Muse Spark API fits ARES (secondary sources)**
- Reported Anthropic Messages and OpenAI compatibility.
- 1M context, $1.25/$4.25 per M tokens.
- US-only preview.

— [developersdigest](https://www.developersdigest.tech/blog/meta-muse-spark-1-1-developer-guide-2026); [Trending Topics](https://www.trendingtopics.eu/meta-opens-muse-spark-1-1-to-developers-and-bets-on-aggressive-pricing/)

### Inferences

**Comparison with phone assistants**

This combines the findings above with general background; no fresh competitor research was done in this pass.
- **Gemini on Android** is OS-integrated: system default assistant, app actions, on-screen context. Muse is not; it acts from a cloud VM and over WhatsApp.
- **Apple Intelligence / the revamped Siri** is OS-integrated on iOS. Fortune notes a revamped Siri shipped around Muse's launch.
- **ChatGPT and Claude mobile apps** are the closest analogues, as chat apps with agent and computer-use modes.
- Muse's differentiators are distribution (WhatsApp, Instagram), commerce integrations (Stripe/Shopify/PayPal plus retailers), and the guided consumer UX.
- ARES's differentiators are being his home-screen launcher with notification access, local Mac control, Claude as the brain, and no third-party data custody.

**Concrete ARES backlog ideas, mapped to existing modules**
1. A "task lineage" view in the Work panel and the phone Work view, built from audit.jsonl plus job events: per job, show each tool call, approval and outcome.
2. Proactive "return when something changes" notifications for running jobs. Push only on state change or needed approval; this fits the existing job and notification plumbing.
3. An "Ideas" starter library on the launcher's ARES card page, with seeded prompts tied to his real data (calendar, jobs).
4. A goals tracker with phone check-ins, as an extension of autonomy.js GOALS/ROUTINES.
5. ARES's own email inbox or forward-to address as an intake channel.
6. One-time virtual cards for any future purchase tier; never give the model raw card data. This is consistent with the existing prohibition approach.
7. Outbound "get me quotes" flows using the existing phone line (ARES Calls). This needs care given the CLAUDE.md rule not to touch calls.js paths as a side effect.

**Integration verdict**
- Muse agent: no. It has no API and is US-only.
- Muse Spark API: low priority. It is a cost hedge for non-voice batch tasks only if he is eligible. Claude via his subscription remains the brain.
- Muse Glimmer: worth a small spike as an offline fallback LLM if the Mac has 32 GB+ unified memory, in the same spirit as the Kokoro voice fallback.

### Gaps
- His Mac's RAM is not checked, so it is unknown whether Glimmer would fit.
- Whether he is in the US: if not, the Muse app, WhatsApp Muse and the Meta Model API are all unavailable to him.
- No direct head-to-head reviews of Muse vs Gemini on Android or Apple Intelligence were found.
