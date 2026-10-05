package expo.modules.dinanet

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Connection
import okhttp3.ConnectionSpec
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.TlsVersion
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.NoRouteToHostException
import java.net.Proxy
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.UnknownServiceException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLException

/** One pinned exchange, as `@dina/net-expo/policy_socket` sends it (`NativePinnedRequest`). */
class PinnedRequest : Record {
  @Field val method: String = "GET"
  @Field val url: String = ""
  @Field val address: String = ""
  @Field val headers: List<List<String>> = emptyList()
  @Field val bodyBase64: String? = null
  @Field val minTls: String = "TLSv1.3"
  @Field val readBody: Boolean = true
  @Field val readAuthErrorBodies: Boolean = false
  @Field val maxResponseBytes: Int = 0
  @Field val maxHeaderFields: Int = 128
  @Field val maxHeaderBytes: Int = 65536
  @Field val timeoutMs: Int = 10000
}

/**
 * Dina's pinned HTTP transport (UCP plan §3.4, U6), the Kotlin counterpart of
 * the iOS module. React Native `fetch` cannot report or pin the connected
 * address, so this module resolves names and runs one HTTP/1.1 exchange to
 * exactly one address: OkHttp with a `Dns` that answers only the vetted
 * address for the URL's host (TLS and the certificate are still checked
 * against that host), no proxy, no redirect, no retry, and the caps enforced
 * while reading. Every policy decision is made in TypeScript over
 * `@dina/net-policy`.
 */
class DinaNetModule : Module() {
  // A lookup blocks for as long as the system resolver retries, which an
  // outside name can stretch to tens of seconds; a small fixed pool would let
  // two such names stall every later lookup. Up to 16 at once, each thread
  // dying after 30 s idle; past that a lookup fails at once (dns_failed).
  private val resolver = ThreadPoolExecutor(0, 16, 30, TimeUnit.SECONDS, SynchronousQueue())

  override fun definition() = ModuleDefinition {
    Name("DinaNet")

    AsyncFunction("resolveHost") { host: String, promise: Promise ->
      try {
        resolver.execute {
          // Every outcome settles the promise exactly once.
          try {
            val answers = InetAddress.getAllByName(host).mapNotNull { it.hostAddress }.distinct()
            promise.resolve(answers)
          } catch (e: Throwable) {
            promise.reject("ERR_DNS", "the name did not resolve", e)
          }
        }
      } catch (e: RejectedExecutionException) {
        promise.reject("ERR_DNS", "too many lookups at once", e)
      }
    }

    AsyncFunction("fetchPinned") { request: PinnedRequest, promise: Promise ->
      PinnedExchange(request) { promise.resolve(it) }.start()
    }

    OnDestroy { resolver.shutdown() }
  }
}

