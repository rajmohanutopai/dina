// Package proxy provides an HTTP reverse proxy for brain's admin UI.
// Routes /admin/* requests from core's authenticated endpoint to brain,
// adding BRAIN_TOKEN authentication.
package proxy
