Pod::Spec.new do |s|
  s.name           = 'DinaNames'
  s.version        = '1.0.0'
  s.summary        = "Finds people's names in text on the device, for Dina's PII scrub."
  s.description    = "Apple's on-device model (FoundationModels) where Apple Intelligence is on, NLTagger otherwise. Returns candidate names only; Brain decides what to hide (docs/PII_ARCHITECTURE_V2.md §7)."
  s.license        = 'MIT'
  s.author         = 'Dina'
  s.homepage       = 'https://github.com/rajmohanutopai/dina'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'NaturalLanguage'
  # Present from iOS 26; weak so the app still runs on older iPhones.
  s.weak_frameworks = 'FoundationModels'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
