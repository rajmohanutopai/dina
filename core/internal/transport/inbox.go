// inbox.go — Inbound message handler. Implements the 3-valve ingress system:
// Valve 1 (IP rate limit), Valve 2 (spool cap when locked),
// Valve 3 (sweeper on unlock). See ARCHITECTURE.md "Dead Drop Ingress".
package transport
