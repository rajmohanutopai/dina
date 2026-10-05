import ExpoModulesCore
import Foundation
import Network
import Security

/// One pinned exchange, as `@dina/net-expo/policy_socket` sends it
/// (`NativePinnedRequest`).
struct PinnedRequest: Record {
  @Field var method: String = "GET"
  @Field var url: String = ""
  @Field var address: String = ""
  @Field var headers: [[String]] = []
  @Field var bodyBase64: String? = nil
  @Field var minTls: String = "TLSv1.3"
  @Field var readBody: Bool = true
  @Field var readAuthErrorBodies: Bool = false
  @Field var maxResponseBytes: Int = 0
  @Field var maxHeaderFields: Int = 128
  @Field var maxHeaderBytes: Int = 65536
  @Field var timeoutMs: Int = 10000
}

/// Dina's pinned HTTP transport (UCP plan §3.4, U6). React Native `fetch`
/// cannot report or pin the connected address, so this module resolves names
/// and runs one HTTP/1.1 exchange to exactly one address. Every policy
/// decision (which answers are allowed, redirects, media types) is made in
/// TypeScript over `@dina/net-policy`; this side only keeps its promises:
/// connect to the given address and nothing else, check the certificate
/// against the URL's host, follow no redirect, and enforce the caps.
public class DinaNetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DinaNet")

    AsyncFunction("resolveHost") { (host: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        if let answers = DinaNetModule.resolve(host) {
          promise.resolve(answers)
        } else {
          promise.reject("ERR_DNS", "the name did not resolve")
        }
      }
    }

    AsyncFunction("fetchPinned") { (request: PinnedRequest, promise: Promise) in
      PinnedExchange(request: request) { result in promise.resolve(result) }.start()
    }
  }

  /// Every A and AAAA answer, in resolver order, without duplicates.
  /// `AI_DEFAULT` lets iOS synthesise NAT64 answers on IPv6-only networks.
  static func resolve(_ host: String) -> [String]? {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    hints.ai_socktype = SOCK_STREAM
    hints.ai_flags = AI_DEFAULT
    var list: UnsafeMutablePointer<addrinfo>? = nil
    guard getaddrinfo(host, "443", &hints, &list) == 0, let first = list else { return nil }
    defer { freeaddrinfo(first) }
    var out: [String] = []
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let ai = cursor {
      if let text = addressText(ai.pointee.ai_addr), !out.contains(text) { out.append(text) }
      cursor = ai.pointee.ai_next
    }
    return out
  }

  static func addressText(_ sa: UnsafeMutablePointer<sockaddr>?) -> String? {
    guard let sa = sa else { return nil }
    switch Int32(sa.pointee.sa_family) {
    case AF_INET:
      var addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
      return ntop(AF_INET, &addr, Int(INET_ADDRSTRLEN))
    case AF_INET6:
      var addr = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
      return ntop(AF_INET6, &addr, Int(INET6_ADDRSTRLEN))
    default:
      return nil
    }
  }

  static func ntop(_ family: Int32, _ addr: UnsafeRawPointer, _ size: Int) -> String? {
    var buf = [CChar](repeating: 0, count: size)
    guard inet_ntop(family, addr, &buf, socklen_t(size)) != nil else { return nil }
    return String(cString: buf)
  }
}

/// One HTTP/1.1 exchange over TLS to one address. All state lives on `queue`.
final class PinnedExchange {
  private enum Framing { case none, length(Int), chunked, untilClose }

  private let req: PinnedRequest
  private let done: ([String: Any]) -> Void
  private let queue = DispatchQueue(label: "dina.net.exchange")
  private var connection: NWConnection?
  private var handshakeDone = false
  private var finished = false
  private var connectedAddress = ""

  private var buffer = Data()
  private var headParsed = false
  private var status = 0
  private var headers: [[String]] = []
  private var framing = Framing.none
  private var body = Data()
  // Chunked decoding: bytes still owed by the current chunk (+2 for its CRLF),
  // or -1 while reading a size line; `inTrailer` after the last chunk.
  private var chunkOwed = -1
  private var crlfSeen = Data()
  private var inTrailer = false

  init(request: PinnedRequest, done: @escaping ([String: Any]) -> Void) {
    self.req = request
    self.done = done
  }

