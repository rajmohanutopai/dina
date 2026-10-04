Test-only TLS material for the A2A host transport tests
(`__tests__/a2a_host_transport.test.ts`). A self-signed P-256 certificate for
`localhost`, `agent.test` and `other.test`, valid for 100 years, used as its
own CA. The private key protects nothing; never use it outside tests.

The same pair lives in `apps/home-node-lite/core-server/__tests__/fixtures/a2a_tls/`
for core-server's reference-agent end-to-end test; each package's tests read
only their own copy.
