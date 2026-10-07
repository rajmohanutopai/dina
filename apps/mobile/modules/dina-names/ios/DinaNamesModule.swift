import ExpoModulesCore

/// The JS surface of `NameFinder` (docs/PII_ARCHITECTURE_V2.md §7): which
/// finder the device runs, a prewarm, and the candidate names in one text.
/// Brain filters what comes back; nothing here decides what to hide.
public class DinaNamesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DinaNames")

    Function("mode") { () -> String in
      NameFinder.shared.mode().rawValue
    }

    AsyncFunction("prewarm") { () async in
      await NameFinder.shared.prewarm()
    }

    AsyncFunction("findNames") { (text: String, budgetMs: Int) async -> [[String: Any]] in
      let found = await NameFinder.shared.find(text, budgetMs: budgetMs)
      return found.map { ["value": $0.value, "score": $0.score, "source": $0.source] }
    }
  }
}
