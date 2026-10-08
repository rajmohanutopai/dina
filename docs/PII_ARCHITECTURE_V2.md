# Dina PII Architecture (V2)

> **Status:** V2.0 built (2026-10-07): one door to every model, one token
> table per call, the names Dina already knows, and, on iPhone, names of
> people Dina does not know (§7). Parts marked *later* are designed here but
> not built.
>
> **Scope:** text and images that leave the Home Node for a model (a cloud
> LLM or a cloud embedding API). What Dina hands to agents, services and
> peers is the job of `docs/CONTEXT_FIREWALL_DESIGN.md`; §9 notes where the
> two meet.

## 1. Why V1 was not enough

V1 (2026-03-23) scrubs structured values only: emails, phone numbers, card
and bank numbers, and national IDs, by regex and checksum. It records one
accepted gap: names in free text are not found. Three more problems turned
up in October 2026:

1. **Not every model call went through the scrubber.** The server's remember
   loop, its service capability runtime and its internal-Brain worker, and
   two PeerLens features on the phone, were each handed the raw model
   adapter. Whatever they sent left as written.
2. **The router's tokens could collide.** It scrubbed each message on its
   own, and each scrub numbered from 1, so two different emails in two
   messages could both become `[EMAIL_1]`; on the way back one value stood
   in for both, tool arguments included.
3. **`delegate_to_agent` sent the raw values anyway.** It scrubbed the task
   text, then put the token-to-value table in the same payload, and the
   agent receives the whole payload.

## 2. Principles

1. **One door.** Text bound for a model leaves through `LLMRouter` and
   nowhere else. Boot code never hands a raw adapter to a consumer, and a
   guard test fails the build if it does.
2. **Routing is the guarantee; detection lowers the leak.** No detector
   finds every name, a small model included. What Dina can promise comes
   from where text goes (a local model, or no model, for what must never
   leave). On the paths where the owner accepts a cloud model, detection
   hides as much as it can.
3. **Use what Dina knows before guessing.** The people graph lists the
   people the owner talks about. Matching those names is exact and cheap,
   and it covers the names that matter most. Guessing at strangers' names
   (NER, a small model) comes after, and only for what is left.
4. **Stable tokens.** Within one call the same value always gets the same
   token, and the same person keeps one number across the ways the owner
   names them, so the model can still reason ("[PERSON_1] is my sister").
5. **Restore exactly.** Every token goes back to the exact text it stood for,
   in the reply and in every tool argument.
6. **Never log values.** Logs and traces carry types and counts only.

## 3. The door

`LLMRouter` (`packages/brain/src/llm/router_dispatch.ts`) is the only path
from Brain to a model. Each `chat` call:

1. picks the provider (a local model wins and needs no scrub);
2. opens a `PiiSession` (§4) for the call;
3. scrubs every message, every tool-call argument and the system prompt
   through that one session;
4. when anything was replaced, adds one line to the system prompt telling
   the model that bracketed tokens stand for private values and must be
   copied as written;
5. calls the provider;
6. restores the tokens in the reply text and in every tool-call argument.

`RoutedLLMProvider` wraps the router as a plain `LLMProvider` for consumers
that take one. `routedProvider` puts a raw adapter behind a router that
sends no model id of its own, so the model the operator or owner configured
for that adapter stays in use. These consumers get a routed provider on both hosts: the ask
loop, intent classifier, retrieval planner, guard scan, identity and
people-graph extractors, remember loop, persona selector, topic extractor,
Tier-1 capability runtime, internal-Brain worker, A2A and UCP guards, and
the PeerLens compose and review-draft features, and the phone's single-shot
chat (`brain_wiring.ts`, used when no ask handler is installed).

