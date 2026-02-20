// msg.go — Dina-to-Dina messaging endpoint.
// POST /msg — receives NaCl-encrypted DIDComm messages.
// Implements the 3-valve ingress system (rate limit → spool → sweeper).
package v1