private class PinnedExchange(
  private val req: PinnedRequest,
  private val done: (Map<String, Any?>) -> Unit,
) {
  private val finished = AtomicBoolean(false)
  @Volatile private var handshakeDone = false
  @Volatile private var connectedAddress = ""

  fun start() {
    val url = req.url.toHttpUrlOrNull()
    if (url == null || url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty()) {
      return fail("io_error", false)
    }
    val pinned = try {
      // A literal never touches DNS.
      InetAddress.getByName(req.address)
    } catch (e: Exception) {
      return fail("io_error", false)
    }
    if (req.headers.any { it.size != 2 || !TOKEN.matches(it[0]) || it[1].any { c -> c == '\r' || c == '\n' || c == '\u0000' } }) {
      return fail("io_error", false)
    }
    val body = req.bodyBase64?.let {
      try {
        Base64.decode(it, Base64.NO_WRAP)
      } catch (e: IllegalArgumentException) {
        return fail("io_error", false)
      }
    }
    val tls = if (req.minTls == "TLSv1.3") arrayOf(TlsVersion.TLS_1_3) else arrayOf(TlsVersion.TLS_1_3, TlsVersion.TLS_1_2)
    val spec = ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS).tlsVersions(*tls).build()

    // OkHttp resends a request answered 503 with `Retry-After: 0`, whatever
    // retryOnConnectionFailure says (RetryAndFollowUpInterceptor). One request
    // must mean one attempt, so a network interceptor hides that header from
    // OkHttp (it is restored when reading), and a second attempt is cancelled.
    val attempts = AtomicInteger(0)
    val client = OkHttpClient.Builder()
      .addNetworkInterceptor { chain ->
        val response = chain.proceed(chain.request())
        val retryAfter = response.header("Retry-After")
        if (response.code == 503 && retryAfter != null) {
          response.newBuilder().removeHeader("Retry-After").header(HIDDEN_RETRY_AFTER, retryAfter).build()
        } else {
          response
        }
      }
      .dns(object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
          if (hostname.equals(url.host, ignoreCase = true)) listOf(pinned) else throw UnknownHostException(hostname)
      })
      .proxy(Proxy.NO_PROXY)
      .connectionSpecs(listOf(spec))
      .protocols(listOf(Protocol.HTTP_1_1))
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .callTimeout(req.timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      .eventListener(object : EventListener() {
        override fun secureConnectEnd(call: Call, handshake: Handshake?) {
          handshakeDone = true
        }
        override fun connectionAcquired(call: Call, connection: Connection) {
          connectedAddress = connection.route().socketAddress.address.hostAddress ?: ""
        }
        override fun requestHeadersStart(call: Call) {
          if (attempts.incrementAndGet() > 1) call.cancel()
        }
      })
      .build()

    val request = try {
      val builder = Request.Builder().url(url).header("connection", "close")
      for (pair in req.headers) builder.addHeader(pair[0], pair[1])
      val contentType = req.headers.firstOrNull { it[0] == "content-type" }?.get(1)?.toMediaTypeOrNull()
      val requestBody = when {
        body != null -> body.toRequestBody(contentType)
        req.method == "POST" || req.method == "PUT" -> ByteArray(0).toRequestBody(contentType)
        else -> null
      }
      builder.method(req.method, requestBody).build()
    } catch (e: IllegalArgumentException) {
      // OkHttp refused the request as built (a header byte it does not allow,
      // a body on a GET): nothing reached the network.
      return fail("io_error", false)
    }

    client.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        fail(codeFor(e), handshakeDone)
      }

      override fun onResponse(call: Call, response: Response) {
        try {
          response.use { read(it) }
        } catch (e: Throwable) {
          // OkHttp's dispatcher swallows what escapes here; settle instead.
          fail("io_error", true)
        }
      }
    })
  }

  private fun read(response: Response) {
    val fields = ArrayList<List<String>>()
    var bytes = 0
    for (i in 0 until response.headers.size) {
      val raw = response.headers.name(i).lowercase()
      // The header hidden from OkHttp's 503 rule goes back under its own name.
      val name = if (raw == HIDDEN_RETRY_AFTER) "retry-after" else raw
      val value = response.headers.value(i)
      bytes += name.toByteArray(Charsets.UTF_8).size + value.toByteArray(Charsets.UTF_8).size
      fields.add(listOf(name, value))
    }
    if (fields.size > req.maxHeaderFields || bytes > req.maxHeaderBytes) return fail("too_large", true)

    var body = ByteArray(0)
    val status = response.code
    // As on iOS: no body is read for a redirect, a 204 or 304, or a refused
    // credential the caller did not ask to read.
    val bodyNotRead = status == 204 || status in 300..399 ||
      ((status == 401 || status == 403) && !req.readAuthErrorBodies)
    if (req.readBody && !bodyNotRead) {
      val source = response.body?.source()
      if (source != null) {
        try {
          // Read at most one byte past the cap: enough to know it was passed.
          val limit = req.maxResponseBytes.toLong() + 1
          var total = 0L
          val out = java.io.ByteArrayOutputStream()
          val buffer = ByteArray(16384)
          while (total < limit) {
            val n = source.read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
            if (n == -1) break
            out.write(buffer, 0, n)
            total += n
          }
          if (total > req.maxResponseBytes) return fail("too_large", true)
          body = out.toByteArray()
        } catch (e: IOException) {
          return fail(codeFor(e), true)
        }
      }
    }
    finish(
      mapOf(
        "ok" to true,
        "status" to response.code,
        "headers" to fields,
        "bodyBase64" to Base64.encodeToString(body, Base64.NO_WRAP),
        "connectedAddress" to connectedAddress,
      ),
    )
  }

  private fun codeFor(e: IOException): String = when {
    // No TLS version both sides allow (a 1.3 floor on an Android without TLS 1.3).
    e is SSLException || e is UnknownServiceException -> "tls_failed"
    e is SocketTimeoutException || (e is InterruptedIOException && e.message == "timeout") -> "timeout"
    !handshakeDone && (e is ConnectException || e is NoRouteToHostException || e is UnknownHostException) -> "connect_failed"
    else -> if (handshakeDone) "io_error" else "connect_failed"
  }

  private fun fail(error: String, sent: Boolean) {
    finish(mapOf("ok" to false, "error" to error, "sent" to sent))
  }

  private fun finish(result: Map<String, Any?>) {
    if (finished.compareAndSet(false, true)) done(result)
  }

  companion object {
    private val TOKEN = Regex("^[!#$%&'*+\\-.^_`|~0-9a-z]+$")
    private const val HIDDEN_RETRY_AFTER = "x-dina-retry-after"
  }
}
