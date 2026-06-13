Pod::Spec.new do |s|
  s.name           = 'DinaAttest'
  s.version        = '1.0.0'
  s.summary        = 'Dina device attestation (Apple DeviceCheck) for Starter Credits.'
  s.description    = 'Generates a DeviceCheck token used by the anonymous grant claim. DeviceCheck needs no special entitlement.'
  s.license        = 'MIT'
  s.author         = 'Dina'
  s.homepage       = 'https://github.com/rajmohanutopai/dina'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # DeviceCheck.framework is a system framework — linked explicitly so the
  # static build always resolves DCDevice regardless of weak-link defaults.
  s.frameworks = 'DeviceCheck'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
