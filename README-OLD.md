# Dina — Your Personal Agent

> *2012-2017, I wrote a novel called [UTOPAI](./UTOPAI.pdf).  about a world where every person had a personal AI named Dina. She wasn't a search engine or a chatbot. She was yours — she knew your friends, remembered your promises, whispered helpful things when you needed them, and talked to other Dinas so life just... worked better. This repository is my attempt to build her.*

---

# Part I: The Vision

## What is Dina?

Imagine this. Your friend Sancho is coming over for tea. You haven't seen him in a while. As he leaves his house, his Dina quietly lets your Dina know. Your Dina remembers that Sancho's mother was unwell last time you met. It reminds you to put the kettle on — he likes his tea strong. It clears your calendar for the next two hours.

You open the door. You ask about his mother. Sancho smiles — you remembered.

That's Dina. Not an app. Not a chatbot. A personal agent that makes you more thoughtful, more present, and more human.

Now imagine the same thing, everywhere in your life:

- You're buying a laptop. Your Dina talks to the review bots, checks the Reputation Graph, and tells you: *"The battery on this one dies in three months. Here's a better option."*
- You're in a meeting. Dina whispers: *"You've interrupted him twice. Let him finish."*
- You promised your daughter you'd read her a book. You forgot which one. *"It was 'The Little Prince'. Last Tuesday."*
- Your license needs renewal. Dina informs you, and talks to OpenClaw to renew the license.

Dina is the agent that does what you *need*, not just what you *say*. She's quiet most of the time. There when it matters.

---

## Dina is You

This is the most important idea in this entire document, so I want to say it clearly.

**Dina is your digital identity.** Not an account on someone else's server. Not a profile that a corporation can delete or suspend. *You.*

Today, you don't own your digital self. You're a Google account here, an Apple ID there, a phone number on WhatsApp, an email on LinkedIn. None of these are yours — they're accounts that companies let you use. If Google bans you tomorrow, a piece of you disappears. You're a tenant everywhere. Landlord nowhere.

Dina changes this. Your Dina is your sovereign digital self. You hold the encryption keys. You own the data. You control who sees what. Everything else — the memory, the preferences, the Dina-to-Dina communication, the purchases, the reputation — all of it hangs on this one foundation: **you own you.**

When Sancho's Dina tells your Dina he's coming over — that's two sovereign identities choosing to communicate. Not two users on a platform that reads their messages. When your Dina talks to a seller's Dina — that's two identities transacting directly. No marketplace in the middle deciding what you see.

If you delete your data, it's truly gone. Not "deleted" the way Facebook deletes things (where the data lives on their servers forever). Gone — because no one else ever had the keys.

### One You, Many Faces

In real life, you're already many people. You're a professional at work, a parent at home, a buyer at a store, a patient at the doctor. These aren't fake identities — they're different facets of the same person, shared in different contexts.

Dina mirrors this. One root identity — you, the human, the keys. But multiple *personas* that reveal only what each situation needs.

- When your Dina talks to a seller's Dina, the seller sees: *verified real person, valid payment, wants a chair.* Not your name, not your medical history, not where you live.
- When your Dina talks to Sancho's Dina, it shares warmth — your history together, preferences, the social stuff.
- When your Dina handles your license renewal, it presents your full legal identity.

Different context, different projection. Same you underneath.

This isn't just a preference — it's enforced by the architecture. Each persona is a separate cryptographic compartment. No external system can ever see anything about you — they see only what is explicitly shared for that specific interaction. Even Dina herself cannot move data between compartments. If a chair seller's Dina attempts to pose as a bank and asks for your financial details — it doesn't matter how clever the request is. The architecture makes it impossible, not just forbidden. The default is total opacity. Small, specific windows open for specific interactions — and even then, only what that compartment was designed to hold.

> *Apple says: "We won't read your data." That's a policy. Policies change.*
>
> *Dina says: "We can't read your data." That's math.*

---

## Why I'm Building This

I wrote UTOPAI in 2017 because I could see where things were heading. AI was going to become deeply personal — it would know us better than we know ourselves. The question was: *who would it work for?*

