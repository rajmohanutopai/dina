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


