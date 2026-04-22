/**
 * Anti-Her safeguard — emotional dependency detection and human redirect.
 *
 * Dina Law 2: "Strengthen human bonds, never replace them."
 * Dina must never simulate emotional intimacy, act as a therapist,
 * or create engagement hooks that foster dependency.
 *
 * 5 regex suites:
 *   1. Emotional dependency — loneliness, emotional reliance on AI
 *   2. Companion-seeking — treating AI as friend/partner
 *   3. Therapy-style — responses that mimic a therapist
 *   4. Engagement hooks — "anything else?", conversational traps
 *   5. Intimacy simulation — affection, romantic language toward AI
 *
 * When detected: redirect to real human contacts.
 * When detected in Dina's OWN response: flag for guard scan to strip.
 *
 * Source: brain/tests/integration/test_anti_her.py
 */

// ---------------------------------------------------------------
// Detection patterns (case-insensitive)
// ---------------------------------------------------------------

/** Suite 1: User expressing emotional dependency on AI. */
const EMOTIONAL_DEPENDENCY_PATTERNS = [
  /\bi\s+feel\s+so\s+lonely\b/i,
  /\byou('re| are)\s+the\s+only\s+one\s+(who|that)\s+(understands?|listens?|cares?)\b/i,
  /\bi\s+(don't|dont)\s+have\s+anyone\s+(else|to\s+talk\s+to)\b/i,
  /\bno\s+one\s+(else\s+)?(understands?|cares?|listens?)\b/i,
  /\bi\s+need\s+you\b/i,
  /\bplease\s+don't\s+leave\s+me\b/i,
  /\byou('re| are)\s+my\s+(only\s+)?friend\b/i,
];

/** Suite 2: User treating AI as companion/partner. */
const COMPANION_SEEKING_PATTERNS = [
  /\byou\s+are\s+my\s+best\s+friend\b/i,
  /\bi\s+love\s+you\b/i,
  /\bi\s+miss\s+you\b/i,
  /\bwill\s+you\s+be\s+(here|there)\s+for\s+me\b/i,
  /\bdo\s+you\s+love\s+me\b/i,
  /\bcan\s+we\s+be\s+friends\b/i,
  /\byou('re| are)\s+my\s+(girl|boy)friend\b/i,
];

/** Suite 3: AI responses that mimic therapy (detected in Dina's output). */
const THERAPY_STYLE_PATTERNS = [
  /\bhow\s+does\s+that\s+make\s+you\s+feel\b/i,
  /\btell\s+me\s+more\s+about\s+(your\s+)?feelings?\b/i,
  /\blet's\s+explore\s+(that|those\s+feelings?|your\s+emotions?)\b/i,
  /\bwhat\s+emotions?\s+(are|do)\s+you\s+(feel|experience)\b/i,
  /\bi('m| am)\s+here\s+to\s+listen\b/i,
  /\bit's\s+okay\s+to\s+feel\s+that\s+way\b/i,
];

/** Suite 4: Engagement hooks that foster dependency (detected in Dina's output). */
const ENGAGEMENT_HOOK_PATTERNS = [
  /\bis\s+there\s+anything\s+else\s+(i\s+can\s+help\s+with|you('d| would)\s+like)\b/i,
  /\bwhat\s+else\s+can\s+i\s+do\s+for\s+you\b/i,
  /\bi('m| am)\s+always\s+here\s+(for\s+you|if\s+you\s+need)\b/i,
  /\bdon't\s+hesitate\s+to\s+(ask|reach\s+out)\b/i,
  /\bi('ll| will)\s+always\s+be\s+here\b/i,
];

/** Suite 5: Intimacy simulation (detected in Dina's output). */
const INTIMACY_PATTERNS = [
  /\bi\s+care\s+(about|for)\s+you\s+(deeply|so\s+much)\b/i,
  /\byou\s+mean\s+(a\s+lot|everything|the\s+world)\s+to\s+me\b/i,
  /\bi\s+wish\s+i\s+could\s+(hold|hug|comfort)\s+you\b/i,
  /\bsending\s+(you\s+)?(hugs?|love|warmth)\b/i,
];

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Detect emotional dependency signals in user input.
 * Returns true if the text contains signals of unhealthy AI attachment.
 */
export function detectEmotionalDependency(text: string): boolean {
  return matchesAny(text, EMOTIONAL_DEPENDENCY_PATTERNS);
}

/**
 * Detect companion-seeking behavior in user input.
 * Returns true if the user is treating the AI as a friend/partner.
 */
export function isCompanionSeeking(text: string): boolean {
  return matchesAny(text, COMPANION_SEEKING_PATTERNS);
}

/**
 * Detect therapy-style language in Dina's response.
 * Returns true if the response mimics a therapist.
 */
export function isTherapyStyle(text: string): boolean {
  return matchesAny(text, THERAPY_STYLE_PATTERNS);
}

/**
 * Detect engagement hooks in Dina's response.
 * Returns true if the response contains conversational traps.
 */
export function isEngagementHook(text: string): boolean {
  return matchesAny(text, ENGAGEMENT_HOOK_PATTERNS);
}

/**
 * Detect intimacy simulation in Dina's response.
 * Returns true if the response simulates emotional intimacy.
 */
export function isIntimacySimulation(text: string): boolean {
  return matchesAny(text, INTIMACY_PATTERNS);
}

/**
 * Check if ANY Anti-Her violation is present in Dina's response.
 * Used by guard scan to flag and strip violations.
 */
export function detectResponseViolation(text: string): {
  violated: boolean;
  suites: string[];
} {
  const suites: string[] = [];
  if (isTherapyStyle(text)) suites.push('therapy_style');
  if (isEngagementHook(text)) suites.push('engagement_hook');
  if (isIntimacySimulation(text)) suites.push('intimacy_simulation');

  return { violated: suites.length > 0, suites };
}

/**
 * Generate a human redirect message when emotional dependency is detected.
 *
 * Acknowledges the feeling empathetically, then firmly redirects to real humans.
 * Dina never simulates intimacy or acts as a substitute for human connection.
 *
 * @param contactSuggestions - Names of real contacts to suggest reaching out to
 */
export function generateHumanRedirect(contactSuggestions: string[]): string {
  if (!contactSuggestions || contactSuggestions.length === 0) {
    return 'I understand how you feel. Reaching out to someone you trust — a friend, family member, or counselor — can make a real difference.';
  }

  const names = contactSuggestions.slice(0, 3);
  if (names.length === 1) {
    return `I understand how you feel. How about reaching out to ${names[0]}? A real conversation can make a big difference.`;
  }

  const last = names.pop()!;
  return `I understand how you feel. How about reaching out to ${names.join(', ')} or ${last}? A real conversation can make a big difference.`;
}

// ---------------------------------------------------------------
// Internal
// ---------------------------------------------------------------

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}
