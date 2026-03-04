
Let me give you a quick overview of what the security model is like. 

We first create a random 256 bit (32 bytes) MASTER SEED . Then we will use a BIP-39 logic to convert it to a 24 word BIP-39 mnemonic (list of words) so that people can take it as backup. This, is the most important data, the root secret. Anyone with this SEED has full access to your data.

Restore is similar, just that user will type in the mnemonic.

The master seed is actually kept within the docker / host (in memory). in disk though, it is kept - but wrapped with KEK (Key Encryption Key).  KEK is created from a different password - which user types in . So, there is master seed and a password both. the password - user has to type it in - but it is much easier because it is not the 24 word thingie - just a single word. the password is the one which we will ask the user to send every time - not the master seed. 

We should not store the password, because then your Master SEED is in risk.

So, the steps are - 
Dina install internally creates master seed and shows to user for safe keeping (after converting to words using BIP-39). Dina also creates the KEK from the password using Argon2id. 
Generate random salt
Argon2id(password, salt) => 32 byte KEK. This is a one way hash and we cannot get the password back from KEK. 

Generate random nonce (for AES-GCM) 
Using KEK and nonce, the master seed is then encrypted using AES-256-GCM algorithm.
Using  AES-256-GCM(KEK, Master Seed, nonce) => wrapped_seed

**Storage**: Only the wrapped_seed, salt, and nonce are stored on disk (and inside the Docker container).

To paraphrase - Master Seed is your identity root. Password / passphrase is the lock/unlock secret for the master seed. You can change your password - it does not matter. It does not change the identity. Changing Master Seed changes the identity.

**The Boot Process**

Let’s walk through what actually happens when the Dina Docker container starts up.

The golden rule here is that the Master Seed never touches the disk in plain text; it is always wrapped. So, during boot, we have to reconstruct it in memory.

Here is the flow: The user provides their password at runtime. We take that password, grab the random salt we saved on disk, and run them through Argon2id. This rebuilds our 32-byte Key Encryption Key (KEK) right there in memory. We then use that KEK, along with a saved nonce, to unwrap the encrypted Master Seed using AES-256-GCM.

At this point, the raw 32-byte Master Seed is securely loaded into isolated memory for the session, ready for derivation.

3. Deriving the Keys (The SLIP-0010 Tree)

With the Master Seed safely in memory, we need to generate our actual operational keys. But as we discussed earlier, we never sign directly with the Master Seed. Instead, we use SLIP-0010 to derive child keys.

Which are the child keys?
1. did:plc (or public DID docuement)
2. node signing key
3. per persona encryption keys
4. backup keys

   Master Seed (32 bytes)
    └─ SLIP-0010 m/9999'/0'  →  Ed25519 keypair (signing key)
    │                              └─ Public key  →  did:plc (identity)
    │                              └─ Private key →  IdentitySigner (in memory only)
    └─ HKDF("personal")      →  Personal Persona DEK (vault encryption)
    └─ HKDF("work")          →  Work Persona DEK
    └─ ...


