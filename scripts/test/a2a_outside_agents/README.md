# Outside A2A agents against a Dina node

Two agents built only on the official A2A SDKs — `a2a-sdk` (Python) and
`@a2a-js/sdk` (JavaScript, both JSON-RPC and REST) — do what a stranger's agent
would: find a Dina node in the trust-ranked directory by skill, fetch its Agent
Card and verify the signature with the SDK's own verifier, then call skills
with the bearer the owner issued. Each checks a streamed call, a plain call,
`GetTask`, `ListTasks`, a call the owner must review (the run approves it as
the owner), and the refusals an outside agent can meet (unknown skill, plain
text, wrong bearer). Last run, 2026-10-04: Python 15 of 15, JavaScript 28 of 28.

## Run

Uses the shared test servers (`dina_details.md` item 5); the test AppView must
run this branch, and its directory must be open for the run.

1. Gateway key, once: `DINA_A2A_GATEWAY_KEY_DIR=<dir> npx tsx apps/home-node-lite/a2a-gateway/src/bin.ts keygen` (prints its DID).
2. The node, from the repo root, with an account on the test PDS:

   ```
   DINA_VAULT_DIR=<vault> DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT=18100 DINA_MSGBOX_ENABLED=false \
   DINA_ENDPOINT_MODE=test DINA_PDS_PROVISION=1 DINA_PDS_HANDLE=<name>.test-pds.dinakernel.com \
   DINA_A2A_PUBLIC_URL=http://127.0.0.1:18400 DINA_A2A_GATEWAY_DID=<gateway did> \
   DINA_OWNER_CAPABILITY=<16+ chars> TCK_TOKEN_FILE=<token file> \
   npx tsx scripts/test/a2a_outside_agents/sut_node.ts
   ```
3. The gateway: `DINA_A2A_GATEWAY_KEY_DIR=<dir> DINA_A2A_GATEWAY_PORT=18400 DINA_CORE_URL=http://127.0.0.1:18100 npx tsx apps/home-node-lite/a2a-gateway/src/bin.ts`
4. Open the test directory (`a2a_directory_enabled` true in the test AppView's `appview_config`), then publish as the owner:
   `POST /v1/owner/a2a/directory-listing {"enabled": true}` and `POST /v1/owner/a2a/publisher/activate {}`, each with `x-dina-owner-capability`.
5. The agents (env: `APPVIEW=https://test-appview.dinakernel.com/xrpc BEARER=$(cat <token file>) CORE=http://127.0.0.1:18100 OWNER_CAP=<capability>`):
   - Python, in the reference venv (`apps/home-node-lite/core-server/__tests__/a2a/reference/requirements.txt`): `python python_agent.py`
   - JavaScript: `npm install` here, then `node js_agent.mjs`
6. Afterwards: `POST /v1/owner/a2a/directory-listing {"enabled": false}` withdraws the card; close the directory again.
