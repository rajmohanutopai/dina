Pod::Spec.new do |s|
  s.name           = 'DinaNet'
  s.version        = '1.0.0'
  s.summary        = "Dina's pinned HTTP transport (resolve, vet in JS, connect to one address)."
  s.description    = 'Resolves names with the system resolver and runs one HTTP/1.1 exchange over TLS to exactly one vetted address, so outbound fetches can refuse special-use addresses and pin the socket (UCP plan §3.4).'
  s.license        = 'MIT'
  s.author         = 'Dina'
  s.homepage       = 'https://github.com/rajmohanutopai/dina'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network', 'Security'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
