1. OpenAPI is not fully integrated. Still integration works with hand coded (AI coded) interfaces. While the OpenAPI interface exists, it is not used


2. Auth structure is not perfect


  Auth Vocabulary

  1. principal

  - The authority the request is using.
  - Values: user, agent

  2. actor

  - The component actually making the request.
  - Values: brain, device, admin_backend, connector, socket_admin

  3. origin

  - Where the action came from.
  - Values: telegram, whatsapp, admin, cli, connector, scheduler, system

  4. auth_mode

  - How the authority was obtained.
  - Values:
      - direct_user
      - delegated_user
      - autonomous_agent
      - elevated_agent

  Meaning

  - direct_user
      - user acting directly through admin/backend path
  - delegated_user
      - Brain acting on behalf of a user message from Telegram/WhatsApp/admin
  - autonomous_agent
      - CLI/Brain/connector acting for itself
  - elevated_agent
      - agent with an active session grant for restricted personas

  Enterprise mapping

  - delegated_user = on-behalf-of / delegation
  - elevated_agent = step-up / JIT / elevated access

  They are different and should stay different.

  Core rule

  Authorization should depend on:

  1. principal
  2. auth_mode
  3. session grant
  4. persona tier

  It should not depend directly on transport details like “was this Brain?” except for whether Brain is allowed to claim delegated user mode.

  Request Context

  I would put these in request context:

  - principal_type
  - actor_type
  - origin
  - auth_mode
  - agent_did
  - session_name
  - request_id

  Optional:

  - delegated_user_id if you later have a first-class user identity

  Eligibility rules

  1. Only trusted actors may claim delegated_user

  - brain
  - maybe admin_backend
  - not device
  - not connector

  2. delegated_user requires validated origin

  - telegram
  - whatsapp
  - admin
  - exact allowlist in Core

  3. elevated_agent is never caller-declared

  - it is derived at authz time from:
      - principal=agent
      - session exists
      - session has active grant for persona

  Persona enforcement

  I would make the tier rules explicit:

  1. default

  - user: allowed
  - agent: allowed

  2. standard

  - user: allowed
  - agent: requires session grant

  3. sensitive

  - direct_user: allowed
  - delegated_user: allowed
  - autonomous_agent: requires session grant
  - elevated_agent: allowed

  4. locked

  - requires explicit unlock
  - after unlock:
      - direct_user: allowed
      - delegated_user: allowed
      - agent: denied unless you explicitly want a stronger elevated-agent path here

  My recommendation: keep locked user-only even after unlock.

  Examples

  1. Telegram message handled by Brain

  - principal=user
  - actor=brain
  - origin=telegram
  - auth_mode=delegated_user

  2. Brain nightly summarizer

  - principal=agent
  - actor=brain
  - origin=scheduler
  - auth_mode=autonomous_agent

  3. CLI with approved health session

  - principal=agent
  - actor=device
  - origin=cli
  - auth_mode=elevated_agent

  4. Admin UI action

  - principal=user
  - actor=admin_backend
  - origin=admin
  - auth_mode=direct_user

  What should change in code

  Use this model to refactor:

  - auth context creation:
      - auth.go:141
  - delegated-user elevation:
      - vault.go:61
  - persona tier enforcement:
      - identity.go:1037
  - shared vault auth gate:
      - vault.go:63
  - staging bypass that should be removed:
      - staging.go:132

  Key design decision

  brain should not be a principal class.

  Brain is an actor.
  The principal is either:

  - user
  - or agent


