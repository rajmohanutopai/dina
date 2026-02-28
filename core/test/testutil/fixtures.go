package testutil

// Deterministic test data for contract-first TDD.
// Values are from published specifications (BIP-39, SLIP-0010, RFC 5869)
// or are fixed constants for repeatable testing.

// ---------- BIP-39 Test Vectors (§2.1) ----------

// TestMnemonic24 is the standard BIP-39 test vector (24 words, 256-bit entropy).
// Source: https://github.com/trezor/python-mnemonic/blob/master/vectors.json
const TestMnemonic24 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"

// TestMnemonicSeed is the expected 512-bit seed for TestMnemonic24 with empty passphrase.
// PBKDF2-HMAC-SHA512, 2048 iterations, salt = "mnemonic".
var TestMnemonicSeed = []byte{
	0x40, 0x8b, 0x28, 0x5c, 0x12, 0x38, 0x36, 0x00, 0x4f, 0x4b,
	0x88, 0x42, 0xc8, 0x93, 0x24, 0xc1, 0xf0, 0x13, 0x82, 0x45,
	0x0c, 0x0d, 0x43, 0x9a, 0xf3, 0x45, 0xba, 0x7f, 0xc4, 0x9a,
	0xcf, 0x70, 0x54, 0x89, 0xc6, 0xfc, 0x77, 0xdb, 0xd4, 0xe3,
	0xdc, 0x1d, 0xd8, 0xcc, 0x6b, 0xc9, 0xf0, 0x43, 0xdb, 0x8a,
	0xda, 0x1e, 0x24, 0x3c, 0x4a, 0x0e, 0xaf, 0xb2, 0x90, 0xd3,
	0x99, 0x48, 0x08, 0x40,
}

// TestMnemonicInvalidChecksum has a bad last word.
const TestMnemonicInvalidChecksum = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zoo"

// TestMnemonic12Word is 12 words where 24 are expected.
const TestMnemonic12Word = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

// TestMnemonicExtraSpaces has multiple spaces between words.
const TestMnemonicExtraSpaces = "abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  art"

// ---------- SLIP-0010 Test Vectors (§2.2) ----------

// DinaDerivationPath is the reserved SLIP-0010 purpose for Dina identity keys.
const DinaDerivationPath = "m/9999'"

// DinaRootKeyPath derives the root identity key.
const DinaRootKeyPath = "m/9999'/0'"

// DinaPersonaPaths maps built-in persona indexes.
var DinaPersonaPaths = map[string]string{
	"root":         "m/9999'/0'",
	"consumer":     "m/9999'/1'",
	"professional": "m/9999'/2'",
	"social":       "m/9999'/3'",
	"health":       "m/9999'/4'",
	"financial":    "m/9999'/5'",
	"citizen":      "m/9999'/6'",
}

// ForbiddenBIP44Path must be rejected by the Dina key derivation API.
const ForbiddenBIP44Path = "m/44'/0'"

// NonHardenedPath should be rejected (only hardened derivation allowed).
const NonHardenedPath = "m/9999/0"

// FirstCustomPersonaIndex is the first available index for user-created personas.
const FirstCustomPersonaIndex = 7

// ---------- HKDF-SHA256 Test Vectors (§2.3) ----------

// HKDFInfoStrings are the expected info strings for per-persona DEK derivation.
var HKDFInfoStrings = map[string]string{
	"identity":   "dina:vault:identity:v1",
	"personal":   "dina:vault:personal:v1",
	"health":     "dina:vault:health:v1",
	"financial":  "dina:vault:financial:v1",
	"social":     "dina:vault:social:v1",
	"consumer":   "dina:vault:consumer:v1",
	"backup":     "dina:backup:v1",
	"archive":    "dina:archive:v1",
	"sync":       "dina:sync:v1",
	"trust": "dina:trust:v1",
}

// TestUserSalt is a deterministic 32-byte salt for testing.
var TestUserSalt = [32]byte{
	0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
	0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
	0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
}

// ---------- Argon2id Parameters (§2.4) ----------

const (
	Argon2idMemoryMB    = 128
	Argon2idIterations  = 3
	Argon2idParallelism = 4
	Argon2idSaltLen     = 16
)

