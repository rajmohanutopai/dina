1. dina is a personal ai whose primary focus is you

2. mobile is its own home node. as in, the mobile app dina is completely self sufficient - it is not a UI layer - the whole home node is in the mobile

3. the functionality supported by dina are ask, remember, task, talk, peerlens, reminders, security, approvals and services
3.1.  functionality 1  - remember  - ask dina to remember something and dina will remember. dina can add to memory, even if it is a normal convo and something feels like it should be remembered. the memory (vault) can be open (general), or locked (health, finance etc). dina classifier will clasiffy the item to remember and put it to appropriate vault. since it is being asked by the user, there is no further approval required even if it is a locked vault.   1. Personas are user-configurable — general/work/health/finance are just defaults, users can add or delete. Any code that hardcodes a persona list (like classifyDomain's DOMAINS array, or my old
  2. Cross-domain synthesis is the actual goal — "appropriate dinosaur toy" requires merging Emma-preferences (general) with budget-state (finance) with maybe schedule-state (work). The multi-persona walk is
  necessary, not over-engineering.

3.2.  functionality 2  - ask  - this is normal chat. dina can do actions for you or bring some information back from memeory. dina mobile is considered safe space (asked by the user), there is no further approval required even if it is a locked vault
3.3.  functionality 3  - reminders  - if i ask dina to remember that Emmas birthday is on May 7th - it will automatically create a reminder on May 6th reminding me to buy dinosaur themed toys because dina remembers that Emma loves dinosaurs. basically reminders are created automatically based on discussion and it also brings additional information from the vaults which are pertinent for the reminder
3.4.  functionality 4  - task  - if you have openclaw or hermes or other agent integration, you can give dina a task. dina will connect with openclaw using dina-agent cli tool, and get the action done. dina-agent cli tool will connect to your dina using msgbox cloud service. extremely important - dina never connects to the openclaw system straight - it always goes through msgbox cloud service. similarly, extremely important - dina never does any function other than the ones listed in here - anything more , it uses the openclaw system connected to it
3.5.  functionality 5  - talk  - your dina can talk to other peoples dina through a Ed25519 encrypted channel. this is also done through msgbox cloud service, so neither of you need public ip. currently, you can ony talk to the other person if both of you have each other in contacts. dina talk is not a normal talk - it will do extra functionality which is normally expected. so, if I (Alonso), tells the other person (Sancho), that i am coming tomorrow morning, it will create a reminder - with added context from what is in the vault. if I love cold brew, dina will tell me, Alonso is coming, and keep a cold brew handy
3.6.  functionality 6  - security  - dina provides data security for external systems. for example - when the connected openclaw agent wants some data from a locked vault, it sends an approval request to the user.
3.7.  functionality 7  - approvals  - dina supports approval flow for many scenarios - as mentioned earlier, locked data is an approval flow. but similarly, we can setup some functionality to be also sensitive (for example sending an email - user can set up as sensitive. now, if openclaw agent hits the email sending functionality, it will ask dina validate. dina can then decide that the mail is not dangeous or it can be considered dangerous and can ask approval from the user. please note all connections from openclaw agent is through dina-agent cli which in turn uses msgbox cloud service. nothing is available striaghtaway
3.8.  functionality 8  - peerlens  - your dina and everyone elses dina together form a peerlens network - where everyone adds their reviews about products, youtube videos, services etc. so, when you want a chair, your dina can use the peerlens network to get the perfect chair for you. the peerlens system is an appview which is sitting on appview.dinakernel.com cloud service
3.9.  functionality 9  - services  - combining the appview, talk, and task scenarios gives you dina services. you can ask - when does the next bus reach castro location. your dina checks your vault, and finds you dont know this information. so, it will check services.appview.dinakernel.com whether there is any service which can answer this question (services.appview is a dina services manager , which uses peerlens and directory listing to get you the best service), . so, in that directory service, it finds bus driver for route 42 registered as a service which has castro station as a location it is serviced (amongst others). dina service manager sends the list of bus drivers reaching castro back to my dina. my dina then chooses the best bus for that route (based on current time, whether the bus has A/C because I love A/C bus), and sends a message through talk system to that dina. bus drivers dina accepts it (even though it is not a contact, it is a public service), and uses bus drivers openclaw to make a decision when will the bus reach that location (based on previous data etc), and returns the map and time back. 

4. claude tests full simulator testing yourself. You use idb to test ios simulator and adb to test android simulator - when i tell manual testing to be done. always idb and adb access will be there - please check

5. for testing you connect to test-mailbox.dinakernel.com and test-appview.dinakernel.com, and for production you connect to mailbox.dinakernel.com and appview.dinakernel.com. dina does not talk straight http with anyone other than through mailbox or appview. the pds to connect to is also available in test-pds.dinakernel.com and pds.dinakernel.com

6. to update appview, mailbox etc -./deploy/managed/infra/deploy_shared_infra.sh update prod # Update test./deploy/managed/infra/deploy_shared_infra.sh update test  

7. originally dina was written in python and go. when it was expanded to mobile, it was rewritten in typescript - so, dina home node server is also written in typescript with the same code base between dina home node mobile and dina home node server

8. dina-agent cli is a pypi project. we publish it from here to pypi. dina-agent cli is the only way for dina to connect with openclaw ai agent for dina to get agent tasks done. dina-agent cli tool will connect to your dina using msgbox cloud service. extremely important - dina never connects to the openclaw system straight - it always goes through dina-agent using msgbox cloud service. 

9. to test dina integration with openclaw, setup dina-cli agent locally in one folder (under the folders python .venv ) and then test - normal tests can be done with dina validate etc - 

10. every release ensure that docs/MANUAL_RELEASE_TESTS.md is tested thoroughly using adb idb always idb and adb access will be there - you can update docs/MANUAL_RELEASE_TEST_RESULTS.md

11. mobile side of application uses EAS Build (Expo Application Services)

12. we can test everything without docker from now on. run openclaw also locally, and use the dina-agent cli like i told earlier and conenct to openclaw for testing

13. Test scenarios for each
please note that all these actions /remember etc is done by clicking on mobile app manually using idb or adb in appropriate screens. 
this is a quick and easy way to inform here

13.1   remember - 
You:
/remember My daughters name is Emma
Dina:
Stored in General Vault
/remember My daughter loves dinosaurs
Dina:
Stored in General Vault

13.2 ask -
You:
/ask What does Emma like?
Dina:
Emma loves dinosaurs

You:
/remember Emma's birthday is on Nov 7th

Dina:
Stored in general vault.

Dina:
Reminders set:
[87b5] 🎂 Nov 06, 10:00 AM — Emma's birthday is tomorrow, you may want to buy a dinosaur-themed gift.
[2c9d] 🎂 Nov 07, 09:00 AM — It is Emma's birthday today, you may wish to contact her.

13.3 security
You:
/remember My friend James loves craft beer
Stored in general vault.

You:
/remember My bank account is in Barclay's and ends with 0102
Dina:
Stored in finance vault. << vault has been changed. but since the data was asked by user in mobile, and user is safe, no approval request required

You:
/remember My HbA1c is 9%, very high
Dina:
Stored in health vault.

13.4 approvals
install dina-agent cli in a /tmp/<tmpfolder>/.venv from pypi 
dina-agent cli - named as dina
dina configure to setup the agent (create pairing number from dina mobile app and pair) - you can screenshot and understand the pairing number there and pair it
then you setup sessions to test
(.venv) ~/dina % dina session start
  Session: ses_55s3khhq55s3 (SName-25Mar0728:22) active
(.venv) ~/dina % dina ask --session ses_55s3khhq55s3  "Which bank has my account" 
I don't have access to your bank account details.

approval will come to dina mobile app
🔐 claw-agent wants to access health
[Approve] [Deny] [Approve Once]
✅ Approved: apr-1774423823840426930

Agent can query that previous questions status to get the answer, once approval is available. Also, further questions in that session related to finance will be allowed
(.venv) ~/dina % dina ask --session ses_55s3khhq55s3  "Which bank has my account"
Your account is with Barclay's (ending in 0102).
  req_id: 55e828fcf816

13.4.1 approval for agent validation
(.venv) ~/dina % dina validate --session $S search "best ergonomic chair"
status: approved
risk: SAFE

(.venv) ~/dina % dina validate --session $S send_email "draft resignation letter to HR"
status: pending_approval
risk: MODERATE

(.venv) ~/dina % dina validate --session $S transfer_money "500 to vendor account"
status: pending_approval
risk: HIGH

(.venv) ~/dina % dina validate --session $S read_vault "health records"
status: denied
risk: BLOCKED

🔐 claw-agent wants to send resignation email to HR 
[Approve] [Deny] [Approve Once]
✅ Approved: apr-1774423823840426930

How do we test bus driver scenario
stub_eta_runner.py
bus42-agent
  - What it is: Alonso asks "when does bus 42 reach Castro?" → his Dina finds a public transit service in the AppView directory, sends it a private message, and the answer comes back as an ETA card. Two separate
  Dinas talking over MsgBox.
  - The real path (no shortcuts): Alonso discovers the provider on test-appview → sends a service.query D2D over MsgBox → the provider Dina creates a task → its paired dina-agent daemon claims the task →
  bus42-agent/stub_eta_runner.py answers (eta = random.randint(2,14), reverse-geocodes the location to a real stop) → service.response D2D back → ETA card. Everything inside Dina is the real signed/relayed path;
  only the runner at the edge stands in for OpenClaw + a real transit API.
  - To run it: start the provider lite Core on :18298 + the bus42-agent daemon (both live under bus42-agent/ — keys in keys/, vault in provider-vault/). Keep EXPO_PUBLIC_DINA_DEMO empty so the in-app demo loopback
   stays off.



Some impleemntation details
⏺ There are three separate identity/trust stores
  - D2D trust gate (d2d/gates knownContacts) — controls whether inbound stages vs quarantines.
  - Contact directory (what add-contact.tsx writes) — display name + trust scoring.
  - People-graph (PeopleRepository) — confirmed person bound to a DID

  Normally your Dina only accepts messages from people in your contacts. Strangers get turned away. But in the bus example, your Dina has to ask a stranger — the bus company's Dina — a question, and then let that
  stranger's answer back in. How do you allow the answer without permanently opening your door to a stranger?
  
  When your Dina sends the question, it leaves itself a little note:
  
  ▎ "I'm expecting one reply, from the bus company, about this exact question, in the next minute."
  
  When the bus company's Dina replies, your Dina checks the note, sees it matches, lets that one reply in — and then tears up the note.

  Same with the bus company's Dina:
  - It published "I answer eta_query," so it accepts an eta_query from any stranger.
  - It routes it to its service desk (the service handler) and answers — because it set its policy to answer these automatically.
  - A personal message from you ("be my contact") would still be turned away — you're not in its contacts. Only the advertised service request gets in.

Agent Safety scenarios
  The setup: Your Dina lives on your mobile. An agent (OpenClaw / sample test agent) lives somewhere else (laptop, server, cloud). They can talk to dina only through dina-agent cli which always talks only through msgbox. Your Dina is the gatekeeper for anything sensitive.
  
  The principle: When YOU use the app, everything's open. When an agent acts on your behalf, sensitive stuff gates on YOUR approval.


  Scenario 1 — "An agent tries to read my locked Health vault"
  
  What happens. Agent runs dina ask "what's my blood pressure". Health vault is locked. Your Dina sees the request, creates an approval, sits and waits.
  
  What you see on the phone.
  - A new card pops into your chat thread: 🔐 AGENT VAULT READ — An agent wants to access /health.
  - The same card appears on the Approvals tab.
  - Red badge 1 on both Notifications and Approvals tabs.
  
  What you can do. Three buttons on the card itself (no popup):
  - Deny — blocks it. Agent gets back denied.
  - Approve Once — single-use grant. Next ask requires fresh approval.
  - Approve — grants for the whole CLI session. Subsequent asks from same agent + same session + same vault pass through silently until the session ends.
  
  Two CLI asks against /health, two cards minted, both Denied via the chat-card. CLI saw reason: denied. Card flipped to italic "Denied." Badges cleared.
  Approve (Session) doesn't mean "the whole time the CLI process is running." It means the specific Dina session you explicitly created and named. The flow is:
  
  dina session start --name "morning-tasks"
  # → returns sess-1646bf6883414a88
  
  dina ask --session sess-1646bf6883414a88 "what's my blood pressure"
  # → 1st time: approval card pops on phone. You tap Approve (Session).
  #   Dina records grant for (agent_did, sess-1646bf6883414a88, /health).
  
  dina ask --session sess-1646bf6883414a88 "what was my BP last week"
  # → same session, same vault. Passes through silently. No card.
  
  # Same agent, new session:
  dina session start --name "evening-tasks"
  # → returns sess-9b3c1f...
  
  dina ask --session sess-9b3c1f... "what's my blood pressure"
  # → new sessionId → fresh approval card. Old grant doesn't apply.
  
  So the keying is the explicit tuple (agent_did, dina-session-id, persona) — three things, all required to match.
  
  What this gives you:
  - A dina session start --name "research" is something you choose to open — a deliberate scope for related work.
  - Different sessions get different IDs. Approving in morning-tasks doesn't carry to evening-tasks even if you start the second one 30 seconds later.
  - The CLI requires --session on every ask — there's no implicit "default session" (tonight I saw the error: Missing option '--session' — that's the gate at work).

  
  ---
  Scenario 2 — "I'm just chatting with my own Dina — should it ask me for approval?"
  
  No. When YOU use the app, the persona guard short-circuits. The owner DID always passes. You can ask about anything in any vault without approval prompts.
  
  Why this matters. The gate exists to protect against external agents — not to friction your own interactions. Verified earlier in the session.
  
  ---
  Scenario 3 — "If I approve once, does that grant stick to other vaults too?"
  
  No — every vault is independently gated. Approving the agent to read /health does NOT grant /finance. The session-scope grant is keyed on the exact tuple (agent, session, persona).
  
  Verified. Tonight's 2nd CLI ask asked about /finance (cholesterol) — even with a session-scope approval on /health, Dina re-asked for approval on /finance. Independent gate.
  
  ---
  Scenario 4 — "If I start a new CLI session, does the old session's approval still work?"
  
  No. Sessions are fresh slates. dina session start --name "foo" mints a new session ID. Any session-scope approval from a previous session does NOT carry over. You'll see a fresh approval card on the next
  sensitive read.
  
  Why this matters. Stops "I approved that once a week ago, why is the agent still doing it" surprises.
  
  ---
  Scenario 5 — "Where else does the approval show up?"
  
  Three surfaces, all stay in sync:
  1. Chat thread inline card — Deny / Approve Once / Approve buttons right there.
  2. Approvals tab — same card, three buttons (and 3-way iOS Alert for the scope picker on the Approvals-tab variant).
  3. Tab-bar badge — red 1 until resolved.
  
  All three stay synced. If you approve via the Approvals tab while sitting on the chat tab, the chat-card auto-flips to "Approved." within 5 seconds — without you tapping anything. Verified earlier in the
  session.
  
  ---
  Scenario 6 — "I approved on one surface, then accidentally tapped Deny on the other — does it crash?"
  
  No. Cross-surface double-tap is reconciled silently. The 2nd tap sees the task is already resolved, drops its action, syncs its local UI to match. No error popup.
  
  ---
  Scenario 7 — "What if the agent's request just times out (it never reaches me)?"
  
  Dina returns expired to the agent. Approval cards on the user side become stale and the badge clears at next sweep. Verified pre-compaction.
  
  ---
  Scenario 8 — "What about non-vault-read agent actions — like send_email?"
  
  Same gate, different name — dina validate. Agent calls /v1/agent/validate for a moderate/high-risk action (send_email, transfer_money, etc.). Dina creates an intent_validation workflow task. Same three scopes
  (Deny / Once / Session). Verified pre-compaction across all 4 of: approve, deny, approve-for-session, new-session-denied.

- More details found in docs/SCENARIOS.md

Peerlens and Services cannot sidestep appview - it has to go through the deployed appview (test-appview.dinakernel.com or appview.dinakernel.com based on test/prod) - if it skips appview and tries to connect straight, it is an anti-pattern, and is not allowed.

To deploy appview or msgbox - use - ./deploy/managed/infra/deploy_shared_infra.sh

