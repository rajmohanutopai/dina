// Package gatekeeper enforces sharing policies before any data leaves the vault.
// gatekeeper.go — Policy engine: checks trust ring, sharing rules, and PII
// scrubbing requirements. Every outbound datum passes through here.
package gatekeeper
