# What Dina Does For You

> *Current Status. What you can do right now if you install Dina.*

---

## She Remembers Everything

Tell Dina anything (in telegram). She stores it, classifies it, and recalls it when you need it.

```
You:
/remember My daughters name is Emma
Dina:
Stored in General Vault
/remember My daughter loves dinosaurs
Dina:
Stored in General Vault
```

You can ask questions
```
You:
/ask What does Emma like?
Dina:
Emma loves dinosaurs
```

Dina sets reminders for you automatically based on your messages
```
You:
/remember Emma's birthday is on Nov 7th

Dina:
Stored in general vault.
Reminders set:
[87b5] 🎂 Nov 06, 10:00 AM — Emma's birthday is tomorrow, you may want to buy a dinosaur-themed gift.
[2c9d] 🎂 Nov 07, 09:00 AM — It is Emma's birthday today, you may wish to contact her.
```

## She is secure

- **General** — recipes, hobbies, family, preferences. Open.
- **Work** — meetings, colleagues, projects. Open.
- **Health** — medical records, allergies, test results. Locked until you approve.
- **Finance** — bank accounts, savings, investments. Locked until you approve.

Each of these is a separate encrypted vault. Health data cannot leak into your general profile. Finance data stays in its own compartment. Dina's query system (LLM Brain) does not have access across different vaults. Core has to provide access.
```
You:
/remember My friend James loves craft beer
Stored in general vault.

You:
/remember My bank account is in Barclay's and ends with 0102
Dina:
Stored in finance vault.

You:
/remember My HbA1c is 9%, very high
Dina:
Stored in health vault.
```
You are able to access these vaults without authorisation because you are the owner (telegram channel) is considered safe.

But, when your agent wants to use/update this data, it requires approval depending on the vault.
Agent uses dina cli tool (pip install dina-agent) to extract / remember data (agents have to create sessions).

```
(.venv) ~/dina % dina session start
  Session: ses_55s3khhq55s3 (SName-25Mar0728:22) active
(.venv) ~/dina % dina ask --session ses_55s3khhq55s3  "Which bank has my account" 
I don't have access to your bank account details.
```

Approval comes to telegram and user approves
```
🔐 claw-agent wants to access health
[Approve] [Deny] [Approve Once]
✅ Approved: apr-1774423823840426930
```

Agent can query that questions status to get the answer. Also, further questions in that session related to finance will be allowed
```
(.venv) ~/dina % dina ask --session ses_55s3khhq55s3  "Which bank has my account"
Your account is with Barclay's (ending in 0102).
  req_id: 55e828fcf816
```


---

## She Talks to Other Dinas

Dina can talk to other Dinas. On its own, or at the behest at the owner. Currently, owner based communication is supported.

Here, Sancho tells his Dina to inform Alono's Dina. Alonso's Dina notifies, and then creates reminder containing pertinent information.

```
Sancho:
/send Alonso: I will be reaching your home in 30 minutes
Sancho's Dina:
Sent to Alonso: 📬 Presence I will be reaching home in 30 minutes

Alonso gets notification:
Alonso's Dina (message 1):
📬 Sancho — arriving: home

(message 2)
Reminders set:
[d444] 📅 Mar 25, 11:14 AM — Sancho is arriving at home in 30 minutes. He enjoys cardamom tea and his mother has been unwell, so you may wish to ask how she is doing.
[Delete] [Edit]
```

### Seven message types

Dina-to-Dina uses typed messages. Not free-form chat. Each type has a purpose.

- **Presence signal** — "I'm arriving in 10 minutes." Ephemeral. Never stored.
- **Coordination request/response** — "Lunch Saturday at 2pm?" / "Sounds good." Ephemeral.
- **Social update** — "My daughter turns 7 next week." Stored in recipient's vault as a relationship note. Next time they ask "What should I get?", their Dina knows.
- **Trust vouch request/response** — "Is Marcus trustworthy?" Requires your approval before sending.
- **Safety alert** — "did:plc:xyz is a scam." Always passes. Cannot be blocked.

### You control what each person can send you

For every contact, you decide what's allowed.

```
Presence:     allowed / blocked
Coordination: allowed / blocked
Social:       allowed / blocked
Trust vouch:  requires your approval each time
Safety:       always on (cannot be turned off)
```

Example: A noisy colleague keeps sending social updates you don't care about. Block social for that contact. Their meeting proposals still come through.

If someone not in your contacts sends you a message, it's quarantined — flagged but not deleted. You review it later.

### Reminders fire to Telegram

When a reminder's time arrives, Dina sends it to your Telegram.

```
🎂 Emma's birthday is tomorrow — you may want to buy a dinosaur-themed gift.
```

You can edit or delete any reminder using the buttons that came with it.

---

## She Scrubs Your Privacy

All internal LLM calls go with scrubbed information. Agents can also use Dina to get scrubbed information. 

```
(.venv) ~/dina % dina scrub "Call me at 9876543210 or email tom@example.com. My SSN is 123-45-6789"                                     
scrubbed: Call me at [PHONE_1] or email [EMAIL_1]. My SSN is [SSN_1]
pii_id: pii_1bc95fcc
req_id: c5584fa642cb
(.venv) ~/dina % dina rehydrate --session pii_1bc95fcc "Important to call [PHONE_1] or email [EMAIL_1] about [SSN_1]"
restored: Important to call 9876543210 or email tom@example.com about 123-45-6789
```

After the AI responds, Dina rehydrates the original values to memorise the results.

---