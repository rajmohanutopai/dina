package domain

// PDSRecord holds a signed AT Protocol record for publication.
type PDSRecord struct {
	Collection string
	RecordKey  string
	Payload    map[string]interface{}
	Signature  []byte
	AuthorDID  string
}

// Tombstone represents a signed deletion marker for an AT Protocol record.
type Tombstone struct {
	Target    string // record key being deleted
	AuthorDID string // DID of the original author
	Signature []byte // Ed25519 signature
}
