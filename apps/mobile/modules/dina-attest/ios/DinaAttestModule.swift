import DeviceCheck
import ExpoModulesCore

/// Raised when DeviceCheck reports an error generating a token. The JS
/// caller maps a rejection to a transient retry (never a permanent
/// refusal — an Apple outage must not brick the device).
internal final class DeviceCheckTokenException: Exception {
  override var reason: String {
    "DeviceCheck token generation failed"
  }
}

/// Apple DeviceCheck token generator for the Starter Credits anonymous
/// claim. DeviceCheck (`DCDevice`) requires NO entitlement — it works on
/// any real device under a development or distribution provisioning
/// profile. (App Attest, the stronger documented target, is the future
/// upgrade and DOES need the app-attest entitlement.)
public class DinaAttestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DinaAttest")

    AsyncFunction("generateDeviceCheckToken") { (promise: Promise) in
      let device = DCDevice.current
      // Simulators and unsupported devices report isSupported == false.
      // Resolve null so the claim flow parks as 'unavailable' (graceful)
      // rather than surfacing an error.
      guard device.isSupported else {
        promise.resolve(nil)
        return
      }
      device.generateToken { tokenData, error in
        if error != nil {
          promise.reject(DeviceCheckTokenException())
          return
        }
        promise.resolve(tokenData?.base64EncodedString())
      }
    }
  }
}