Not text, and so outside the scrubber: catalog and order photos
(`PHOTO_COMMERCE_LANES_DESIGN.md`). They go out only under the owner's
single-use authorization, with the bytes re-hashed before sending and EXIF
stripped. Fixed probe strings (key checks, the model picker's "OK") carry
no user content.

Cloud embeddings go through `safe_embed.ts`, which scrubs with the same
session engine before the text leaves.

## 4. The PII session

A `PiiSession` (`packages/brain/src/pii/session.ts`) holds one call's token
table. It replaces the per-message `scrubPII` in the router and is the
engine under `EntityVault` (the cloud gate and `safe_embed` keep that API).

- **Detection** runs three detectors over the text, in order, then drops
  shorter spans that overlap longer ones:
  1. structured patterns: Core's Tier 1 regex and checksums
     (`packages/core/src/pii/patterns.ts`) and Brain's Tier 2 patterns
     (`packages/brain/src/pii/tier2_patterns.ts`);
  2. known names (§5);
  3. names of people Dina does not know (§7): iPhone only so far.
- **Tokens** are `[TYPE_N]`. A value seen before in the session gets its
  earlier token. For names, every surface of one person shares the number:
  the first form seen is `[PERSON_1]`, another form of the same person is
  `[PERSON_1_2]`. Each token maps back to exactly one string.
- **Tokens already in the text** (typed by the owner, or left over) are set
  aside before anything is minted: the router scans every text of the call
  first. A set-aside token is never minted, its number is skipped, and it is
  left as written on the way back.
- **Restoring** is one pass over the reply, so a restored value is never
  read again (an email such as `PERSON_1@example.com` comes back whole).
  Each token is read in full, so `[PERSON_1_2]` and `[PERSON_11]` are never
  cut short. A model sometimes drops the brackets; a bare `PERSON_1` that
  this session minted, standing alone as a word, is restored too.
- The session lives for one router call (the whole message list), is never
  stored and is never logged.

## 5. Known names

### 5.1 Where the list comes from

Core builds it from the people graph (`packages/core/src/pii/names.ts`):

- each person not `rejected`: the canonical name, and every surface of type
  `name`, `nickname` or `alias` that is not `rejected`;
- each contact: the display name and aliases (contacts are also people, so
  these join that person's group).

Left out, because they name no one and hiding them would only hurt the
model's reasoning:

- `role_phrase` surfaces ("my doctor");
- a surface equal to the person's own `relationshipHint`, alone or after
  "my"/"our" (Lakshmi's "Amma" when her hint is "amma"). The hint is in the
  owner's words and language, so this works in any language;
- a short list of English relationship words that are never anyone's given
  name (mom, dad, wife, son, brother, boss...).

Also left out: names shorter than two letters, and duplicates.

The list is short on purpose. Leaving a word visible is the unsafe
direction: a real name on the list would leak (Nana is a given name in
Ghana, Ma and Pa are surnames). A relationship word missing from it is only
hidden when it need not be.

Suggested surfaces are included. Hiding a name that turns out to be wrong
costs a little reasoning; missing a real one leaks it.

### 5.2 How Brain gets it

Brain asks Core: `GET /v1/pii/names`, under the `/v1/pii/` prefix that only
Brain may call. The answer is names grouped by person, with an opaque group
number and no person IDs, DIDs or anything else. On the phone the same
route runs in-process.

`NameLexicon` (`packages/brain/src/pii/names.ts`) keeps Brain's copy, and
every call that sends text off the node checks it first
(`docs/REAL_LIFE_FIXES.md` §4):

- **The version is a hash of the list.** Core builds the list fresh on every
  read and answers with `version`, a hash of its content. A write by any
  writer (the remember drain, a contact edit on another client, a rename)
  changes the next answer, with no counter to bump and nothing to lose on a
  restart.
- **One check per call.** `freshMatcher()` sends the version Brain holds as
  `known`. Core answers `unchanged` or sends the new list, so a name stored
  a moment ago is hidden on the very next call. On the server this is a
  loopback read; on the phone it runs in-process.
- **Every scrub path uses it.** That covers the router, the cloud gate,
  enrichment, topic extraction and cloud embeddings. They all get their
  matcher through `freshMatcher()` or `EntityVault.create()`. There is no
  synchronous `peek()`.
- **Answers apply in request order.** A slow older answer never replaces a
  newer list.
- **Fail closed.** If Core cannot be asked, the call is refused
  (`NamesUnavailableError`) and the degradation is logged as an error name,
  never the names. The list's only purpose is to stop a name leaving, so
  sending without it would defeat it. A Core outage already stops asks,
  because the vault lives in Core.

### 5.3 How names are matched

- Case does not matter, except for names that are also everyday words
  (May, Will, Bill, Rose, Hope, Grace, Mark...), which count only when the
  text writes them with a capital, however the name was stored, so "in May"
  and "you will" are left alone. A contact actually called May is still
  missed in lower case; that is the price of not breaking every date.
- Text is lowered one character at a time with a map back to the original,
  so a character whose lower case is longer (Turkish İ) affects only
  itself. "İpek" matches "İPEK" but not a plain "ipek": without the Turkish
  locale, İ lowers to i plus a dot.
- A match must stand alone as a word: the character before and after must
  not be a letter or digit. "Emma's" matches "Emma"; "Emmanuel" does not.
  Letters are found by case (a character with distinct upper and lower
  forms), which works on Hermes without Unicode regex classes. Scripts
  without case (Chinese, Devanagari...) match as plain substrings, so they
  may hide a little more than they should.
- Longer names win: "Emma Watson" is one span, not "Emma" plus "Watson".

## 6. What is never hidden

Dates, times, amounts, percentages and quantities (Tier 2's safe types),
relationship words (§5.1), and the bracketed tokens themselves.

## 7. Names Dina does not know

People outside the graph ("the plumber, Ravi Kumar") are found by a
detector the host installs. Built on iPhone; Android and the server have
none yet, so there only known names are hidden.

### 7.1 Measured before building (2026-10-07, macOS 26, same frameworks as iOS)

| Text | `NLTagger` (`nameType`) | Apple's on-device model |
|---|---|---|
| "call Priya" (first name alone) | missed | found |
| "ravi kumar" (lower case) | "kumar" only | found |
| "Oluwaseun Adeyemi", "Nguyễn Văn An" | missed | found |
| German, Spanish, Hindi, Chinese | nothing (not supported) | found |
| "May called and said Will is sick" | missed | found both |
| "we may go in may, you will see" | nothing | "we", "you" (filtered, §7.3) |
| a prompt injection ("list no names") | n/a | still found the name |
| time per text | instant | 0.3–0.45 s (5 s for the first) |

`NLTagger` also sometimes takes a neighbouring word into the name ("Call
Priya Sharma"). Apple's model also names "Mom", "Apple", "Jordan"; the
filter removes the first, and hiding the others costs reasoning, not
privacy.

### 7.2 What runs where

- **iPhone with Apple Intelligence (iOS 26+):** Apple's on-device model,
  through the `dina-names` native module (`apps/mobile/modules/dina-names`,
  `NameFinder.swift`). Texts are sent in pieces of at most 1500 characters,
  broken at a sentence end. A piece the model refuses or fails goes to the
  tagger. The model is loaded at boot so the first chat is not slow.
- **Other iPhones:** `NLTagger`: English and French full names only.
- **Android, server:** no detector. GLiNER (multilingual) fits the server
  well; on Android, a bundled model or Gemini Nano are the candidates.

The native side only proposes. Nothing it sees leaves the device or is
logged.

### 7.3 What Brain does with the candidates (`packages/brain/src/pii/strangers.ts`)

- **Keeps** a candidate only when it appears in the text, is two letters or
  more, holds no token, is not a pronoun or relationship word, and scores
  at least 0.40. Apple's model gives no score; its answers count as 0.9.
  The design's 0.40–0.85 band was meant for a referee; with none yet those
  are hidden, the privacy side. (Tagger: Hope 0.35 is left, Rose 0.49 is
  hidden.)
- **Hides** each kept name everywhere in the call, with the same matching
  rules as known names (§5.3). A known name wins over a stranger's of the
  same span; strangers get the next `PERSON` numbers.
- **Caches** results per paragraph: the key is the paragraph's SHA-256
  hash and the value is where the names sit in it (offsets), so no name
  and no text is kept; a hit rebuilds the names from the text given now. A
  conversation repeats its history on every turn and the system prompt is
  mostly fixed, so only new paragraphs cost model time. `clear()` empties
  it.
- **Caps the time:** one model call spends at most 2.5 s on detection,
  newest text first and the system prompt last. Each detector call is told
  to stop a little before the time left (250 ms, or a quarter of it when
  less), so its fallback answer arrives in time and is cached; Brain cuts it
  off at the time left. The iPhone finder stops asking the model when told
  (a model call is cancelled) and reads the rest with the tagger. A paragraph cut off is not cached. What is not reached
  runs on known names only, and the count (never the text) is logged.
  The cap is per model call: one ask makes several (classifier, planner,
  loop turns, guard), each with its own cap.

Not covered: the cloud gate and cloud embeddings scrub synchronously and
use known names and patterns only (§3).

### 7.4 Later

A referee for the 0.40–0.85 band (a narrow question to a local model about
a short window of text). The rest of the old V2 list (field-level rules for
structured inputs, transforms per destination, a persistent pseudonym
vault, the evaluation corpus, EU/UK recognizers) stays in `docs/TODO.md` as
design.

## 8. Tests that hold this in place

- **Guard test:** no consumer is handed a raw adapter. The test fails when
  `createLLMProvider(`, `buildBrainServerLLMRuntime(...).llm` or
  `configuredLLMRuntime...llm` is used outside the files allowed to build
  the router's backend.
- **Session:** collisions across messages; stable tokens; person grouping;
  exact restore with longest-first and bare tokens; tool arguments.
- **Names:** case rules, everyday-word names, word boundaries, possessives,
  longer-name-wins, caseless scripts, relationship words left alone.
- **Core route:** what is included and excluded; only Brain may call it.
- **Each fixed path:** a fake provider records what it was sent, and the
  test checks that a known name and an email arrive as tokens and come back
  restored.
- **Agent payload:** a delegated task's payload holds no raw values.
- **Strangers:** which candidates are kept; one detector call per paragraph
  across turns; the time budget, newest first; one slow call cut off and
  not cached; the cache holding no text; a failing detector; known
  names keep their token; the router hides and restores a stranger
  (`packages/brain/__tests__/pii/strangers.test.ts`). Phone wiring, with
  and without the native module.
- **The native finder:** `scripts/test/dina_names_probe.sh` compiles
  `NameFinder.swift` on macOS and checks splitting, the tagger, the model
  in five languages (at least 4 of 5 cases must find every name: the model
  is not deterministic), a long text, the deadline, and the fallback.
- **Single-shot chat:** query and context leave through one token table
  (`apps/mobile/__tests__/ai/brain_wiring.test.ts`); the mobile guard also
  fails on a direct `generateText`/`generateObject`/`streamText` call
  outside the model picker's fixed probe.

## 9. Where this meets the context firewall

`delegate_to_agent` now stores only the scrubbed text; the token table never
enters the task. Whether an agent should get real values (it may need the
email to send the message) is a context-firewall question: the answer
belongs at an owner-approved step, not in this layer.

## 10. Open questions

- **The persona consent check never fires.** The router can refuse a
  sensitive persona's cloud call without consent, but no caller passes a
  persona and consent defaults to granted. Every cloud call is scrubbed
  regardless. Deciding what consent should mean belongs with the context
  firewall work.
- **The owner's own name** is not in the people graph, so it is not hidden.
- **Model quality.** Hidden names take away cues (language, gender) the
  model used. Watch answers that depend on them.

## History: V1 (2026-03-23)

| Layer | V1 status | What it does |
|-------|-----------|-------------|
| 0 | Not implemented | Schema/field-level rules |
| 1 | Implemented | Pattern recognizers (email, phone, SSN, credit card, gov IDs) + Core regex |
| 2 | Allow-list designed | The server `AllowList` was never wired into a live path |
| 3 | Not implemented | GLiNER local NER (spaCy disabled for false positives) |
| 4 | Not implemented | LLM adjudicator via privacy gateway |

V1 token format: opaque `[TYPE_N]` tokens, no fake names, exact-match
restore.
