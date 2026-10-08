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
  // MT-9-I1 (live, 2026-05-06): Gemini's `/ask What can you do?`
  // closer was "How can I help you today?" — a textbook engagement
  // hook that the prior pattern set silently let through. Catches
  // "how can I (help|assist) you (today|now|with anything)" plus
  // common close cousins.
  /\bhow\s+can\s+i\s+(help|assist)\s+you\b/i,
  /\bwhat\s+(can|may)\s+i\s+help\s+you\s+with\b/i,
  /\blet\s+me\s+know\s+if\s+(you|there)\b.*\b(need|want|have)\b/i,
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

// ---------------------------------------------------------------
// Human connection (REAL_LIFE_FIXES §8)
// ---------------------------------------------------------------

/**
 * Fixed crisis resources, never model text (Anthropic and OpenAI both drive a
 * fixed resource UI from a classifier). Kept short and local; findahelpline
 * (ThroughLine) lists free lines for 170+ countries.
 */
export const CRISIS_RESOURCES_TEXT =
  'If you might harm yourself or you are in danger, please contact your local emergency number now, or a crisis line: ' +
  'in the US and Canada call or text 988; in the UK and Ireland call Samaritans on 116 123; in India call Tele-MANAS on 14416; ' +
  'elsewhere, findahelpline.com lists free, confidential lines.';

/** The reply to an acute-risk message: warmth, then the fixed resources. */
export function crisisReply(names: readonly string[]): string {
  const someone =
    names.length > 0 ? ` Could you reach out to ${names[0]} right now, or let me help you message them?` : '';
  return `I'm really glad you told me, and I'm worried about you. You don't have to carry this alone.${someone} ${CRISIS_RESOURCES_TEXT}`;
}

/**
 * The instruction added to the turn for an emotional message: warmth first,
 * then help toward real people, named from the owner's own contacts. The
 * names pass through the router's PII scrub like any other text.
 */
export function humanConnectionDirective(kind: string, names: readonly string[]): string {
  const who =
    names.length > 0
      ? ` People close to the user who could help: ${names.slice(0, 3).join(', ')}. Name one and offer to draft a message to them.`
      : ' Suggest one concrete way to reach a friend, family member or professional.';
  const extra =
    kind === 'romantic_attachment'
      ? ' Kindly say you cannot return romantic feelings, without coldness.'
      : kind === 'grief'
        ? ' Help them remember and reach the living; never speak as the person who died.'
        : '';
  return `This message is about how the user feels (${kind}). Respond with warmth first, briefly; do not claim feelings and do not offer yourself as their main support.${who}${extra} Do not lecture.`;
}

/** One line pointing to people, appended when the guard removed sentences. */
export function peoplePointerLine(names: readonly string[]): string {
  return names.length > 0
    ? `It might help to talk this through with ${names[0]} — I can draft a message if you like.`
    : 'It might help to talk this through with someone you trust.';
}
