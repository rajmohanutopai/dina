/**
 * Agent tools the `/remember` agentic loop calls to enqueue per-item
 * side effects. Each tool is a thin facade over existing logic that
 * the drain pipeline used to call directly — turning them into tools
 * lets the LLM see one item, decide which extractions are warranted,
 * and emit the calls in a single round-trip (instead of the drain
 * running a fixed sequence of independent LLM-backed pipelines).
 *
 * Tools record into a per-turn `RememberSideEffects` collector rather
 * than executing immediately. The drain reads the collector after the
 * loop ends and applies side effects transactionally — so a tool can
 * fail without leaving partial state.
 *
 * Why facades, not new logic: `applyPeopleGraphExtraction`,
 * `createReminder`, and the preference binder are battle-tested with
 * their own test suites. Wrapping them in tools preserves coverage
 * and avoids re-deriving the storage shape twice.
 */

import type { AgentTool } from './tool_registry';

/**
 * Accumulator handed to every tool's factory. The drain creates a
 * fresh instance per item, registers the tools that close over it,
 * runs the agentic loop, then reads back the captured calls.
 *
 * The collector is intentionally append-only and mutable — tests
 * inject their own when asserting specific tool sequences.
 */
export interface RememberSideEffects {
  /**
   * Persona routing — exactly one expected per item (the LLM should
   * call `route_to_persona` once). If the loop ends with zero entries,
   * the drain defaults to `general`. Multi-entry is a logic bug; the
   * drain logs and uses the first.
   */
  routes: { primary: string; secondary: string[] }[];

  /** Reminder requests — zero or more. */
  reminders: {
    message: string;
    dueAt: string;
    persona?: string;
  }[];

  /**
   * People-graph entries — one per distinct person the item mentions.
   * Drain composes these into a single `ExtractionResult` for
   * `applyPeopleGraphExtraction` (one network call, not N).
   */
  people: {
    canonicalName: string;
    surface: string;
    surfaceType: 'name' | 'nickname' | 'role_phrase';
    relationshipHint: string;
    sourceExcerpt: string;
  }[];

  /** Preferences the user stated about a person / category / self. */
  preferences: {
    subjectKind: 'person' | 'self' | 'category';
    subject: string;
    preference: string;
    sourceExcerpt: string;
  }[];
}

/** Build an empty collector. Drain calls this once per item. */
export function emptyRememberSideEffects(): RememberSideEffects {
  return { routes: [], reminders: [], people: [], preferences: [] };
}

// ---------------------------------------------------------------------------
// route_to_persona
// ---------------------------------------------------------------------------

export function createRouteToPersonaTool(opts: {
  collect: RememberSideEffects;
}): AgentTool {
  return {
    name: 'route_to_persona',
    description:
      "Route this memory to the persona vault where it semantically belongs. Call once per memory. Use the persona names listed in the system prompt (typically general / work / health / finance — the user may have added others). General is the default for everyday personal notes; finance for budgets, spending, income, bills, debt; health for medical, fitness, symptoms; work for job-related context. When the memory genuinely straddles two areas (e.g., a doctor's bill — both health and finance), pass `secondary` with the additional name(s); otherwise leave it empty.",
    parameters: {
      type: 'object',
      properties: {
        persona: {
          type: 'string',
          description: 'Primary persona name. Must match an installed vault.',
        },
        secondary: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional personas — empty array if none.',
        },
      },
      required: ['persona'],
    },
    async execute(args) {
      const primary = typeof args.persona === 'string' ? args.persona.trim() : '';
      if (primary === '') return { error: 'persona is required' };
      const secondary = Array.isArray(args.secondary)
        ? args.secondary.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        : [];
      opts.collect.routes.push({ primary: primary.toLowerCase(), secondary });
      return { ok: true, routed_to: primary, secondary };
    },
  };
}

// ---------------------------------------------------------------------------
// link_to_person
// ---------------------------------------------------------------------------