// TestPassphrase is a known passphrase for testing.
const TestPassphrase = "correct horse battery staple"
const TestPassphraseWrong = "wrong horse battery staple"

// TestPassphraseHash is an Argon2id hash of TestPassphrase in PHC format.
// Computed from auth.HashPassphrase(TestPassphrase, TestUserSalt[:16]).
// This is set at init time by the test wiring layer; use SetupPersonaWithPassphrase
// to configure a PersonaManager for unlock tests.
var TestPassphraseHash string

// ---------- Ed25519 Test Keypair (§2.5) ----------

// TestEd25519Seed is a deterministic 32-byte seed for Ed25519 key generation.
var TestEd25519Seed = [32]byte{
	0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
	0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
	0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
	0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
}

// TestMessage is a known message for sign/verify tests.
var TestMessage = []byte("dina test message for signing")

// ---------- AES-256-GCM Test Vectors (§2.8) ----------

// TestDEK is a deterministic 32-byte data encryption key.
var TestDEK = [32]byte{
	0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
	0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
	0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
	0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
}

// TestKEK is a deterministic 32-byte key encryption key.
var TestKEK = [32]byte{
	0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
	0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
	0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
	0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
}

// ---------- DID Test Vectors (§3) ----------

// TestDIDKeyPrefix is the expected prefix for did:key Ed25519 identifiers.
const TestDIDKeyPrefix = "did:key:z6Mk"

// ---------- PII Test Cases (§5) ----------

// PIITestCase holds input/expected pairs for PII scrubbing.
type PIITestCase struct {
	Name     string
	Input    string
	Expected string
	Entities []string
}

// PIITestCases covers the standard Tier 1 regex patterns.
var PIITestCases = []PIITestCase{
	{
		Name:     "email",
		Input:    "Email me at john@example.com",
		Expected: "Email me at [EMAIL_1]",
		Entities: []string{"john@example.com"},
	},
	{
		Name:     "phone_us",
		Input:    "Call 555-123-4567",
		Expected: "Call [PHONE_1]",
		Entities: []string{"555-123-4567"},
	},
	{
		Name:     "ssn",
		Input:    "SSN 123-45-6789",
		Expected: "SSN [SSN_1]",
		Entities: []string{"123-45-6789"},
	},
	{
		Name:     "credit_card",
		Input:    "Card 4111-1111-1111-1111",
		Expected: "Card [CREDIT_CARD_1]",
		Entities: []string{"4111-1111-1111-1111"},
	},
	{
		Name:     "multiple_emails",
		Input:    "From john@example.com to jane@example.com",
		Expected: "From [EMAIL_1] to [EMAIL_2]",
		Entities: []string{"john@example.com", "jane@example.com"},
	},
	{
		Name:     "no_pii",
		Input:    "The weather is nice today",
		Expected: "The weather is nice today",
		Entities: nil,
	},
	{
		Name:     "mixed_pii",
		Input:    "Contact john@example.com or call 555-123-4567",
		Expected: "Contact [EMAIL_1] or call [PHONE_1]",
		Entities: []string{"john@example.com", "555-123-4567"},
	},
}

// ---------- Vault Test Data (§4) ----------

// TestVaultItem returns a valid VaultItem for testing.
func TestVaultItem() VaultItem {
	return VaultItem{
		ID:         "test-item-001",
		Type:       "email",
		Source:     "gmail",
		SourceID:   "msg-abc123",
		ContactDID: "did:key:z6MkTestContact",
		Summary:    "Meeting reminder for Thursday",
		BodyText:   "Hi, just a reminder about our meeting on Thursday at 2pm.",
		Timestamp:  1700000000,
		IngestedAt: 1700000001,
		Metadata:   `{"labels": ["inbox", "primary"]}`,
	}
}

// TestVaultItems returns a batch of items for batch-testing.
func TestVaultItems(n int) []VaultItem {
	items := make([]VaultItem, n)
	for i := range items {
		items[i] = VaultItem{
			ID:         "test-item-" + padInt(i),
			Type:       "email",
			Source:     "gmail",
			SourceID:   "msg-" + padInt(i),
			Summary:    "Test item " + padInt(i),
			BodyText:   "Body text for test item " + padInt(i),
			Timestamp:  int64(1700000000 + i),
			IngestedAt: int64(1700000001 + i),
		}
	}
	return items
}

