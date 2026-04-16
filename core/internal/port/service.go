package port

// ServiceConfigStore reads and writes the local service configuration.
// The service config determines whether this Home Node operates as a
// public service (accepting D2D queries from non-contacts).
type ServiceConfigStore interface {
	// Get returns the service config JSON, or empty string if not set.
	Get() (string, error)
	// Put stores the service config JSON.
	Put(configJSON string) error
}

// PublicServiceResolver checks whether a remote DID is a published public service.
// Used by the egress contact-gate bypass to allow service.query to non-contacts.
type PublicServiceResolver interface {
	// IsPublicService returns true if the DID has a published public service
	// profile with the given capability. Returns (false, nil) if the DID is
	// not public or the capability is not supported. Fails closed on error.
	IsPublicService(did string, capability string) (bool, error)
}
