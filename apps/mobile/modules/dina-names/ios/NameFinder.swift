import Foundation
import NaturalLanguage
#if canImport(FoundationModels)
import FoundationModels
#endif

/// One candidate name found in a text: the exact text, how sure the finder
/// is (0...1), and which finder said so.
public struct FoundName: Equatable {
  public let value: String
  public let score: Double
  public let source: String
}

/// Which finder this device can run.
public enum NameFinderMode: String {
  /// Apple's on-device model (Apple Intelligence on, iOS 26 or later).
  case model
  /// NLTagger's `nameType` scheme: every device, English and French only.
  case tagger
}

/// Finds people's names in text on the device (docs/PII_ARCHITECTURE_V2.md
/// §7). It only proposes: Brain filters the candidates and decides what to
/// hide. No text or name leaves the device and none is logged.
///
/// Kept free of Expo so the same file compiles and runs on macOS, where the
/// tests for it live (`scripts/test/dina_names_probe.sh`).
public actor NameFinder {
  public static let shared = NameFinder()

  /// Apple's model has a small context: texts are split into pieces this long
  /// at most, at a sentence or line break where one is near.
  static let maxChunk = 1500
  /// What the model's answer is taken to be worth; it gives no score.
  static let modelScore = 0.9

  /// Use the tagger even where the model runs (the macOS check of the
  /// fallback; never set in the app).
  let forceTagger: Bool

  public init(forceTagger: Bool = false) {
    self.forceTagger = forceTagger
  }

  public nonisolated func mode() -> NameFinderMode {
    if forceTagger { return .tagger }
    #if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      if case .available = SystemLanguageModel.default.availability { return .model }
    }
    #endif
    return .tagger
  }

  /// Load the model ahead of the first call (the first answer otherwise takes
  /// seconds).
  public func prewarm() {
    #if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *), mode() == .model {
      LanguageModelSession(instructions: NameFinder.instructions).prewarm()
    }
    #endif
  }

  /// Candidate names in `text`, within `budgetMs`. The model reads pieces
  /// while time is left, and one model call is cut off when it runs out; a
  /// piece the model cannot answer in time (or refuses, or fails on) is read
  /// by the tagger, which is instant. So the answer comes in about the budget.
  public func find(_ text: String, budgetMs: Int = 2_500) async -> [FoundName] {
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
    let deadline = Date().addingTimeInterval(Double(max(budgetMs, 0)) / 1000)
    var out: [FoundName] = []
    for piece in NameFinder.chunks(text) {
      var found: [FoundName]? = nil
      #if canImport(FoundationModels)
      let left = deadline.timeIntervalSinceNow
      if #available(iOS 26.0, macOS 26.0, *), mode() == .model, left > 0 {
        found = await NameFinder.askModel(piece, within: left)
      }
      #endif
      out.append(contentsOf: found ?? NameFinder.tag(piece))
    }
    return out
  }

  static let instructions =
    "You find the names of people in a text. Return only names that appear in the text, copied exactly."

  #if canImport(FoundationModels)
  /// The model's names for one piece, or nil when it fails, refuses, or does
  /// not answer within `seconds` (the call is then cancelled).
  @available(iOS 26.0, macOS 26.0, *)
  static func askModel(_ piece: String, within seconds: TimeInterval) async -> [FoundName]? {
    await withTaskGroup(of: [FoundName]?.self) { group in
      group.addTask {
        let session = LanguageModelSession(instructions: NameFinder.instructions)
        do {
          let answer = try await session.respond(to: "Text: \(piece)", generating: ModelNames.self)
          return answer.content.names.map {
            FoundName(value: $0, score: NameFinder.modelScore, source: "model")
          }
        } catch {
          return nil
        }
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
  }
  #endif

  /// NLTagger's person names with their probability.
  static func tag(_ text: String) -> [FoundName] {
    let tagger = NLTagger(tagSchemes: [.nameType])
    tagger.string = text
    var out: [FoundName] = []
    tagger.enumerateTags(
      in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType,
      options: [.omitWhitespace, .omitPunctuation, .joinNames]
    ) { tag, range in
      if tag == .personalName {
        let (hypotheses, _) = tagger.tagHypotheses(
          at: range.lowerBound, unit: .word, scheme: .nameType, maximumCount: 3)
        let score = hypotheses[NLTag.personalName.rawValue] ?? 0.5
        out.append(FoundName(value: String(text[range]), score: score, source: "tagger"))
      }
      return true
    }
    return out
  }

  /// Split into pieces of at most `maxChunk` characters, breaking after a
  /// newline or sentence end in the last third of a piece when there is one.
  static func chunks(_ text: String) -> [String] {
    var pieces: [String] = []
    var rest = Substring(text)
    while rest.count > maxChunk {
      let limit = rest.index(rest.startIndex, offsetBy: maxChunk)
      let floor = rest.index(rest.startIndex, offsetBy: maxChunk * 2 / 3)
      var cut = limit
      var i = limit
      while i > floor {
        let before = rest.index(before: i)
        if "\n.!?。".contains(rest[before]) {
          cut = i
          break
        }
        i = before
      }
      pieces.append(String(rest[rest.startIndex..<cut]))
      rest = rest[cut...]
    }
    if !rest.isEmpty { pieces.append(String(rest)) }
    return pieces
  }
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
@Generable
struct ModelNames {
  @Guide(
    description:
      "Every person's name exactly as written in the text. Not places, companies, products, months, or relationship words like mom."
  )
  var names: [String]
}
#endif