func padInt(i int) string {
	s := "000"
	n := ""
	if i < 10 {
		n = s[:2]
	} else if i < 100 {
		n = s[:1]
	}
	return n + intToStr(i)
}

func intToStr(i int) string {
	if i == 0 {
		return "0"
	}
	digits := []byte{}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

// ---------- Transport Test Data (§7) ----------

// TestEnvelope returns a valid D2D message envelope for testing.
func TestEnvelope() []byte {
	return []byte(`{"from":"did:key:z6MkSender","to":"did:key:z6MkRecipient","type":"message","body":"hello"}`)
}

// TestD2DMessage returns a valid DIDComm-compatible plaintext message.
func TestD2DMessage() D2DMessage {
	return D2DMessage{
		ID:          "msg_20260220_abc123",
		Type:        "dina/social/arrival",
		From:        "did:plc:sender123",
		To:          []string{"did:plc:recipient456"},
		CreatedTime: 1740000000,
		Body:        []byte(`{"text":"I am arriving in 15 minutes"}`),
	}
}

// TestOutboxMessage returns a valid outbox message for testing.
func TestOutboxMessage() OutboxMessage {
	return OutboxMessage{
		ToDID:     "did:plc:recipient456",
		Payload:   []byte(`encrypted-payload-blob`),
		CreatedAt: 1740000000,
		NextRetry: 1740000030,
		Retries:   0,
		Status:    "pending",
		Priority:  5,
	}
}

// Phase1RecognizedCategories is the list of recognized sharing categories in Phase 1.
var Phase1RecognizedCategories = []string{
	"presence", "availability", "context", "preferences", "location", "health",
}

// DefaultSharingPolicy returns the default sharing policy for new contacts.
func DefaultSharingPolicy() map[string]string {
	return map[string]string{
		"presence":     "eta_only",
		"availability": "free_busy",
		"context":      "summary",
		"preferences":  "full",
		"location":     "none",
		"health":       "none",
	}
}

// ---------- Task Queue Test Data (§8) ----------

// TestTask returns a valid task for queue testing.
func TestTask() Task {
	return Task{
		Type:     "sync_gmail",
		Priority: 5,
		Payload:  []byte(`{"connector": "gmail", "cursor": "2026-01-01T00:00:00Z"}`),
		Status:   "pending",
	}
}

// TestReminder returns a valid reminder for testing.
func TestReminder(triggerAt int64) Reminder {
	return Reminder{
		Message:   "License renewal",
		TriggerAt: triggerAt,
		Fired:     false,
	}
}

// ---------- Auth Test Data (§1) ----------

// TestBrainToken is a deterministic BRAIN_TOKEN for testing.
const TestBrainToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// TestBrainTokenWrong is an incorrect BRAIN_TOKEN.
const TestBrainTokenWrong = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

// TestClientToken is a deterministic CLIENT_TOKEN for testing.
const TestClientToken = "client-token-0123456789abcdef0123456789abcdef0123456789abcdef01"

// ---------- Config Test Data (§14) ----------

// TestConfig returns a valid Config for testing.
func TestConfig() Config {
	return Config{
		ListenAddr:     ":8300",
		AdminAddr:      ":8100",
		VaultPath:      "/var/lib/dina",
		BrainURL:       "http://brain:8200",
		BrainToken:     TestBrainToken,
		SecurityMode:   "security",
		SessionTTL:     86400,
		RateLimit:      60,
		SpoolMax:       1000,
		BackupInterval: 24,
	}
}

// ---------- SQLCipher PRAGMAs (§4.1) ----------

// ExpectedVaultPragmas lists the PRAGMAs that must be set on every vault connection.
var ExpectedVaultPragmas = map[string]string{
	"cipher_page_size": "4096",
	"journal_mode":     "wal",
	"synchronous":      "1", // NORMAL
	"foreign_keys":     "1", // ON
	"busy_timeout":     "5000",
}