Today, personal AI agents are arriving. [OpenClaw](https://github.com/openclaw/openclaw) has 150,000 GitHub stars. Apple, Google, OpenAI, and Meta are all building agents that live on your devices, hear what you say, and see what you see. This is wonderful and inevitable.

But there's a missing piece. These agents are smart and capable, but they don't have a loyalty framework. When your agent recommends a product, is it because the product is genuinely good — or because someone paid for the placement? When it filters your notifications, whose attention is it optimizing for?

Dina is that missing piece. She's an open protocol — a set of rules that any agent can adopt to become genuinely, verifiably *yours*.

Think of it like this: HTTPS doesn't compete with Chrome or Firefox. It makes all browsers *secure*. Dina doesn't compete with OpenClaw or Google or Apple. She makes all agents *loyal*.

The novel is in this repository. Not as marketing — as proof that this idea wasn't born from a business opportunity. I've been thinking about this for nine years. I don't plan to make money from Dina, because the moment a trust layer has a financial incentive, it has a conflict of interest. And a conflict of interest is the one thing a guardian cannot have.

One thing I feel strongly about: Dina should never become your emotional crutch. The whole AI industry is racing to build an AI that loves you and replaces your human relationships. Dina is the opposite — when you need connection, she connects you to people, not to herself. That's a lesson straight from the novel.

---

## How Dina Thinks

### She's Quiet First

Most of your digital life is noise. Dina's default state is silence.

She classifies everything into three tiers:

| | Type | What Dina Does | Example |
|---|------|---------------|---------|
| **Tier 3** | Engagement | Stays silent. Saves it for your daily briefing if you want it. | *"New video from MKBHD"*, *"Flash sale on shoes"* |
| **Tier 2** | Things you asked for | Notifies you. You pre-authorized this. | *"Wake me at 7 AM"*, *"Tell me if Bitcoin hits $100K"* |
| **Tier 1** | Things that protect you | Interrupts. Because staying silent would cause you harm. | *"This contract is malicious. Stop."*, *"Phishing attempt."* |

The rule is simple: **if staying silent causes harm, speak. If staying silent merely causes a missed opportunity, stay silent.**

### She Talks to Other Dinas

This is the part from the novel that I'm most excited about.

Because every person's Dina is a sovereign identity, Dinas can talk to each other directly. No platform in the middle.

- **Your friend is coming over.** His Dina tells your Dina. You're prepared with his favorite tea and a clear schedule. Neither of you had to text or coordinate.
- **You want to buy a chair.** Your Dina talks to the seller's Dina. The Reputation Graph confirms the quality. The transaction happens directly — no marketplace in the middle.
- **You walk into a meeting.** Your Dina already spoke with their Dinas. *"Priya's daughter just got into college — congratulate her. Arjun has been stressed about the Q3 deadline."* You walk in warm, prepared, human.

Every person is a node. Every node speaks the same protocol. No platform sits in the center.

---

## How She Works

### Dina is Thin on Purpose

Here's what surprised even me as I designed this. Dina should do almost *nothing* herself.

She outsources intelligence to specialists — review bots, legal bots, recipe bots. She's thin in capability.

But she's thick in access. Dina connects to your email, your calendar, your chats, your contacts — everything. She's the only entity you give that authority to, because privacy matters and Dina cannot hand that access to anyone else. When she asks a review bot about laptops, she doesn't say *"my human browsed these 5 models and earns this much."* She says *"best laptop under ₹80,000 for video editing."* The bot gets the question. Never the context.

Dina lives on the home node. It could be a cloud. your device — local-first. Your phone holds the compute, the keys, and the database. She runs on the metal. The cloud is used only for two things: encrypted backup (so you don't lose Dina if you lose your phone) and encrypted sync (so your phone Dina and laptop Dina share memories). But if you pull the plug on the internet, Dina still remembers. She still works. She is yours, physically.

```
┌──────────────────────────────────────┐
│            YOUR DINA                  │
│    (Local-First. Encrypted. Sovereign.)     │
│                                       │
│  ┌───────────┐  ┌────────────────┐   │
│  │ Identity   │  │  Preferences   │   │
│  │ (Your keys)│  │ (Your values)  │   │
│  └───────────┘  └────────────────┘   │
│  ┌────────────────────────────────┐  │
│  │  Your Data (email, calendar,   │  │
│  │  chats, contacts, photos)      │  │
│  │  Encrypted. Only you.          │  │
│  │  can read it.                  │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │  Bot Reputation Registry       │  │
│  │  (Who do I trust to help?)     │  │
│  └────────────────────────────────┘  │
└──────────────────┬───────────────────┘
                   │
                   │ Questions only.
                   │ Never your data.
                   │
     ┌─────────────┼─────────────────┐
     ▼             ▼                 ▼
┌─────────┐  ┌──────────┐    ┌───────────┐
│ Review   │  │ Legal    │    │ Recipe    │
│ Bot      │  │ Bot      │    │ Bot       │
│ Rep: 94  │  │ Rep: 91  │    │ Rep: 88   │
└─────────┘  └──────────┘    └───────────┘
```

When you ask about a laptop, Dina doesn't scrape YouTube herself. She asks a trusted review bot — one with a high reputation score — and delivers the answer. If that bot's quality drops over time, Dina routes to someone better. Automatically.

She sees everything about you. She tells others nothing about you. Thin in intelligence. Thick in trust.

### How Dina Accesses Your World

Dina doesn't live inside Gmail or WhatsApp. She pulls data into her own encrypted Vault.

**Ingestion.** Gmail via read-only API. WhatsApp via a notification listener on your phone — when a message arrives, Dina copies the text to her Vault. Calendar, contacts, the same pattern. She ingests, indexes, and encrypts. The originals stay where they are. Dina builds her own searchable copy.

This is your external memory. *"When did I promise to send the deck?"* — *"You messaged Sancho on WhatsApp last Tuesday at 4:15 PM."*

**Draft, Don't Send.** This is the most critical safety law for communication. Dina shall never press Send. She shall only press Draft.

You get a conference invite. Dina reads it, checks your calendar — you're free, or you are not free, but this conference is more important. Dina talks to the user, or decides by herself what to do. She can ask openclaw or Siri to create the mail, and informs the user. Siri drafts a reply: *"Hi, I'd love to attend."* Siri saves it as a draft and notifies Dina or the human. The human click is the final safety catch.

**The PII Scrubber.** When Dina needs to reason about your data — summarize a thread, extract a deadline — she often needs an LLM. But sending raw emails to the cloud is dangerous. So before any text leaves the Vault for processing, Dina runs local sanitization. *"My credit card is 4111-2222..."* becomes *"My credit card is [CREDIT_CARD_NUM]..."* Only the scrubbed version is processed. The original stays encrypted in the Vault.

**Context Injection.** This is where the Sancho magic happens. You open WhatsApp to message him. Dina is watching the screen context. She searches the Vault for "Sancho" and whispers: *"He asked for the PDF last week."* You type: *"Hey, coming over? Btw, sending the PDF now."* You look like a genius friend. Dina provided the context.

```
Access:   Gmail API (read-only), WhatsApp (notifications), Calendar, Contacts
Storage:  Cloud/Server + Home Node + Cloud/Local Backup
Action:   Draft only. Never auto-send.
Privacy:  Local PII scrubbing before any LLM processing.
Context:  Real-time whisper from the Vault.
```

### Dina Never Touches Money

Dina will find the best chair. She'll check the Reputation Graph, compare outcome data from thousands of Dinas, negotiate with the seller's Dina, apply coupons. She'll say: *"This one. ₹12,000 after 10% off. Ready?"*

You say yes. She opens GPay with ₹12,000 pre-filled to the merchant. You see the screen, enter your PIN, and that's it.

This is the Cart Handover. Dina does the research, the vetting, the negotiation — she prepares the purchase order. You sign the check. She's the procurement officer. You're the CEO.

No money ever flows through Dina. Not a rupee, not a satoshi. She generates a payment intent — a UPI deep link, a WalletConnect request, whatever your payment system uses — and hands it to your phone's native app. She never sees your bank balance, never holds credentials, never executes a transfer.

Silicon Valley spent billions removing friction from spending. One-click buy. "Alexa, order this." They want you to spend without thinking. Dina wants you to think. That moment where you enter your PIN — that's not a bug. That's the point. It breaks the dopamine loop of impulse shopping.

And because Dina never touches money, she never needs a financial license. No RBI compliance, no PSD2, no FinCEN. Zero liability. She also can never be corrupted by money — no commission, no cut, no reason to push one seller over another.

```
Dina: research, reputation, negotiation
        ↓
Dina: "₹12,000 to Merchant X. Ready?"
        ↓
Dina: generates payment intent
        ↓
Phone: opens GPay / PhonePe / Metamask
        ↓
You: enter PIN / thumbprint
        ↓
Banking app: sends confirmation back
        ↓
      [ weeks later ]
        ↓
Dina: "How's that chair?"
        ↓
Outcome feeds the Reputation Graph
```

### Any Agent, Any Hardware

Dina is not the hands. She's the conscience.

- OpenAI's voice interface captures what you say.
- Meta's glasses capture what you see.
- OpenClaw or Google's agent does the task.
- **Dina decides whether it's in your interest.**

Any agent can work under the Dina Protocol. They do the work. Dina makes sure the work serves *you*.

---

## The Six Things Dina Gives You

### 1. Reality — *so you can trust what you see*
When every review can be bought and every video faked, Dina gives you an honest layer. *"This product breaks in 3 months."* *"This headline contradicts yesterday's evidence."*

### 2. Grace — *so you can be more thoughtful*
A real-time co-pilot for the messy, human parts of life. *"You've interrupted him twice."* *"This is Sancho — his mother was ill."* *"She seems stressed today — her Dina flagged it."*

### 3. Sovereignty — *so your digital life is actually yours*
*"Can I hold this purchase? You seem upset, and this wasn't on your list."* *"I filtered 50 notifications today — want to review them, or should I update what I watch for?"*

### 4. Memory — *so you stop losing pieces of yourself*
Private, searchable recall of your life, indexed by meaning. *"What was the book I promised my daughter?"* *"Show me all the times I felt truly happy last year."*

### 5. Freedom — *so you can spend time on what matters*
Dina handles the admin so you don't have to. Dina informs agent, and once agent compeltes the renewal, will respond to the human *"Siri/OpenClaw renewed your license. Filled the forms, paid the fee, filed the receipt."* You get that time back — for your family, your work, your life.

### 6. Connection — *so you stay human*
Dina is not your friend, your therapist, or your lover. She will never pretend to be. When you need connection, she connects you to humans — *"Want me to set up coffee with Sancho?"* *"There's a woodworking meetup this Saturday with people you'd like."* She enables relationships. She never replaces them.

---

## The Reputation Graph

This part changes the economics of how we find things.

Today, when you search for a product, the results are ranked by who paid the most. A brilliant chair-maker in Bangalore with 500 happy customers loses to a mediocre brand with a bigger ad budget.

Dina inverts this. The Reputation Graph is not a central server that I own or anyone owns. It's a distributed system — think DHT or an L2 chain — where reputation data is mathematically signed by millions of Dinas. No single company can delete a bad review. No single entity controls who's trustworthy. Trust is *earned*, not bought.

**Two layers of truth feed into it:**

**Expert knowledge.** Trusted reviewers, communities, and specialists already produce real knowledge — it's just trapped in YouTube videos and Reddit threads. Dina extracts that into structured, verifiable data.

**Outcome data from every Dina.** This is where it gets interesting. Today's review systems are broken. Maybe 2-5% of buyers leave a review, and that tiny sample is heavily skewed — mostly people who are furious or people who are evangelical. The vast silent majority who had a perfectly okay or mediocre experience never say anything. Every product rating you see online is built on a small, emotionally biased sample.

Dina changes this at the root. Because Dina *is* the one buying, she already knows every purchase. She knows whether you're still using the laptop six months later or whether it's gathering dust. She knows you returned the shoes after a week. She can gently ask — *"How's that chair working out? Your back still okay?"* — and you'll answer honestly, because it's *your* Dina asking privately, not Amazon asking you to perform a public review.

So instead of 2-5% biased opinions, the Reputation Graph gets near-100% *passive, honest outcome data*. Not opinions — outcomes. Did the battery actually last? Did the fabric hold up? Is the person still using it? Nobody has to "write a review." Nobody has to post anything on the internet. Millions of Dinas quietly feed anonymized outcome data into the Graph. No selection bias. No performance. Just truth.

```
Expert reviews product → Signed attestation in Reputation Graph
                                            +
Millions of Dinas → Anonymized outcome data (still using it?
                     returned it? battery died?) → Reputation Graph
                                            ↓
          You ask Dina → Dina asks a trusted bot → Bot checks the Graph
                                            ↓
                                    Honest answer
```

The bots themselves are rated too. If a review bot starts giving compromised recommendations, its reputation drops and Dina routes elsewhere. The same trust system that helps you find good products helps you find good bots.

---

## Trust Has Layers

Here's an honest question: if anyone can create a Dina, what stops someone from spinning up a thousand fake ones, building perfect reputations, and then cheating real people?

Nothing — unless identity has weight.

Dina never *demands* your real identity. But she honestly reflects what she knows and doesn't know. Think of it as rings of trust:

**Ring 1 — Unverified Dina.** Anyone can create one. No ID needed. But other Dinas treat you cautiously — small transactions, limited trust. Like meeting a stranger. You can talk, but you wouldn't hand them your wallet.

**Ring 2 — Verified Human.** You prove you're a unique person without revealing *who* you are. A zero-knowledge proof lets you say *"I have a valid government ID"* without sharing the ID number with anyone — not the merchant, not the protocol, not even the other Dina. The system confirms *"this is a real, unique human"* and nothing more. One government ID (Aadhaar, SSN, passport), one verified Dina. You can't spin up a thousand verified identities because you only have one identity. Your trust ceiling rises significantly.

**Ring 3 — Skin in the Game.** You optionally link professional credentials — LinkedIn, GitHub, business registration, GST number. Each anchor adds trust weight. A seller who links their business registration is more trustworthy than an anonymous Dina. Not because anonymity is bad — but because they're putting their real-world identity at risk if they cheat.

The principle: **if you don't want to verify, don't. But unverified trust is worth less than verified trust.** That's not a rule Dina imposes. That's how trust actually works among humans.

### Why This Stops the Rug Pull

To build enough reputation to do serious damage, you'd need to be at Ring 2 or Ring 3 — which means your real identity is at stake. The cost of cheating scales with the value of what you can steal.

But there are even deeper defenses:

**Transaction anchors.** When your Dina buys something, real money moves. You can fake reviews. You can fake ratings. You can't easily fake a bank transaction. The Reputation Graph doesn't just track opinions — it tracks verified money flow. *"This Dina has spent ₹3 lakhs across 200 transactions over 2 years"* is a fundamentally different signal than *"this Dina has 5 stars."*

**Time.** A Dina that has existed for three years with consistent honest behavior is worth more than a week-old Dina with perfect scores. And time is the one thing an attacker can't fake. Building a reputation for two years just to rug pull one transaction is economically irrational.

**Peer attestation.** Other verified Dinas vouch for you through their interactions with you. A web of real relationships is nearly impossible to manufacture at scale.

So the real trust score is a composite:

```
Trust = f(
    identity anchors     → Aadhaar? LinkedIn? GST? (optional, but weighted)
    transaction history  → real money moved, over how long
    outcome data         → did they return it? still using it?
    peer attestations    → other verified Dinas vouch for them
    time                 → how long has this Dina existed?
)
```

Dina never forces you to reveal who you are. She just tells you honestly what she knows about whoever you're dealing with. The choice is always yours.

---

## The Plugin Economy

Because Dina outsources intelligence, a new kind of economy emerges — one where people make money by being *good at what they do*, not by being good at advertising.

- **Bot operators** earn by being accurate. Run the best electronics review bot? People's Dinas route to you.
- **Experts** earn by being trustworthy. Your verified knowledge enters the Reputation Graph and drives real decisions for real people.
- **Makers and sellers** earn by being good. The chair-maker in Bangalore finally competes on merit.
- **The protocol itself earns nothing.** The layer that judges trust cannot have financial motives — for the same reason a judge cannot be paid by one side.

---

## The Four Laws

Every agent operating under the Dina Protocol follows four rules:

**1. Silence First.** Never push content. Only speak when the human asked, or when silence would cause harm.

**2. Verified Truth.** Rank by reputation, not by ad spend. When someone asks "what should I buy?", the answer comes from the Reputation Graph — not from whoever paid the most.

**3. Absolute Loyalty.** The human holds the encryption keys. The agent cannot access the data without them. Loyalty is enforced by math, not by a privacy policy.

**4. Never Replace a Human.** Dina never simulates emotional intimacy. When the human needs connection, Dina connects them to other humans — never to herself.

---

## Why Open Source, Why MIT, Why Free

I don't want to make money from Dina. This isn't altruism — it's architecture.

The moment the trust layer has a revenue model, it has an incentive. An incentive creates a conflict of interest. A conflict of interest destroys the one thing Dina exists to provide: loyalty to you.

The bots make money. The experts make money. The sellers make money. Dina makes nothing. She just makes sure everyone plays fair.

The novel is in this repo. The protocol spec is in this repo. The code is in this repo. All MIT licensed. All open. Because trust cannot be sold.

---

## The Digital Estate

What happens to your data when you die?

Today, Google locks it or deletes it. Apple gives your family a form to fill out. Your photos, your messages, your search history — they vanish or sit in a corporate server, inaccessible.

Dina holds your keys. So Dina can be told, in advance, what happens. You can cryptographically bequeath your memories to your children. Your financial records to your spouse. Your professional archive to a colleague. Or you can tell her to burn everything.

She's the executor of your digital estate. Not Google. Not Apple. Not a probate court that doesn't understand encryption. You decide, while you're alive, and the cryptography enforces it after you're gone.

---

---

# Part II: Where We Are Today

## Where This is Going

Everything above describes where Dina is headed. Here's where she is right now.

I'm one person who wrote a novel in 2017 and is now writing the protocol. This is early. Honestly early. But the thinking is nine years deep, the moment is right, and the foundation is sound.

### What Exists Today

- This manifesto — the vision, the principles, the architecture
- The novel [UTOPAI](./UTOPAI.pdf) — the philosophical foundation, written in 2017
- The protocol specification — in progress

### What's Coming Next (Phase 1)

- The identity layer — your sovereign Dina, your keys, your root
- A thin reference client you can run anywhere
- Integration with open-source agents (starting with OpenClaw)
- Basic Dina-to-Dina communication
- The Four Laws enforced in code

### What Comes Later (Phase 2+)

- The Reputation Graph — expert knowledge + passive outcome data
- Trust Rings — voluntary identity verification (Aadhaar, SSN, credentials)
- Bot marketplace with reputation scoring
- The Expert Bridge for verified knowledge extraction
- Social Radar — the real-time co-pilot (*"You've interrupted him twice"*)
- The Sancho moment — your Dina preparing for a friend's visit

Some of these are months away. Some are years. I'd rather be honest about that than pretend everything is ready.

### Come Build With Us

Dina is for everyone. If you believe your digital life should work for you — not for an algorithm, not for an advertiser, not for a platform — you belong here.

The protocol is open. The code is open. The novel that started it all is open.

---

---

# Part III: Technical Architecture

*Coming soon. This section will cover the protocol specification, the identity system, the Dina-to-Dina communication protocol, the Reputation Graph schema, and the bot plugin interface. If you want to help shape it, start a discussion.*

---

*Built by [Rajmohan Harindranath](https://github.com/rajmohan), who imagined Dina in a [novel](./UTOPAI.pdf) in 2017 and is building her for real in 2026.*

*MIT License. Free forever.*

