"""An outside A2A agent, built only on the official a2a-sdk (Python), calling a Dina node.

It does what a stranger's agent would: find Dina in the directory, fetch and
verify its Agent Card with the SDK's own verifier, and call skills the card
offers, with the bearer the node's owner issued it. The OWNER steps (approving
a reviewed call) are the test harness acting as the owner, marked as such.

Env: APPVIEW (directory xrpc base), BEARER (client token), CORE (owner's Core),
OWNER_CAP (owner capability), SKILL_AUTO, SKILL_REVIEW.
"""

import asyncio
import json
import os
import sys
import uuid

import httpx
from google.protobuf.json_format import MessageToDict
from google.protobuf.struct_pb2 import Value
from jwt.api_jwk import PyJWK

from a2a.client import ClientConfig, create_client
from a2a.types import GetTaskRequest, ListTasksRequest, Message, Part, Role, SendMessageRequest
from a2a.utils.signing import create_signature_verifier

APPVIEW = os.environ['APPVIEW']
BEARER = os.environ['BEARER']
CORE = os.environ['CORE']
OWNER_CAP = os.environ['OWNER_CAP']
SKILL_AUTO = os.environ.get('SKILL_AUTO', 'eta_query@bus')
SKILL_REVIEW = os.environ.get('SKILL_REVIEW', 'price_check@bus')

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def call(skill: str, params: dict) -> SendMessageRequest:
    data = Value()
    data.struct_value.update({'skill': skill, 'params': params})
    return SendMessageRequest(
        message=Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER, parts=[Part(data=data)]),
    )


async def first_task(client, request) -> dict:
    """Send, and return the last Task state the SDK saw (streamed or not)."""
    last: dict = {}
    async for event in client.send_message(request):
        d = MessageToDict(event)
        task = d.get('task') or (d.get('statusUpdate') and {'id': d['statusUpdate']['taskId'], 'status': d['statusUpdate']['status']})
        if task:
            last = {**last, **task}
        if 'artifactUpdate' in d:
            last.setdefault('artifacts', []).append(d['artifactUpdate']['artifact'])
    return last


