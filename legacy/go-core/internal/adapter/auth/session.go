// Package auth provides authentication and session management adapters.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// Session represents an active browser session.
type Session struct {
	ID        string
	DeviceID  string
	CSRFToken string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// SessionStore manages browser sessions with CSRF protection.
// Sessions are stored in memory and expire after a configurable duration.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	ttl      time.Duration
}

// NewSessionStore creates a session store with the given session TTL.
func NewSessionStore(ttl time.Duration) *SessionStore {
	return &SessionStore{
		sessions: make(map[string]*Session),
		ttl:      ttl,
	}
}

// Create creates a new session for the given device.
// Returns the session ID and CSRF token.
func (s *SessionStore) Create(deviceID string) (sessionID, csrfToken string, err error) {
	sid, err := randomHex(32)
	if err != nil {
		return "", "", fmt.Errorf("generate session ID: %w", err)
	}
	csrf, err := randomHex(32)
	if err != nil {
		return "", "", fmt.Errorf("generate CSRF token: %w", err)
	}

	now := time.Now()
	session := &Session{
		ID:        sid,
		DeviceID:  deviceID,
		CSRFToken: csrf,
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
	}

	s.mu.Lock()
	s.sessions[sid] = session
	s.mu.Unlock()

	return sid, csrf, nil
}

// Validate checks if a session is valid and not expired.
// Returns the session if valid, or an error.
func (s *SessionStore) Validate(sessionID, csrfToken string) (*Session, error) {
	s.mu.RLock()
	session, ok := s.sessions[sessionID]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("session not found")
	}

	if time.Now().After(session.ExpiresAt) {
		s.Revoke(sessionID)
		return nil, fmt.Errorf("session expired")
	}

	if session.CSRFToken != csrfToken {
		return nil, fmt.Errorf("CSRF token mismatch")
	}

	return session, nil
}

// Revoke removes a session.
func (s *SessionStore) Revoke(sessionID string) {
	s.mu.Lock()
	delete(s.sessions, sessionID)
	s.mu.Unlock()
}

// RevokeAll removes all sessions for a device.
func (s *SessionStore) RevokeAll(deviceID string) {
	s.mu.Lock()
	for id, session := range s.sessions {
		if session.DeviceID == deviceID {
			delete(s.sessions, id)
		}
	}
	s.mu.Unlock()
}

// Cleanup removes all expired sessions.
func (s *SessionStore) Cleanup() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	count := 0
	for id, session := range s.sessions {
		if now.After(session.ExpiresAt) {
			delete(s.sessions, id)
			count++
		}
	}
	return count
}

// randomHex generates a cryptographically random hex string of the given byte length.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