  func start() {
    queue.async { self.begin() }
  }

  private static let tokenChars = CharacterSet(charactersIn:
    "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyz")

  private func begin() {
    guard let url = URL(string: req.url), url.scheme == "https",
          let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
          let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return fail("io_error", sent: false)
    }
    let port = url.port ?? 443
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)), port > 0, port < 65536 else {
      return fail("io_error", sent: false)
    }
    let ipHost: NWEndpoint.Host
    if let v4 = IPv4Address(req.address) {
      ipHost = .ipv4(v4)
    } else if let v6 = IPv6Address(req.address) {
      ipHost = .ipv6(v6)
    } else {
      return fail("io_error", sent: false)
    }
    // Header names are lower-case tokens; values are visible ASCII, SP and HTAB.
    // Checked by Unicode scalar: as a Character, "\r\n" is one grapheme that
    // equals neither "\r" nor "\n", so a Character test would let CRLF through.
    for pair in req.headers {
      guard pair.count == 2, !pair[0].isEmpty,
            pair[0].unicodeScalars.allSatisfy({ Self.tokenChars.contains($0) }),
            pair[1].unicodeScalars.allSatisfy({ $0 == "\t" || ($0.value >= 0x20 && $0.value <= 0x7e) }) else {
        return fail("io_error", sent: false)
      }
    }
    var bodyData = Data()
    if let b64 = req.bodyBase64 {
      guard let decoded = Data(base64Encoded: b64) else { return fail("io_error", sent: false) }
      bodyData = decoded
    }

    let tls = NWProtocolTLS.Options()
    let sec = tls.securityProtocolOptions
    sec_protocol_options_set_tls_server_name(sec, host)
    sec_protocol_options_set_min_tls_protocol_version(sec, req.minTls == "TLSv1.3" ? .TLSv13 : .TLSv12)
    sec_protocol_options_add_tls_application_protocol(sec, "http/1.1")
    // Validate the chain against the URL's host, never the address.
    sec_protocol_options_set_verify_block(sec, { _, secTrust, complete in
      let trust = sec_trust_copy_ref(secTrust).takeRetainedValue()
      SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
      SecTrustEvaluateAsyncWithError(trust, self.queue) { _, ok, _ in complete(ok) }
    }, queue)
    let tcp = NWProtocolTCP.Options()
    tcp.connectionTimeout = max(1, req.timeoutMs / 1000)
    let params = NWParameters(tls: tls, tcp: tcp)
    params.preferNoProxies = true

    var path = comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath
    if let q = comps.percentEncodedQuery { path += "?" + q }
    let hostHeader = port == 443 ? host : "\(host):\(port)"
    var head = "\(req.method) \(path) HTTP/1.1\r\nhost: \(hostHeader)\r\n"
    for pair in req.headers { head += "\(pair[0]): \(pair[1])\r\n" }
    if req.bodyBase64 != nil || req.method == "POST" || req.method == "PUT" {
      head += "content-length: \(bodyData.count)\r\n"
    }
    head += "connection: close\r\n\r\n"
    var wire = Data(head.utf8)
    wire.append(bodyData)

    let conn = NWConnection(host: ipHost, port: nwPort, using: params)
    connection = conn
    conn.stateUpdateHandler = { state in
      switch state {
      case .ready:
        self.handshakeDone = true
        self.connectedAddress = Self.remoteAddress(conn) ?? ""
        conn.send(content: wire, completion: .contentProcessed { error in
          if error != nil { return self.fail("io_error", sent: true) }
          self.receive()
        })
      case .failed(let error):
        self.fail(self.code(for: error), sent: self.handshakeDone)
      case .waiting(let error):
        // No path to the address: fail now rather than wait for one.
        self.fail(self.code(for: error), sent: false)
      case .cancelled:
        self.fail("io_error", sent: self.handshakeDone)
      default:
        break
      }
    }
    queue.asyncAfter(deadline: .now() + .milliseconds(req.timeoutMs)) {
      self.fail("timeout", sent: self.handshakeDone)
    }
    conn.start(queue: queue)
  }

  private func code(for error: NWError) -> String {
    if case .tls = error { return "tls_failed" }
    return handshakeDone ? "io_error" : "connect_failed"
  }

  private static func remoteAddress(_ conn: NWConnection) -> String? {
    guard case let .hostPort(host, _) = conn.currentPath?.remoteEndpoint ?? conn.endpoint else { return nil }
    switch host {
    case .ipv4(let a):
      return a.rawValue.withUnsafeBytes { DinaNetModule.ntop(AF_INET, $0.baseAddress!, Int(INET_ADDRSTRLEN)) }
    case .ipv6(let a):
      return a.rawValue.withUnsafeBytes { DinaNetModule.ntop(AF_INET6, $0.baseAddress!, Int(INET6_ADDRSTRLEN)) }
    default:
      return nil
    }
  }

  private func receive() {
    connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
      if self.finished { return }
      if let data = data, !data.isEmpty {
        self.consume(data)
        if self.finished { return }
      }
      if isComplete { return self.onEnd() }
      if error != nil { return self.fail("io_error", sent: true) }
      self.receive()
    }
  }

  private func consume(_ data: Data) {
    if headParsed { return feedBody(data) }
    buffer.append(data)
    while !headParsed {
      // The status line and the header block share the header cap (plus a margin for the status line).
      guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
        if buffer.count > req.maxHeaderBytes + 1024 { fail("too_large", sent: true) }
        return
      }
      let headBytes = buffer.subdata(in: buffer.startIndex..<end.lowerBound)
      let rest = buffer.subdata(in: end.upperBound..<buffer.endIndex)
      buffer = Data()
      guard parseHead(headBytes) else { return }
      if status >= 100 && status < 200 {
        // An interim answer (103 Early Hints): drop it and read the real one.
        headers = []
        buffer = rest
        continue
      }
      headParsed = true
      if !req.readBody || bodyNotRead() { return succeed() }
      if case .length(let n) = framing, n > req.maxResponseBytes { return fail("too_large", sent: true) }
      if !rest.isEmpty { feedBody(rest) }
      if !finished, case .length(let n) = framing, n == 0 { succeed() }
    }
  }

  /// Answers whose body is never read: no body (204, 304, HEAD), a redirect
  /// (refused anyway), or a refused credential the caller did not ask to read.
  /// A large error page then never turns a status into a transport failure.
  private func bodyNotRead() -> Bool {
    let unread = status == 204 || req.method == "HEAD" || (status >= 300 && status < 400)
      || ((status == 401 || status == 403) && !req.readAuthErrorBodies)
    if unread { framing = .none; return true }
    return false
  }

  private func parseHead(_ bytes: Data) -> Bool {
    guard let text = String(data: bytes, encoding: .isoLatin1) else { fail("io_error", sent: true); return false }
    let lines = text.components(separatedBy: "\r\n")
    // RFC 9112 §2.2: a bare CR or LF, or a NUL, inside a line is invalid.
    if lines.contains(where: { $0.unicodeScalars.contains { $0 == "\r" || $0 == "\n" || $0 == "\0" } }) {
      fail("io_error", sent: true)
      return false
    }
    let statusParts = (lines.first ?? "").split(separator: " ", maxSplits: 2)
    // RFC 9112 §4: status-code = 3DIGIT.
    guard statusParts.count >= 2, statusParts[0].hasPrefix("HTTP/1."), statusParts[1].count == 3,
          statusParts[1].unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }),
          let code = Int(statusParts[1]) else {
      fail("io_error", sent: true)
      return false
    }
    status = code
    var fields: [[String]] = []
    var bytesSeen = 0
    for line in lines.dropFirst() {
      if line.first == " " || line.first == "\t" { fail("io_error", sent: true); return false } // obs-fold
      guard let colon = line.firstIndex(of: ":") else { fail("io_error", sent: true); return false }
      let name = line[..<colon].lowercased()
      let value = line[line.index(after: colon)...].trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
      guard !name.isEmpty, name.unicodeScalars.allSatisfy({ Self.tokenChars.contains($0) }) else {
        fail("io_error", sent: true)
        return false
      }
      bytesSeen += name.utf8.count + value.utf8.count
      fields.append([name, value])
    }
    if fields.count > req.maxHeaderFields || bytesSeen > req.maxHeaderBytes {
      fail("too_large", sent: true)
      return false
    }
    headers = fields
    let te = fields.filter { $0[0] == "transfer-encoding" }.map { $0[1].lowercased() }.joined(separator: ",")
    let lengths = Set(fields.filter { $0[0] == "content-length" }.map { $0[1] })
    if !te.isEmpty {
      // Only `chunked` alone is understood: another coding (`gzip, chunked`) would
      // leave the body still encoded, which is not the content.
      let codings = te.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
      guard codings == ["chunked"] else {
        fail("io_error", sent: true)
        return false
      }
      framing = .chunked
    } else if lengths.count > 1 {
      fail("io_error", sent: true)
      return false
    } else if let only = lengths.first {
      // RFC 9110 §8.6: Content-Length = 1*DIGIT (no sign, no space).
      guard !only.isEmpty, only.count <= 15, only.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }),
            let n = Int(only) else { fail("io_error", sent: true); return false }
      framing = .length(n)
    } else {
      framing = .untilClose
    }
    return true
  }

  private func feedBody(_ data: Data) {
    switch framing {
    case .none:
      return
    case .length(let n):
      body.append(data)
      if body.count >= n {
        body = body.prefix(n)
        succeed()
      }
    case .untilClose:
      body.append(data)
      if body.count > req.maxResponseBytes { fail("too_large", sent: true) }
    case .chunked:
      buffer.append(data)
      decodeChunks()
    }
  }

  private func decodeChunks() {
    while !finished {
      if inTrailer {
        // Trailer fields end with an empty line; they are read and ignored.
        if buffer.starts(with: Data("\r\n".utf8)) { return succeed() }
        if buffer.range(of: Data("\r\n\r\n".utf8)) != nil { return succeed() }
        if buffer.count > req.maxHeaderBytes { fail("too_large", sent: true) }
        return
      }
      if chunkOwed < 0 {
        guard let lineEnd = buffer.range(of: Data("\r\n".utf8)) else {
          if buffer.count > 1024 { fail("io_error", sent: true) }
          return
        }
        let line = String(data: buffer.subdata(in: buffer.startIndex..<lineEnd.lowerBound), encoding: .ascii) ?? ""
        buffer = buffer.subdata(in: lineEnd.upperBound..<buffer.endIndex)
        let sizeText = line.split(separator: ";", maxSplits: 1).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        guard !sizeText.isEmpty, sizeText.count <= 8,
              sizeText.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) }),
              let size = Int(sizeText, radix: 16) else {
          return fail("io_error", sent: true)
        }
        if size == 0 { inTrailer = true; continue }
        if body.count + size > req.maxResponseBytes { return fail("too_large", sent: true) }
        chunkOwed = size + 2
        continue
      }
      if buffer.isEmpty { return }
      let take = min(chunkOwed, buffer.count)
      let piece = buffer.prefix(take)
      buffer = buffer.subdata(in: buffer.startIndex.advanced(by: take)..<buffer.endIndex)
      // The chunk's data, then its CRLF (the last two owed bytes).
      let dataPart = max(0, min(take, chunkOwed - 2))
      body.append(piece.prefix(dataPart))
      crlfSeen.append(piece.suffix(from: piece.startIndex.advanced(by: dataPart)))
      chunkOwed -= take
      if chunkOwed == 0 {
        guard crlfSeen == Data("\r\n".utf8) else { return fail("io_error", sent: true) }
        crlfSeen = Data()
        chunkOwed = -1
      }
    }
  }

  private func onEnd() {
    guard headParsed else { return fail("io_error", sent: true) }
    switch framing {
    case .untilClose, .none:
      succeed()
    case .length(let n):
      if body.count >= n { succeed() } else { fail("io_error", sent: true) }
    case .chunked:
      fail("io_error", sent: true)
    }
  }

  private func succeed() {
    finish([
      "ok": true,
      "status": status,
      "headers": headers,
      "bodyBase64": req.readBody ? body.base64EncodedString() : "",
      "connectedAddress": connectedAddress,
    ])
  }

  private func fail(_ error: String, sent: Bool) {
    finish(["ok": false, "error": error, "sent": sent])
  }

  private func finish(_ result: [String: Any]) {
    if finished { return }
    finished = true
    connection?.stateUpdateHandler = nil
    connection?.cancel()
    connection = nil
    done(result)
  }
}
