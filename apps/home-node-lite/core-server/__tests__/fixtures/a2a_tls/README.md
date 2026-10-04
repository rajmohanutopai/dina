Test-only TLS material for the A2A host transport tests
(`__tests__/a2a/host_transport.test.ts`). A self-signed P-256 certificate for
`localhost`, `agent.test` and `other.test`, valid for 100 years, used as its
own CA. The private key protects nothing; never use it outside tests.
