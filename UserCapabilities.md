# What Dina Does For You

> *What works today. Not the roadmap. What you can do right now if you install Dina.*

---

## She Remembers Everything

Tell Dina anything. She stores it, classifies it, and recalls it when you need it.

```
You:  My daughter Emma turns 7 on March 25. She loves dinosaurs and painting.
You:  Dr. Chen said my B12 is low. Supplements for 3 months. Next checkup June 15.
You:  Barclays savings has 12000 pounds. Rent 1500 due on the 5th.
You:  Grandma's roast recipe: season overnight, 180C for 3 hours, rest 30 minutes.
```

Later:

```
You:   What would be a good birthday gift for my daughter?
Dina:  Emma turns 7. She loves dinosaurs and painting. A dinosaur art kit would be perfect.

You:   When is my next checkup?
Dina:  June 15, with Dr. Chen. Your B12 was 180 — supplements for 3 months.

You:   How much is in my savings?
Dina:  Your Barclays savings has £12,000. Rent of £1,500 is due on the 5th.
```

Dina doesn't just store text. She understands what kind of information it is and puts it in the right place:

- **General** — recipes, hobbies, family, preferences. Open.
- **Work** — meetings, colleagues, projects. Open.
- **Health** — medical records, allergies, test results. Locked until you approve.
- **Finance** — bank accounts, savings, investments. Locked until you approve.

Each of these is a separate encrypted vault. Health data cannot leak into your general profile. Finance data stays in its own compartment. Not by policy — by cryptography.

---

## She Talks to Other Dinas

This is where it gets interesting. Your Dina talks to the Dinas of people you know — directly, encrypted, with no platform in the middle. Not free-form chat. Specific, structured interactions that make daily life smoother.

### Your friend is on the way

James is coming over. As he leaves his house, his Dina quietly tells your Dina.

Your Dina checks what she knows about James — his mother was unwell last time you met, and he likes his tea strong. She sends you a notification:

> *"James is 5 minutes away at The Corner Cafe. His mother was unwell last week — you might want to ask how she's doing. He likes Earl Grey, strong."*

You didn't ask for this. She just knew it was the right thing to surface. That's the Sancho Moment from the novel — the reason Dina exists.

### Coordinating plans

James proposes dinner.

```
📬 James — propose_time: Curry at The Bengal tonight?
```

You see this on your phone. You tap to accept, decline, or counter-propose. Neither of you had to open a chat app, negotiate times, or deal with group messages. Dina-to-Dina coordination. Done.

These are ephemeral — not stored. Just real-time coordination between two people.

### Sharing life updates

You tell James's Dina that Emma's birthday is coming up.

His Dina stores it. Next time James asks *"What should I get for Tom's daughter?"*, his Dina answers: *"Emma turns 7. She loves dinosaurs and painting."*

James walks in with a dinosaur art kit. Emma is thrilled. Neither of you had to remember to tell the other. The Dinas handled it.

### Trust and vouching

You're buying a chair from Marcus online. You don't know Marcus. But James does.

Your Dina asks James's Dina: *"Is Marcus trustworthy?"*

But this is sensitive — your Dina won't send it without your approval. You get a notification: *"Dina wants to ask James about Marcus. Approve?"* You tap approve. The question goes.

James's Dina responds: *"Known him 10 years. Excellent craftsman."* Your Dina stores this as a trust attestation. Now you know Marcus is real, verified by someone you trust.

### Safety alerts

James discovers a scam. His Dina immediately warns yours:

```
🚨 Safety Alert (critical): did:plc:xyz is compromised — phishing scam
```

Safety alerts always get through. Even if you've turned off every other notification from James, safety alerts bypass all filters. They're too important to block.

### You control what each person can send you

For every contact, you decide what's allowed:

- **Presence** — let them signal when they're nearby. Or don't.
- **Coordination** — let them propose plans. Or don't.
- **Social updates** — let them share life events. Or don't.
- **Trust vouching** — requires your explicit approval each time.
- **Safety alerts** — always on. Cannot be turned off.

A noisy colleague keeps sending you social updates? Turn off social for that contact. Their meeting proposals still come through. You're in control, per person, per interaction type.

### Unknown people

Someone not in your contacts sends your Dina a message? It's quarantined — flagged but not deleted. You can review it later and decide whether to add them as a contact. Nobody gets through to your inbox without being either a contact or explicitly reviewed.

---

## She Guards Your Agents

AI agents are becoming part of daily life — fetching emails, booking appointments, researching purchases. These agents are powerful, but they act on your behalf with access to your data. Who watches them?

Dina does.

Any AI agent that integrates with Dina submits its intent before acting. Safe things — like searching for a chair — go through silently. But when an agent wants to send an email, access your health records, or share data with an external service, Dina flags it.

You get a notification on your phone: *"Your agent wants to access your health records. Approve?"*

You tap approve or deny. The agent never holds your keys. It never sees your full history. It only gets what you explicitly allow, for that specific task, in that specific session.

When the session ends, all access is revoked. A compromised agent in one session cannot touch data from another.

---

## She Scrubs Your Privacy

Every time your data needs to pass through a cloud AI (for reasoning, summarisation, or analysis), Dina scrubs personally identifiable information before it leaves your Home Node.

Phone numbers become `[PHONE_1]`. Email addresses become `[EMAIL_1]`. Government IDs are replaced with opaque tokens. The cloud AI never sees your real data — it works with anonymised tokens.

After the AI responds, Dina rehydrates the original values. You see the real answer. The cloud saw nothing real.

---

## She Lives on Your Machine

Dina runs on a Home Node — a small, always-on server that you own. It could be a cheap VPS, a Raspberry Pi, or a managed service. Your data never leaves this machine unless you explicitly allow it.

Every persona is a separate encrypted database. Your keys are derived from a recovery phrase that only you have. If you lose your machine, you can restore everything from that phrase on a new one.

You can run multiple Dinas on different machines under the same identity. You can export your data completely. You can delete it — and it's truly gone, because nobody else has the keys.

---

## How You Interact With Her

Dina speaks through whatever channel you connect. Today, that's Telegram — the same app every AI agent already uses. You send her commands, she responds. She sends you notifications, you tap to act.

```
/ask     — ask Dina anything. She searches your vaults and reasons over the answer.
/remember — tell Dina something to store. She classifies it and puts it in the right vault.
```

That's it. Two commands. Everything else — the encryption, the persona classification, the D2D messaging, the agent safety checks, the PII scrubbing — happens invisibly behind those two words.
