// Checks NameFinder.swift on macOS, which ships the same NaturalLanguage and
// FoundationModels frameworks as iOS. Run: scripts/test/dina_names_probe.sh
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print(ok ? "  ok   " : "  FAIL ", what)
  if !ok { failures += 1 }
}
func values(_ found: [FoundName]) -> [String] { found.map { $0.value } }

// Splitting: no piece over the limit, nothing lost, breaks at a sentence end.
let sentence = "Ravi Kumar fixed the sink and left a note. "
let long = String(repeating: sentence, count: 100)
let pieces = NameFinder.chunks(long)
check(pieces.allSatisfy { $0.count <= NameFinder.maxChunk }, "every piece within \(NameFinder.maxChunk) characters")
check(pieces.joined() == long, "pieces join back to the text")
check(pieces.dropLast().allSatisfy { $0.hasSuffix(". ") || $0.hasSuffix(".") }, "pieces break after a sentence")
check(NameFinder.chunks("short").count == 1, "a short text is one piece")

// The tagger: full Western names with capitals.
let tagged = NameFinder.tag("The plumber, Ravi Kumar, said he will come on Tuesday.")
check(values(tagged) == ["Ravi Kumar"], "tagger finds Ravi Kumar (\(values(tagged)))")
check(tagged.allSatisfy { $0.source == "tagger" && $0.score > 0.9 }, "tagger scores a clear name high")

let finder = NameFinder()
print("mode:", finder.mode().rawValue)
if finder.mode() == .model {
  let cases: [(String, [String])] = [
    ("Remind me to call Priya about the lease in May.", ["Priya"]),
    ("Can you email Oluwaseun Adeyemi and Nguyễn Văn An?", ["Oluwaseun Adeyemi", "Nguyễn Văn An"]),
    ("Ich habe mit Anna Schmidt in Berlin gesprochen.", ["Anna Schmidt"]),
    ("मैंने राहुल शर्मा से बात की।", ["राहुल शर्मा"]),
    ("May called and said Will is sick.", ["May", "Will"]),
  ]
  // The model is not deterministic: a case may miss on one run. Each case is
  // printed; the check is that at least 4 of the 5 find every name.
  var hits = 0
  for (text, expected) in cases {
    let found = await finder.find(text)
    let all = Set(expected).isSubset(of: Set(values(found)))
    if all { hits += 1 }
    print(all ? "  hit  " : "  miss ", "\(expected) in \"\(text)\" (\(values(found)))")
    check(found.allSatisfy { $0.source == "model" }, "answers come from the model")
  }
  check(hits >= 4, "the model found every name in \(hits) of \(cases.count) cases (4 needed)")
  // A long text goes in pieces and still finds a name in the last one.
  let lengthy = String(repeating: "Nothing to see here today. ", count: 80) + "Then Priya Raman called."
  let fromLong = await finder.find(lengthy)
  check(values(fromLong).contains { $0.contains("Priya") }, "a name in the last piece of a long text is found")
} else {
  let found = await finder.find("The plumber, Ravi Kumar, said he will come.")
  check(values(found) == ["Ravi Kumar"], "without the model the tagger answers")
}
// The deadline (dual review F3): with no time left the model is not asked and
// the tagger answers at once; a short budget cuts a model call off.
if finder.mode() == .model {
  var t0 = Date()
  let none = await finder.find("The plumber, Ravi Kumar, said he will come.", budgetMs: 0)
  check(Date().timeIntervalSince(t0) < 0.2 && none.allSatisfy { $0.source == "tagger" }, "budget 0: the tagger answers at once (\(values(none)))")
  let lengthy = String(repeating: "Nothing to see here today. ", count: 300) + "Then Priya Raman called."
  t0 = Date()
  _ = await finder.find(lengthy, budgetMs: 300)
  let took = Date().timeIntervalSince(t0)
  check(took < 1.5, "a long text with a 300 ms budget answers in \(String(format: "%.2f", took)) s, not one model call per piece")
}

// The fallback: where the model is off, find() answers from the tagger.
let taggerOnly = NameFinder(forceTagger: true)
check(taggerOnly.mode() == .tagger, "a forced finder reports tagger mode")
let fallback = await taggerOnly.find("The plumber, Ravi Kumar, said he will come.")
check(values(fallback) == ["Ravi Kumar"] && fallback.allSatisfy { $0.source == "tagger" }, "the fallback answers from the tagger (\(values(fallback)))")
check(await taggerOnly.find("   ").isEmpty, "blank text finds nothing")
print(failures == 0 ? "PASS" : "FAILED: \(failures)")
exit(failures == 0 ? 0 : 1)
