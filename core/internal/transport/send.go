// send.go — Outbound message delivery. Resolves recipient DID → endpoint,
// encrypts with NaCl crypto_box_seal, POSTs to recipient's /msg endpoint.
package transport
