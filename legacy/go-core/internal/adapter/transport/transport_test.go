package transport

import "testing"

// TRACE: {"suite": "CORE", "case": "2144", "section": "07", "sectionName": "Transport Layer", "subsection": "01", "scenario": "01", "title": "IsHostAllowed"}
func TestIsHostAllowed(t *testing.T) {
	tests := []struct {
		name     string
		host     string
		allowed  string
		expected bool
	}{
		{
			name:     "bare hostname match",
			host:     "alonso-core",
			allowed:  "alonso-core,sancho-core",
			expected: true,
		},
		{
			name:     "URL-format match",
			host:     "alonso-core",
			allowed:  "http://alonso-core:8100,http://sancho-core:8100",
			expected: true,
		},
		{
			name:     "URL-format second entry",
			host:     "sancho-core",
			allowed:  "http://alonso-core:8100,http://sancho-core:8100",
			expected: true,
		},
		{
			name:     "mixed format",
			host:     "albert-core",
			allowed:  "http://alonso-core:8100,sancho-core,http://albert-core:8100",
			expected: true,
		},
		{
			name:     "no match",
			host:     "evil-server",
			allowed:  "http://alonso-core:8100,sancho-core",
			expected: false,
		},
		{
			name:     "empty allowlist",
			host:     "alonso-core",
			allowed:  "",
			expected: false,
		},
		{
			name:     "whitespace in entries",
			host:     "alonso-core",
			allowed:  " http://alonso-core:8100 , sancho-core ",
			expected: true,
		},
		{
			name:     "https URL format",
			host:     "secure-core",
			allowed:  "https://secure-core:443",
			expected: true,
		},
		{
			name:     "URL with path does not confuse hostname",
			host:     "alonso-core",
			allowed:  "http://alonso-core:8100/msg",
			expected: true,
		},
		{
			name:     "partial hostname no match",
			host:     "alonso",
			allowed:  "http://alonso-core:8100",
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isHostAllowed(tt.host, tt.allowed)
			if got != tt.expected {
				t.Errorf("isHostAllowed(%q, %q) = %v, want %v",
					tt.host, tt.allowed, got, tt.expected)
			}
		})
	}
}
