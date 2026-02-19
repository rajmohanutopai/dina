# Dina — Your Personal AI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: Phase 1](https://img.shields.io/badge/Status-Alpha-orange)]()
[![Stack: Go + Python](https://img.shields.io/badge/Stack-Go%20%7C%20Python-blue)]()
[![Discord](https://img.shields.io/badge/Discord-Join%20Us-purple)](https://discord.gg/gDRcrEwy)

> **Dina is a sovereign personal AI that watches your world, breaks silence only when it matters, and never works for anyone but you.**

---

### ⚡ Developer Cockpit

* **Quick Start:** [3 commands to get Dina running](./QUICKSTART.md)
* **The Stack:** Go Core + Python Brain (Sidecar Pattern) + SQLite/SQLCipher.
* **The Architecture:** [Read the Engineering Spec](./ARCHITECTURE.md)
* **Advanced Setup:** [Local LLM / Networking / Yggdrasil](./ADVANCED-SETUP.md)
* **The Roadmap:** [Build Roadmap with Status Tracking](./ROADMAP.md)
* **Discussion:** [Join the Discord](https://discord.gg/gDRcrEwy)

---

You can run the full Sovereign Triad (Core + Brain + Local LLM) with one command. See [`QUICKSTART.md`](./QUICKSTART.md) for the full guide including networking setup.

**Prerequisites:** Docker & Docker Compose.

```bash
# 1. Clone and start
git clone https://github.com/rajmohanutopai/dina.git && cd dina
docker compose up -d

# 2. Initialize your identity (generates Root DID + encryption keys)
curl -X POST http://localhost:8100/v1/identity/init

# 3. Go online (Tailscale Funnel — zero-config public endpoint)
sudo tailscale up && sudo tailscale funnel 443
```

---

# Part I: The Vision

> *In 2017, I wrote a novel called UTOPAI - about AI Utopia. The novel is open source and is available [HERE](https://github.com/rajmohanutopai/utopai/blob/main/UTOPAI_2017_full.pdf). The novel envisaged a world where every person had a personal AI named Dina. She wasn't a search engine or a chatbot. She was your personal AI — she knew your friends, remembered your promises, whispered helpful things when you needed them, and talked to other Dinas so life just... worked better. This repository is an attempt to build her.*
---

## What is Dina?

Imagine this. Your friend Sancho is coming over for tea. As he leaves his house, his Dina quietly lets your Dina know. Your Dina remembers that Sancho's mother was unwell last time you met. She reminds you to put the kettle on — he likes his tea strong. And suggests clearing your calendar for the next two hours.

You open the door. You ask about his mother. Sancho smiles. "She is fine, thank you for asking".

That's Dina. Not an app or a chatbot or a multi-purpose agent. Dina is a personal agent that makes you more thoughtful, more present, and more human.

Now imagine the same thing, everywhere in your life:

- You're buying a laptop. Your Dina talks to the review bots, checks the Reputation Graph, and tells you: *"The battery on this one dies in three months. Here's a better option."*
- You promised your daughter you'd read her a book. You forgot which one. *"It was 'The Little Prince'. Last Tuesday."*
- Your license needs renewal. You didn't even know it was due. Dina did. She flags it, and if you approve, she delegates the paperwork to a task agent (like OpenClaw, Siri, or Google) to handle the forms.
- Dead internet theory becomes real. You lose every bit of fun because you don't know what is true and what is not. You can ask Dina then to filter out and show you only verifiably true items. Your Dina interacts with verified builders Dina, and only those items are shown to you.

Dina is the agent that does what you *need*. She is there for you, and only for you. She's quiet most of the time. And there when it matters.

---

## Dina is You

**Dina is your digital identity.** 

Today, you don't own your digital self. Your Google account, Apple ID, and LinkedIn profile are not really yours. They are accounts that companies let you use. If Google bans you tomorrow, or a company goes belly up, that account disappears. You are a tenant everywhere. Landlord nowhere.

Dina changes this. Your Dina is your *sovereign digital self*. You hold the encryption keys and the data. You own it completely. You control who sees what. Everything mentioned above — the memory, the preferences, the Dina-to-Dina communication, the purchases, the reputation — is possible because of this foundational principle: *you own you*.

If you delete your data, it's truly gone. Not archived. Gone. Because you control the data, and no one else ever had the keys.

### One You, Many Faces

In real life, you wear many hats. At work, you are a consummate professional. At home, a funny, jolly parent. At the store, a friendly but cynical buyer. With a doctor, an open and serious patient. These aren't fake identities — they're different facets of the same person, shared in different contexts.

Dina mirrors this. One root identity — you, the human, the keys. But multiple *personas* that reveal only what each situation needs.

* When your Dina talks to a seller's Dina, the seller sees: *verified real person, valid payment, wants to buy a chair.* No other information is provided.
* When you handle your license renewal, Dina presents your full legal identity to the government agent.

This is not just a preference setting. If it were just a setting, a malicious system could jailbreak it. To avoid this, each persona is a separate cryptographic compartment. No external system can ever see anything about you unless Dina explicitly shares it for that specific interaction. Even Dina herself cannot move data between compartments without authorization.

---

## The Missing Piece: Loyalty

For a Utopia driven by AI, it is important to have the deeply personal, deeply friendly AI, at our fingertips.

Personal AI agents have already arrived. OpenClaw is a brilliant invention. Apple, Google, OpenAI, and Meta are all building agents that live on your devices, hear what you say, and see what you see. This is wonderful and inevitable.

But there's a missing piece. These agents are smart and capable, but they don't have a **loyalty framework**. 

When the agent from these big players recommends a product, is it because the product is genuinely good - or is it because someone paid for the placement? When it reads our messages, it is not fully for us, right? Maybe the end idea is to show an idea based on your current interests. OpenClaw, being open source, has no such issue, but it is a "Task Agent" — it executes commands, but it lacks the framework to be your fiduciary guardian. 

The idea behind Dina is to become that missing piece. She's an open protocol — a set of rules that any agent can adopt to become genuinely, verifiably *ours*. Looking from that perspective, Dina doesn't compete with OpenClaw or Google or Apple. She makes all agents *loyal*.

Dina is open source, trustworthy, and incorruptible. There is no conflict of interest, and the data is mathematically safe.

**Dina is also Anti-Her.**

Dina also has to be anti-HER (HER - 2013 movie). She cannot become our emotional crutch. I see the world racing towards building AI that loves us (or acts as such), and the risk of that is that it will end up replacing our human relationships. In the novel *UTOPAI*, the realisation the protagonist comes up with is that meaning of anything is in its relationships (proved via socratic discourse in the novel, and now borne out by the growth of LLMs), and thus, the meaning of our life is in our relationships with others. Thus, Dina actively avoids becoming our emotional companions. If she feels that we are yearning for companionship, she should connect us to friends, relatives, others of similar interests.

---

## How Dina Thinks

### She's Quiet First

Most of digital life is noise. Dina's default state is silence. She classifies everything into three tiers:

| | Type | What Dina Does | Example |
|---|------|---------------|---------|
| **Tier 3** | Engagement | Stays silent. Saves it for daily briefing. | *"New video from MKBHD"*, *"Flash sale on shoes"* |
| **Tier 2** | Things we asked for | Notifies you. You asked for this. | *"Wake me at 7 AM"*, *"Tell me if Bitcoin hits $100K"* |
| **Tier 1** | Fiduciary | Interrupts. Silence would cause harm | *"This contract is malicious. Stop."*, *"Phishing attempt."* |

The rule: **if staying silent causes harm, speak. If staying silent merely causes a missed opportunity, stay silent.**

### She Talks to Other Dinas


Because every person's Dina is a sovereign identity, Dinas can talk to each other directly without a platform in the middle. Similar to Signal.

- **Friend comes over.** His Dina tells your Dina. You prepare his favorite tea. Neither of you had to text or coordinate.
- **Buying a chair.** Your Dina talks to the seller's Dina. The Reputation Graph confirms the quality. The transaction happens directly, no marketplace in the middle.

---

## How Dina Works

### Dina is Thin on Purpose

Dina is a thin service. She outsources intelligence to specialists like review bots, legal bots, recipe bots, or general purpose bots like OpenClaw.

**Dina has no plugins.** No third-party code runs inside Dina's process — ever. Child agents (OpenClaw, review bots, legal bots) are external services that communicate with Dina via MCP (Model Context Protocol). If a child agent gets compromised, it cannot touch your vault, your keys, or your data — it's an external process that Dina can disconnect. This is the "kernel, not platform" design: Dina is the brain, child agents are the hands.

She prioritizes access. Dina connects to email, calendar, chats, contacts. She's privacy-first, and thus is the only entity you give that authority to. Because privacy matters, Dina cannot hand that access to anyone else. All other systems get just the requirement, never the raw data.

Dina is the safety layer for autonomous agents. Just this year, security researchers found hundreds of thousands of AI agent instances exposed to the internet — leaking credentials, accepting commands from anyone, with no oversight. Dina fixes this at the protocol level. When you interact with an autonomous agent or when an autonomous agent wants to act on your behalf, Dina watches. She doesn't interfere with safe tasks. But when an action agent wants to send an email, move money, or share your data, Dina checks: does this violate your privacy rules? Is this vendor trusted? Are you in the right state to make this decision? If everything is fine, it goes through - otherwise, it is flagged for review. To implement this, an agent supporting the Dina protocol will submit the intent to Dina. Dina checks:  If everything checks out, Dina approves. If not, she flags it for your review. The agent never holds your keys, never sees your full history, and never acts without oversight. Regardless of the autonomous agent doing the work, the safety layer stays the same. 

Dina runs on a **Home Node** — a small, always-on server that is yours. For the privacy minded, it might be a cheap VPS or a Raspberry Pi. For others, it could be a managed service you sign up for (like ProtonMail or Signal). The vault is a single encrypted file which can be moved between any of these options anytime.

```
┌──────────────────────────────────────┐
│          DINA HOME NODE              │
│    (Managed service / VPS / Pi)      │
│    (Always-on. Encrypted. Sovereign.)│
│                                      │
│  ┌───────────┐  ┌────────────────┐   │
│  │ Identity  │  │  Preferences   │   │
│  │ (keys)    │  │ (values)       │   │
│  └───────────┘  └────────────────┘   │
│  ┌────────────────────────────────┐  │
│  │   Data (email, calendar,       │  │
│  │  chats, contacts, photos)      │  │
│  │  Encrypted. our keys only.     │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │  Bot Reputation Registry       │  │
│  │  (Who do I trust to help?)     │  │
│  └────────────────────────────────┘  │
└──────────────────┬───────────────────┘
                   │
                   │ Questions only.
                   │ Never our data.
                   │
     ┌─────────────┼─────────────────┐
     ▼             ▼                 ▼
┌─────────┐  ┌──────────┐    ┌───────────┐
│ Review  │  │ Legal    │    │ Recipe    │
│ Bot     │  │ Bot      │    │ Bot       │
│ Rep: 94 │  │ Rep: 91  │    │ Rep: 88   │
└─────────┘  └──────────┘    └───────────┘
```


When one asks opinion about a laptop, Dina doesn't scrape YouTube herself. She asks a trusted review bot with a high reputation score and delivers the answer. If that bot's quality drops over time, Dina routes to someone better automatically.


### Some principles

**Ingestion:** Mail, Calendar, etc., are read via read-only APIs. Dina creates a local vector store to build a searchable copy of your life.

**The PII Scrubber:** All external requests go through a PII Scrubber. Your raw data never leaves the Home Node.

**Dina Never Touches Money:** Dina helps find the best laptop. She checks the Reputation Graph. When you're ready, she hands back control to you — the "Cart Handover." She is an advisor, not the decision maker.

**Any Agent, Any Hardware** Any agent (OpenAI pin, Meta Glasses) can interact with Dina. Preferably, agents should - because Dina enforces loyalty. Dina makes sure the work serves *you*.

---

## The Six Things Dina Gives Us

### 1. Reality  *so you can trust what you see*
When every review can be bought and every video faked, Dina gives you an honest layer. *"This product breaks in 3 months."* *"This video is real, not AI generated."*

### 2. Grace  *so you can be more thoughtful*
A real-time co-pilot for the messy parts of life. (you decide the level of interaction)
 *"Looks like he is getting heated up - I think it is because you've interrupted him twice already."* *"This is Sancho — his mother was ill."* 

### 3. Agency 
Buffer against possible wrong decisions or manipulation.
*"Can I hold this purchase? You seem upset, and this wasn't on our list."* *"Don't buy this shampoo - the ads are deceptive. The other one is better for your hair."*

### 4. Memory — *so you stop losing pieces of yourself*
Private, searchable recall of your life, indexed by meaning. *"What was the book I promised my daughter?"* *"Show me all the times I felt truly happy last year."*

### 5. Freedom — *so you can spend time on what matters*

Dina notices what you'd otherwise miss. *"Your license expires next week. Can I send it to the renewal agent?"* She watches your life and catches what falls through the cracks, removing the noise so you can focus on living.

### 6. Connection — *so you stay human*

Dina is warm, loyal, and devoted, but she is not your friend or your lover. She will never pretend to be. When you need connection, she nudges you toward humans — *"You haven't talked to Sancho in a while."* She reminds you of the relationships that matter. She never replaces them.
---

## The Reputation Graph

Today, when you search for a product, the results are ranked partly by who paid the most. A brilliant but non-descript chair-maker with 500 happy customers loses to a mediocre brand with a bigger marketing budget.

Dina inverts this. The Reputation Graph is a system where trust is earned, not bought.

**Two layers of truth feed into it:**

**Expert knowledge.** Trusted reviewers, communities, and specialists already produce real knowledge. In YouTube videos and Reddit threads. Dina can talk to agents which extracts that into structured, verifiable data. 

**Outcome data from every Dina.**  Today's review systems is not perfect. Less than 5% of buyers leave a review, and that tiny sample is heavily skewed - either they are furious or they are evangelical. The vast majority who had a perfectly okay or mediocre experience never say anything. Product ratings we see online are built on a small, emotionally biased sample.

Dina changes this at the root. Because Dina *is* the one buying, she already knows every purchase. She knows whether you're still using the laptop six months later or whether it's gathering dust. She knows you returned the shoes after a week. She can gently ask — *"How's that chair working out? Your back pain has reduced?"*, and you'll answer honestly, because it's *your* Dina asking privately, not Amazon asking you to perform a public review.

So instead of 2-5% biased opinions, the Reputation Graph gets a high percentage of *passive, honest outcome data*. These are not opinions, since they are actual outcomes. For example: Did the fabric tear? Did it lose colour? etc. There is no real need for a review - since millions of Dinas quietly feed anonymized outcome data to the Reputation Graph. This gives real truth in the system a higher chance to come out.

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

The reputation graph extends to the bots, other Dinas, everywhere. If a review bot starts giving compromised recommendations, its reputation drops and Dina routes elsewhere. The same trust system that helps you find good products helps you find good bots.

---

## Trust Has Layers

If anyone can create a Dina, what stops someone from spinning up a thousand fake ones, building perfect reputations, and then rug pulling?

One possible solution that we will implement is identity based trust layers. Dina will not *demand* your real identity. But she decides on the reputation based on what she knows and doesn't know. Consider it as multiple rings of trust:

**Ring 1 — Unverified Dina.** Anyone can create one - without any need for an ID. But other Dinas treat you cautiously. Only small transactions, limited trust. Like normal humans while meeting a stranger, Dina will be polite, but very cautious.

**Ring 2 — Verified Dina.** Dina knows you are a unique person, without you revealing *who* you are. Governments have started implementing ZKP (zero-knowledge proof), which we could use. For countries without ZKP, we can also use an external system to prove the identity without explicitly knowing about the person. Since you can't spin up multiple identities, your Dina's position in Reputation Graph rises significantly.

**Ring 3 and beyond — Verified and Actioned.** If we add multiple credentials, like LinkedIn, GitHub, business registration number etc, each anchor increases trust weight. A seller who links their business registration is more trustworthy than an unverified or just verified Dina. This is because he/she is putting her business at risk if he/she does not complete a transaction. Same way, if you do multiple actions (buying items etc), again, your actions are considered in the reputation graph. *"This Dina has spent $20K  across 200 transactions over 2 years"* is a fundamentally different signal than *"this Dina has 5 stars."*. The probability of such a person doing a rug pull is lower. Thus, **transaction**, **time** and **peer approval/attestaion** all increases the trust on your Dina.

The principle: **if you don't want to verify, don't. But unverified trust is worth less than verified trust.** This is not a big brother rule - this is a societal behaviour which we will try to implement in Dina.

So the real trust score is a composite:

```
Trust = f(
    identity anchors     → Aadhaar? LinkedIn?  (optional, but weighted)
    transaction history  → real money moved, over how long
    outcome data         → did they return it? still using it?
    peer attestations    → other verified Dinas vouch for them
    time                 → how long has this Dina existed?
)
```


---

## The Merit Economy

Because Dina uses Reputation Graph, a new kind of economy can possibly emerge — one where people make money by being *good at what they do*, not solely dependent on marketing.

- **Makers and sellers** earn by being good. The smaller players competes on merit.
- **Bot operators** earn by being accurate. The best review bots, the best legal bots, etc gets paid more.
- **Experts** earn by being trustworthy. our verified knowledge enters the Reputation Graph and drives real decisions for real people.
- **The protocol itself earns nothing.** Completely P2P and anyone should be able to run this. 


### The Ethics of Value (Not Policing)

Dina cannot be a "Nanny AI" who corrects you on ethics. But if Dina does not provide value back, it will starve the people who creates value. If Dina extracts answers from a YouTuber without sending traffic back, that creator eventually stops making videos. The ecosystem dies. Therefore, Dina’s **default** behavior is designed to be fair. You can update Dina's value systems in the way that suits you.

**1. The "Deep Link" Default**
By default, Dina is configured to be a **Discovery Engine**, not just an extraction engine.
* For a laptop review, rather than saying, *"The battery is bad."*, she says, *"MKBHD says the battery is bad. Can you check the stress test result at 04:20. Here is the link."* instead.

This turns a "lost view" into a "high-quality view." You get the answer instantly, but the creator gets the traffic when you click to verify. 

**2. The Future: Direct Value Exchange**
In the future Open Economy, Dina could even correctly evaluate the value created, and generated by individual reviewers and the like. This will allow direct value exchange in the future.

**3. Your Sovereignty (The Override)**
Because Dina is yours, you have the final say.
* **Default:** The system prompt instructs Dina to always prioritize sources that provide deep links and credit.
* **Custom:** You can change this prompt. You can decide on the prioritisation logic.

---

## The Open Economy

Once Dina becomes proficient, she could restore the open economy. Walled gardens like Amazon provides attention, comparisons, trust and ease of use. Because Dina is a sovereign agent, she can transact via open protocols (like ONDC, UPI, and crypto). She negotiates directly with the manufacturer's Dina for the product, and the logistics provider's Dina for the delivery.

If a walled garden gives the best value, they still win. But now, you have options.

---

## Why Open Source

Every function of Dina, every line of code, has to be open and incorruptible. Dina holds your most important data, and acts in your place in many cases. She must be transparent. Her private memory must be mathematically secure, while her public interactions remain open. 

There cannot be any walled garden, no single owner, corporation, or nation-state running Dina. Without that, she is just another multi-tasking personal agent. With it, she is **you**.

---

## Come Build With Us

Dina is for everyone. If you believe your digital companion should work for you, and you alone, come, join us, in building this future.

---

# Part III: Technical Architecture

*See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full engineering blueprint.*
*See [SECURITY.md](./SECURITY.md) for supply chain security (image signing, digest pinning, SBOM).*
*See [Build Roadmap with Status Tracking](./ROADMAP.md) for project status.*

---

*Built by [Rajmohan Harindranath](https://github.com/rajmohanutopai), who imagined Dina in a [novel](https://github.com/rajmohanutopai/utopai/blob/main/UTOPAI_2017_full.pdf) from 2012-2017 and is building her in the open for real in 2026.*

*MIT License. Free forever.*
