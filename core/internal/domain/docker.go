package domain

// DockerConfig holds the security-relevant Docker container configuration.
type DockerConfig struct {
	ExposedPorts    []string
	Networks        map[string]bool
	SecretsMountPath string
	EnvVars         []string
	ImageDigests    map[string]string
}

// DockerHealthConfig holds the health check configuration for a Docker service.
type DockerHealthConfig struct {
	ServiceName string
	Test        []string
	Interval    string
	Timeout     string
	Retries     int
	StartPeriod string
	Restart     string
	DependsOn   map[string]string
	Profiles    []string
}

// APIContractEndpoint describes a single API endpoint in the contract.
type APIContractEndpoint struct {
	Method     string
	Path       string
	TokenType  string
	StatusCode int
}
