// breaker.go — Circuit breaker for brain HTTP calls.
// Opens after N consecutive failures, half-opens after cooldown,
// closes on successful probe. Prevents cascading failures.
package brainclient
