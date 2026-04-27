# Help screen screenshots

PNG / JPG examples shown inside the help cards on `app/help.tsx`. Each card
opts in by setting `screenshot: require('../assets/help/<name>.png')` on its
`CapabilityCard` definition. When a screenshot is set, the text `example`
field on that card is hidden.

## Conventions

- **Aspect ratio**: 16:9. The renderer crops with `resizeMode: 'cover'`,
  so the most important content should sit in the centre 80% of the
  frame.
- **Source**: capture from the iOS simulator (iPhone 17 Pro). 1170×658
  px is a clean 16:9 crop of a single chat bubble.
- **Format**: PNG for crispness on Retina screens, ~150–250 KB per asset.
- **Filename**: `<feature>_<state>.png` — e.g. `remember_confirmation.png`,
  `ask_reply.png`, `bus42_eta.png`.

## Capture recipe (per screenshot)

1. Boot the app on the simulator (`npx expo run:ios`).
2. Drive the feature to the moment that demonstrates the capability:
   - **Remember**: tap "Remember something", type the example, send,
     wait for the confirmation bubble. Capture the user message + the
     confirmation reply.
   - **Ask**: tap "Ask a question", type the example, send, wait for
     Dina's reply. Capture the question + the answer bubble.
   - **BusDriver / `eta_query`**: type "When does bus 42 reach Castro?"
     and wait for the `InlineServiceQueryCard` to flip from `pending` to
     `resolved`. Capture the resolved card with the map button visible.
3. Trim with macOS Preview (or any image editor) to a 16:9 crop that
   focuses on the relevant chat bubble(s).
4. Save into this directory under the agreed filename.
5. Update `app/help.tsx` to add `screenshot: require('../assets/help/<name>.png')`
   on the matching `CapabilityCard`.

## Currently expected

| Card                    | Filename                       | Status   |
| ----------------------- | ------------------------------ | -------- |
| Remember something      | `remember_confirmation.png`    | TBD      |
| Ask a question          | `ask_reply.png`                | TBD      |
| Ask the world (bus 42)  | `bus42_eta.png`                | TBD      |