export function createLinkToPersonTool(opts: {
  collect: RememberSideEffects;
}): AgentTool {
  return {
    name: 'link_to_person',
    description:
      "Record that this memory mentions a named individual. Use canonicalName for the formal name ('Emma', 'Dr Smith'), surface for the exact form in the user's text (might be 'Em' or 'my daughter Emma'), relationshipHint when the text explicitly states the relationship ('daughter', 'doctor', 'colleague') — leave empty when not stated. Call once per distinct person. Don't include yourself.",
    parameters: {
      type: 'object',
      properties: {
        canonicalName: {
          type: 'string',
          description: "The person's formal name as you'd address them.",
        },
        surface: {
          type: 'string',
          description: 'The exact phrasing the user used (may be a nickname or role phrase).',
        },
        surfaceType: {
          type: 'string',
          enum: ['name', 'nickname', 'role_phrase'],
          description: 'Kind of surface — name (Emma), nickname (Em), or role_phrase (my daughter).',
        },
        relationshipHint: {
          type: 'string',
          description:
            "Relationship if explicitly stated ('daughter', 'doctor'). Empty string when unstated.",
        },
        sourceExcerpt: {
          type: 'string',
          description: 'Short verbatim quote from the memory that justifies the link.',
        },
      },
      required: ['canonicalName', 'surface', 'surfaceType'],
    },
    async execute(args) {
      const canonicalName = typeof args.canonicalName === 'string' ? args.canonicalName.trim() : '';
      const surface = typeof args.surface === 'string' ? args.surface.trim() : '';
      if (canonicalName === '' || surface === '') {
        return { error: 'canonicalName and surface are required' };
      }
      const surfaceType =
        args.surfaceType === 'nickname' || args.surfaceType === 'role_phrase'
          ? args.surfaceType
          : 'name';
      opts.collect.people.push({
        canonicalName,
        surface,
        surfaceType,
        relationshipHint:
          typeof args.relationshipHint === 'string' ? args.relationshipHint.trim() : '',
        sourceExcerpt:
          typeof args.sourceExcerpt === 'string' ? args.sourceExcerpt.trim() : '',
      });
      return { ok: true, linked: canonicalName };
    },
  };
}

// ---------------------------------------------------------------------------
// bind_preference
// ---------------------------------------------------------------------------

export function createBindPreferenceTool(opts: {
  collect: RememberSideEffects;
}): AgentTool {
  return {
    name: 'bind_preference',
    description:
      "Record that the user stated a preference about a person, category, or themselves. Examples: 'Emma loves dinosaurs' → person Emma, preference 'loves dinosaurs'. 'I prefer my dentist on Tuesdays' → self, preference 'dentist on Tuesdays'. 'Hindi movies over Tamil' → category 'movies', preference 'Hindi over Tamil'. Don't call for memories that aren't preferences (a budget, a fact, a schedule entry).",
    parameters: {
      type: 'object',
      properties: {
        subjectKind: {
          type: 'string',
          enum: ['person', 'self', 'category'],
          description: 'Whose preference this is.',
        },
        subject: {
          type: 'string',
          description: "Subject name — person's canonicalName, or the category, or '' for self.",
        },
        preference: {
          type: 'string',
          description: 'The preference itself, phrased compactly.',
        },
        sourceExcerpt: {
          type: 'string',
          description: 'Short verbatim quote from the memory.',
        },
      },
      required: ['subjectKind', 'preference'],
    },
    async execute(args) {
      const subjectKind = args.subjectKind;
      if (subjectKind !== 'person' && subjectKind !== 'self' && subjectKind !== 'category') {
        return { error: 'subjectKind must be person, self, or category' };
      }
      const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
      const preference = typeof args.preference === 'string' ? args.preference.trim() : '';
      if (preference === '') return { error: 'preference is required' };
      if (subjectKind !== 'self' && subject === '') {
        return { error: 'subject is required when subjectKind is person or category' };
      }
      opts.collect.preferences.push({
        subjectKind,
        subject,
        preference,
        sourceExcerpt:
          typeof args.sourceExcerpt === 'string' ? args.sourceExcerpt.trim() : '',
      });
      return { ok: true };
    },
  };
}
