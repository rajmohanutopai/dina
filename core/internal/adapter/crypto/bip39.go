package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"fmt"
	"strings"

	"github.com/anthropics/dina/core/internal/port"
	"golang.org/x/crypto/pbkdf2"
)

// Compile-time check: BIP39Generator satisfies port.MnemonicGenerator.
var _ port.MnemonicGenerator = (*BIP39Generator)(nil)

// BIP39Generator implements testutil.MnemonicGenerator — BIP-39 mnemonic operations.
type BIP39Generator struct {
	wordIndex map[string]int // word → index for fast lookup
}

// NewBIP39Generator returns a new BIP-39 generator.
func NewBIP39Generator() *BIP39Generator {
	idx := make(map[string]int, 2048)
	for i, w := range bip39Wordlist {
		idx[w] = i
	}
	return &BIP39Generator{wordIndex: idx}
}

// Generate creates a new 24-word BIP-39 mnemonic from 256 bits of entropy
// and derives the 512-bit seed using PBKDF2-HMAC-SHA512.
func (g *BIP39Generator) Generate() (mnemonic string, seed []byte, err error) {
	// 256 bits of entropy.
	entropy := make([]byte, 32)
	if _, err := rand.Read(entropy); err != nil {
		return "", nil, fmt.Errorf("bip39: entropy generation: %w", err)
	}

	mnemonic, err = entropyToMnemonic(entropy, g.wordIndex)
	if err != nil {
		return "", nil, err
	}

	seed, err = g.ToSeed(mnemonic, "")
	if err != nil {
		return "", nil, err
	}

	return mnemonic, seed, nil
}

// Validate checks a mnemonic for word count, wordlist membership, and checksum.
// Only 24-word mnemonics (256-bit entropy) are accepted.
func (g *BIP39Generator) Validate(mnemonic string) error {
	words := normalizeWords(mnemonic)

	if len(words) != 24 {
		return fmt.Errorf("bip39: expected 24 words, got %d", len(words))
	}

	// Check all words are in the wordlist.
	for _, w := range words {
		if _, ok := g.wordIndex[w]; !ok {
			return fmt.Errorf("bip39: word %q not in wordlist", w)
		}
	}

	// Verify checksum: convert words back to entropy + checksum bits.
	// 24 words × 11 bits = 264 bits = 256 bits entropy + 8 bits checksum.
	var bits [264]bool
	for i, w := range words {
		idx := g.wordIndex[w]
		for j := 0; j < 11; j++ {
			bits[i*11+j] = (idx>>(10-j))&1 == 1
		}
	}

	// Extract entropy (first 256 bits).
	entropy := make([]byte, 32)
	for i := 0; i < 256; i++ {
		if bits[i] {
			entropy[i/8] |= 1 << (7 - uint(i%8))
		}
	}

	// Compute expected checksum: first 8 bits of SHA-256(entropy).
	hash := sha256.Sum256(entropy)
	for i := 0; i < 8; i++ {
		expected := (hash[0]>>(7-uint(i)))&1 == 1
		if bits[256+i] != expected {
			return fmt.Errorf("bip39: invalid checksum")
		}
	}

	return nil
}

// EntropyToMnemonic converts 32 bytes of entropy to a 24-word BIP-39 mnemonic.
func (g *BIP39Generator) EntropyToMnemonic(entropy []byte) (string, error) {
	return entropyToMnemonic(entropy, g.wordIndex)
}

// ToSeed converts a mnemonic + optional passphrase to a 512-bit seed.
// Uses PBKDF2-HMAC-SHA512 with 2048 iterations, salt = "mnemonic" + passphrase.
func (g *BIP39Generator) ToSeed(mnemonic string, passphrase string) ([]byte, error) {
	words := normalizeWords(mnemonic)
	normalized := strings.Join(words, " ")

	salt := "mnemonic" + passphrase
	seed := pbkdf2.Key([]byte(normalized), []byte(salt), 2048, 64, sha512.New)
	return seed, nil
}

// entropyToMnemonic converts 256 bits of entropy to a 24-word mnemonic.
func entropyToMnemonic(entropy []byte, wordIndex map[string]int) (string, error) {
	if len(entropy) != 32 {
		return "", fmt.Errorf("bip39: entropy must be 32 bytes")
	}

	// Checksum: first 8 bits of SHA-256(entropy).
	hash := sha256.Sum256(entropy)

	// Concatenate entropy (256 bits) + checksum (8 bits) = 264 bits.
	var bits [264]bool
	for i := 0; i < 256; i++ {
		bits[i] = (entropy[i/8]>>(7-uint(i%8)))&1 == 1
	}
	for i := 0; i < 8; i++ {
		bits[256+i] = (hash[0]>>(7-uint(i)))&1 == 1
	}

	// Split into 24 groups of 11 bits, map to words.
	words := make([]string, 24)
	for i := 0; i < 24; i++ {
		var idx int
		for j := 0; j < 11; j++ {
			if bits[i*11+j] {
				idx |= 1 << (10 - j)
			}
		}
		if idx < 0 || idx >= 2048 {
			return "", fmt.Errorf("bip39: word index %d out of range", idx)
		}
		words[i] = bip39Wordlist[idx]
	}

	return strings.Join(words, " "), nil
}

// normalizeWords splits a mnemonic into words, normalizing whitespace.
func normalizeWords(mnemonic string) []string {
	return strings.Fields(strings.TrimSpace(mnemonic))
}
