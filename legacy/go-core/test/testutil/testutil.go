package testutil

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// Resettable is an optional interface for implementations that need
// per-test state isolation. When a type implements Resettable,
// RequireImplementation calls ResetForTest before each test to ensure
// clean state without losing persistent data (e.g., created DIDs).
type Resettable interface {
	ResetForTest()
}

// RequireImplementation skips the test if impl is nil, indicating
// the real implementation is not yet available.
// This is the contract-first TDD skip pattern: tests define the contract,
// implementations satisfy it. Until impl is wired in, the test is skipped.
// If impl implements Resettable, ResetForTest is called for per-test isolation.
func RequireImplementation(t *testing.T, impl interface{}, name string) {
	t.Helper()
	if impl == nil {
		t.Skipf("implementation not yet available: %s — wire in the real implementation to activate this test", name)
	}
	if r, ok := impl.(Resettable); ok {
		r.ResetForTest()
	}
}

// TempDir creates a temporary directory scoped to the test.
// The directory is automatically removed when the test completes.
func TempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "dina-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// TempFile creates a temporary file with the given content inside dir.
func TempFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	// Ensure parent directories exist (e.g., "subdir/file.txt").
	if parent := filepath.Dir(path); parent != dir {
		if err := os.MkdirAll(parent, 0700); err != nil {
			t.Fatalf("failed to create parent directory %s: %v", parent, err)
		}
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("failed to create temp file %s: %v", path, err)
	}
	return path
}

// AssertConstantTime checks that two operations complete in approximately
// the same duration, within the given tolerance. This is for validating
// timing-attack resistance in auth comparisons.
func AssertConstantTime(t *testing.T, op1, op2 func(), tolerance time.Duration, iterations int) {
	t.Helper()
	if iterations < 10 {
		iterations = 10
	}
	var sum1, sum2 time.Duration
	for i := 0; i < iterations; i++ {
		start := time.Now()
		op1()
		sum1 += time.Since(start)

		start = time.Now()
		op2()
		sum2 += time.Since(start)
	}
	avg1 := sum1 / time.Duration(iterations)
	avg2 := sum2 / time.Duration(iterations)
	diff := avg1 - avg2
	if diff < 0 {
		diff = -diff
	}
	if diff > tolerance {
		t.Errorf("constant-time violation: op1 avg=%v, op2 avg=%v, diff=%v (tolerance=%v)", avg1, avg2, diff, tolerance)
	}
}

// RequireEqual fails the test if got != want.
func RequireEqual(t *testing.T, got, want interface{}) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// RequireNoError fails the test if err is not nil.
func RequireNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// RequireError fails the test if err is nil.
func RequireError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
}

// RequireTrue fails the test if b is false.
func RequireTrue(t *testing.T, b bool, msg string) {
	t.Helper()
	if !b {
		t.Fatalf("expected true: %s", msg)
	}
}

// RequireFalse fails the test if b is true.
func RequireFalse(t *testing.T, b bool, msg string) {
	t.Helper()
	if b {
		t.Fatalf("expected false: %s", msg)
	}
}

// RequireLen fails the test if the length doesn't match.
func RequireLen(t *testing.T, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("length mismatch: got %d, want %d", got, want)
	}
}

// RequireNil fails the test if v is not nil.
// Handles Go's typed-nil-in-interface gotcha (e.g., ([]byte)(nil) wrapped in interface{}).
func RequireNil(t *testing.T, v interface{}) {
	t.Helper()
	if v == nil {
		return
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Ptr, reflect.Slice, reflect.Map, reflect.Interface, reflect.Chan, reflect.Func:
		if rv.IsNil() {
			return
		}
	}
	t.Fatalf("expected nil, got %v", v)
}

// RequireNotNil fails the test if v is nil.
func RequireNotNil(t *testing.T, v interface{}) {
	t.Helper()
	if v == nil {
		t.Fatal("expected non-nil value")
	}
}

// RequireContains fails if substr is not in s.
func RequireContains(t *testing.T, s, substr string) {
	t.Helper()
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return
		}
	}
	t.Fatalf("expected %q to contain %q", s, substr)
}

// RequireHasPrefix fails if s does not start with prefix.
func RequireHasPrefix(t *testing.T, s, prefix string) {
	t.Helper()
	if len(s) < len(prefix) || s[:len(prefix)] != prefix {
		t.Fatalf("expected %q to have prefix %q", s, prefix)
	}
}

// RequireBytesLen fails if b does not have the expected length.
func RequireBytesLen(t *testing.T, b []byte, want int) {
	t.Helper()
	if len(b) != want {
		t.Fatalf("byte length mismatch: got %d, want %d", len(b), want)
	}
}

// RequireBytesNotEqual fails if a and b are equal.
func RequireBytesNotEqual(t *testing.T, a, b []byte) {
	t.Helper()
	if len(a) != len(b) {
		return // different lengths = not equal
	}
	for i := range a {
		if a[i] != b[i] {
			return
		}
	}
	t.Fatal("expected byte slices to be different, but they are equal")
}

// RequireBytesEqual fails if a and b are not equal.
func RequireBytesEqual(t *testing.T, a, b []byte) {
	t.Helper()
	if len(a) != len(b) {
		t.Fatalf("byte length mismatch: got %d, want %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("byte mismatch at index %d: got 0x%02x, want 0x%02x", i, a[i], b[i])
		}
	}
}