async def main() -> None:
    async with httpx.AsyncClient(timeout=30) as http:
        # 1. Discovery: the trust-ranked directory, by skill.
        found = (await http.get(f'{APPVIEW}/com.dinakernel.a2a.searchAgents', params={'skill': SKILL_AUTO})).json()
        agents = found.get('agents', [])
        check('directory search finds the Dina node by skill', len(agents) >= 1, json.dumps(agents[:1])[:200])
        agent = agents[0]
        endpoint = agent['endpoint']
        origin = endpoint.split('/a2a/')[0]
        listed = (await http.get(f'{APPVIEW}/com.dinakernel.a2a.getCard', params={'did': agent['did']})).json()
        check('directory serves a verified card', listed.get('signatureState') == 'verified', listed.get('signatureState', ''))

        # 2. The card, from the agent itself, verified by the SDK's own verifier (keys from the card's jku).
        jwks_cache: dict = {}

        def key_provider(kid, jku):
            if jku not in jwks_cache:
                jwks_cache[jku] = httpx.get(jku, timeout=10).json()
            return PyJWK(next(k for k in jwks_cache[jku]['keys'] if k['kid'] == kid))

        verifier = create_signature_verifier(key_provider, ['ES256', 'EdDSA'])
        authed = httpx.AsyncClient(timeout=60, headers={'Authorization': f'Bearer {BEARER}'})
        try:
            client = await create_client(
                origin, client_config=ClientConfig(httpx_client=authed, streaming=True), signature_verifier=verifier
            )
            check('SDK fetched the card and its signature verified', True)
        except Exception as e:  # noqa: BLE001
            check('SDK fetched the card and its signature verified', False, repr(e))
            return
        served = (await http.get(f'{origin}/.well-known/agent-card.json')).text
        import hashlib

        check('the card the agent serves is the card the directory indexed', hashlib.sha256(served.encode()).hexdigest() == listed.get('cardHash'))

        # 3. An auto skill, streamed: the result comes back on the stream.
        task = await first_task(client, call(SKILL_AUTO, {'route_id': '42'}))
        state = task.get('status', {}).get('state')
        check('streamed skill call completes', state == 'TASK_STATE_COMPLETED', state or json.dumps(task)[:200])
        art = json.dumps(task.get('artifacts', []))
        check('the result artifact carries the runner’s answer', 'eta_minutes' in art, art[:160])
        task_id = task.get('id')

        # 4. Read it back: GetTask and ListTasks.
        got = MessageToDict(await client.get_task(GetTaskRequest(id=task_id)))
        check('GetTask returns the completed task', got.get('status', {}).get('state') == 'TASK_STATE_COMPLETED', got.get('status', {}).get('state', ''))
        listed_tasks = MessageToDict(await client.list_tasks(ListTasksRequest(page_size=10)))
        check('ListTasks lists it', any(t.get('id') == task_id for t in listed_tasks.get('tasks', [])), str(len(listed_tasks.get('tasks', []))))

        # 5. The same skill, not streamed (a plain client).
        plain = await create_client(origin, client_config=ClientConfig(httpx_client=authed, streaming=False), signature_verifier=verifier)
        t2 = await first_task(plain, call(SKILL_AUTO, {'route_id': '7'}))
        check('non-streamed skill call answers with a Task', bool(t2.get('id')), t2.get('status', {}).get('state', ''))

        # 6. A reviewed skill: waits on the owner, then runs once approved.
        req = call(SKILL_REVIEW, {'route_id': '9'})
        req.configuration.return_immediately = True
        t3 = await first_task(plain, req)
        s3 = t3.get('status', {}).get('state')
        check('reviewed skill waits for the owner (not completed yet)', s3 in ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'), s3 or '')
        # OWNER (test harness): approve the review card on the owner's Core.
        card_id = f"a2a-in-review-{t3['id']}"
        r = await http.post(f'{CORE}/v1/workflow/tasks/{card_id}/approve', headers={'x-dina-owner-capability': OWNER_CAP}, json={})
        check('owner approves the review card', r.status_code == 200, str(r.status_code))
        final = ''
        for _ in range(40):
            final = MessageToDict(await plain.get_task(GetTaskRequest(id=t3['id']))).get('status', {}).get('state', '')
            if final in ('TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'):
                break
            await asyncio.sleep(0.5)
        check('approved call completes', final == 'TASK_STATE_COMPLETED', final)

        # 7. Refusals an outside agent can meet.
        t4 = await first_task(plain, call('teleport', {}))
        check('a skill the card does not offer is REJECTED', t4.get('status', {}).get('state') == 'TASK_STATE_REJECTED', t4.get('status', {}).get('state', ''))
        try:
            text_req = SendMessageRequest(message=Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER, parts=[Part(text='when is the bus?')]))
            await first_task(plain, text_req)
            check('plain text is refused with ContentTypeNotSupported', False, 'no error')
        except Exception as e:  # noqa: BLE001
            check('plain text is refused with ContentTypeNotSupported', 'ontent' in repr(e) or '-32005' in repr(e), repr(e)[:160])
        bad = httpx.AsyncClient(timeout=30, headers={'Authorization': 'Bearer dina_a2a_' + 'X' * 43})
        try:
            nobody = await create_client(origin, client_config=ClientConfig(httpx_client=bad, streaming=False))
            await first_task(nobody, call(SKILL_AUTO, {'route_id': '1'}))
            check('a wrong bearer is refused', False, 'no error')
        except Exception as e:  # noqa: BLE001
            check('a wrong bearer is refused', '401' in repr(e) or 'nauthenticated' in repr(e), repr(e)[:160])
        await authed.aclose()
        await bad.aclose()

    failed = [n for n, ok, _ in results if not ok]
    print(f'\n{len(results) - len(failed)} of {len(results)} passed')
    sys.exit(1 if failed else 0)


asyncio.run(main())
