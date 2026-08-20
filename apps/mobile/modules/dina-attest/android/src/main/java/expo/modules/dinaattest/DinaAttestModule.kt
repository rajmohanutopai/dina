package expo.modules.dinaattest

import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityToken
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android attestation for the Starter Credits anonymous claim — the
 * Kotlin counterpart of the iOS DeviceCheck module.
 *
 * Uses the Play Integrity STANDARD API, which is the flow Device Recall
 * rides on: the server reads the recall bits out of the decoded token to
 * enforce one grant per physical device. `prepareIntegrityToken` warms a
 * provider once per cloud project (cached here); `request` mints a token
 * bound to a per-request hash from JS.
 *
 * Graceful by construction — matching the iOS module, a path where no
 * genuine token can be produced resolves null (→ the claim parks as
 * 'unavailable' and BYOK stays the door); a real Play-side error rejects,
 * which the JS seam maps to a transient retry, never a permanent refusal.
 */
class DinaAttestModule : Module() {
  // The Standard API's prepare step is the slow one; cache the warmed
  // provider so repeated claims for the same project skip it.
  private var tokenProvider: StandardIntegrityTokenProvider? = null
  private var preparedProject: Long = 0L

  override fun definition() = ModuleDefinition {
    Name("DinaAttest")

    // iOS-only surface, present here so the JS contract is stable across
    // platforms — DeviceCheck does not exist on Android.
    AsyncFunction("generateDeviceCheckToken") { promise: Promise ->
      promise.resolve(null)
    }

    AsyncFunction("generatePlayIntegrityToken") {
        cloudProjectNumber: Double,
        requestHash: String,
        promise: Promise ->
      val project = cloudProjectNumber.toLong()
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.resolve(null)
        return@AsyncFunction
      }

      fun requestToken(provider: StandardIntegrityTokenProvider) {
        provider
          .request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
          .addOnSuccessListener { token: StandardIntegrityToken -> promise.resolve(token.token()) }
          .addOnFailureListener { e ->
            promise.reject(
              CodedException("ERR_PLAY_INTEGRITY_REQUEST", e.message ?: "request failed", e),
            )
          }
      }

      val cached = tokenProvider
      if (cached != null && preparedProject == project) {
        requestToken(cached)
        return@AsyncFunction
      }

      IntegrityManagerFactory.createStandard(context)
        .prepareIntegrityToken(
          PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(project).build(),
        )
        .addOnSuccessListener { provider: StandardIntegrityTokenProvider ->
          tokenProvider = provider
          preparedProject = project
          requestToken(provider)
        }
        .addOnFailureListener { e ->
          promise.reject(
            CodedException("ERR_PLAY_INTEGRITY_PREPARE", e.message ?: "prepare failed", e),
          )
        }
    }
  }
}