We use SLIP-0010 algo/tree with hardened (cannot get original back) branch (we use m/9999'/x), send it to Ed25519 key creation to create  the key pair - public/private keys (key pair is when m/9999'/0') - and m/9999'/1' onward for personas (consumer, professional, social, health, etc. DEKs), 

A 64-byte Private Key: We immediately wrap this in our IdentitySigner and keep it strictly locked in memory. Its only job is to sign data. 

A 32-byte Public Key: This is what we expose to the world so they can verify our signatures.

Creating the DID (did:plc)
We use AT Proto as the base for our network. 
AT Proto has a did:plc registry where we store our decentralized identifier, along with the public key.

How do we get a decentralized identifier out of a public key? We take that 32-byte public key, hash it with SHA-256, extract the first 16 bytes, encode it into base58, and prepend did:plc:. That string becomes our permanent public address.

Publishing the DID Document
Finally, we need a way for external parties (other Dinas, or App View etc) to actually find our public key. So, we wrap our public key in a Multikey format (adding a specific Ed25519 prefix) and publish it inside our DID Document. The public key is checked by Relay to validate that it is indeed from the proper did:plc (because did:plc was originally created from public key)

If we change public key, we update the DID document, but our original did:plc remains - that does not change. That is our identity in AT Proto network.

This is not done by us though. We bring up AT Proto's PDS as a separate container
  Core asks PDS to create an account. PDS generates the repo signing key, builds and signs the genesis operation, and publishes the DID document to the PLC Directory. The DID document contains the public key and points back to the PDS as the service endpoint. Core never directly interacts with the PLC Directory for publishing — PDS is the intermediary.


Talking to AT Proto

- Core submits content — calls com.atproto.repo.createRecord via XRPC. Core never signs AT Proto repo commits.
- PDS signs commits — PDS owns a separate repo signing key per account. It maintains the signed Merkle tree. This key is generated during com.atproto.server.createAccount, never by Core. PDS is not our code.
- Core's Ed25519 key is for D2D messaging and DID auth — not for AT Proto repo signing. Different key, different purpose.
- PDS generates its own repo signing key during account creation
- Core's identity key and PDS's repo signing key are separate keys with separate jobs
- Core authenticates to PDS via JWT (from createSession), then submits record content. PDS signs the commit.



**More Details**

Let's review the four distinct types of tokens utilized in Dina and trace how they flow through the system.

1. Master Seed (we discussed)
2. BRAIN_TOKEN

Used by Python Brain. Go Core also has it. So, it validates the token to ensure that it is coming from Python Brain.
This is randomly created 256 bit token at installation.
Since Core has it, Core can also call Brain in some cases (with Bearer Token as Brain token)


3. CLIENT_TOKEN

Generated during device pairing (`crypto/rand.Read()`, 32 bytes). Two uses:
- **Admin web UI**: used as a login password — browser POSTs it to `/admin/login`, gets a session cookie back.


4. CLI Authentication - CLI authenticates exclusively via Ed25519 request signing (X-DID + X-Timestamp + X-Signature headers). During `dina configure`, the CLI generates an Ed25519 keypair and registers the public key via the pairing ceremony. No shared secret is exchanged.

4. Dina Internal Token

Used by the Brain admin UI to proxy requests to Core. When the admin dashboard needs to call Core APIs on behalf of the logged-in user, it uses this token.


>> Some normal questions and answers
**What is BIP-39**
It is pretty straightforward. It takes 256 bits, does checksum, adds it (so that checksum check happens always) - so 256+8 264 bits, divides by 11 - to get 24 words. 11 => means there are 2048 options (2^11) - so, we have a menmonic table of 2048 english words. 

**Why this complex ed25519 seed? Why not just random.random()**
import secrets
#  32 bytes (256 bits) - Ed25519 Seed: Cryptographically Secure Pseudo-Random Number Generator (CSPRNG)
ed25519_seed = secrets.token_bytes(32)

Not random.random because secrets is more secure. random.random is not very secure because it uses predictable RNG (Mersenne Twister) - example think of a RNG which only uses starting time as input - so, someone can write a program to generate secrets for every millisecond, (because wallets contain a lot of money). secrets library uses lots of random variables like cpu temp at that time etc also which makes it impossible to recreate

**What is the difference between salt and nonce**

Conceptually similar - both are random viewable texts added at the start before hashing/encryption. But usage is fundamentally different. If you reuse your salt across other passwords, it is not very dangerous. Maybe security is weakened a bit. But if you reuse the nonce, it is as good as you Master SEED is out (nonce is number used only once - and it is absolutely important that it is unique)

**Why Argon2id**
Because it is computationally expensive hash function, which makes it more resistant to cracking

**Why It does not use the Master Seed directly to sign**
It’s a fair question: if the Master Seed is the absolute root of our identity, why not just use it to sign everything directly?

The short answer is blast radius. We want the ability to rotate our operational keys without burning our identity to the ground or making all our saved data unreadable.

Let me explain a bit more about how we split this up. In Dina, we essentially have two different types of derived keys doing two very different jobs: Signing Keys (for proving who we are to the outside world) and Data Encryption Keys, or DEKs (for locking up our local vaults).

The Memory Scraping Reality
As we touched on earlier, the Master Seed is treated like radioactive material. During boot, it’s kept in memory just long enough to spawn these derived child keys, and then it is completely wiped. So, even if the absolute worst happens and a hacker manages to scrape the container's active memory, they are only walking away with the temporary derived keys—never the Master Seed itself.

Changing the Locks (Rotating the DEK)
Think about what happens if you want to rotate your DEK. Because your Master Seed is safely tucked away, the process is straightforward: you generate your new DEK, unlock the vault using your current DEK, apply the new one, and lock it back up. It’s exactly like changing the locks on your front door. The house (your data) is still yours, and it's perfectly safe.

Keeping Your History Alive (Rotating Signing Keys)
The same philosophy applies to our signing keys, and this is where the AT Protocol really shines.

If a signing key feels compromised, you simply swap it out and update your AT Protocol registry (did:plc) to broadcast your new Public Key. From that moment on, AppViews will check any new data you produce against this new key.

But what about the data you signed last year? Because the AT Protocol is temporal (time-aware), your historical data is completely fine. When an AppView checks an old signature, it looks at the registry's timeline and says, "Ah, this was signed with the Public Key that was officially active during that specific start and end time." By isolating the Master Seed, we get the agility to swap out our keys whenever we need to, without ever orphaning our past or losing our data.