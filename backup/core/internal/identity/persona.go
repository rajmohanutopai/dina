// persona.go — Persona management. Each persona is a separate cryptographic
// compartment with its own DID, keys, and SQLCipher database.
// Personas cannot cross-reference each other without explicit user action.
package identity
