/**
 * Forgetting (REAL_LIFE_FIXES_2 §4).
 *
 * The owner asks in chat ("forget everything about Rhea", "archive my work
 * stuff but keep the references"). Brain proves the owner's turn and names
 * a request; Core builds the plan from its own data, raises a Core-minted,
 * presence-gated card, and on the owner's approval runs a durable job that
 * clears every copy it can reach:
 *
 *   1. items: text, embedding, links cleared; the row stays as a tombstone
 *   2. vectors removed from the in-RAM index
 *   3. subject links and person excerpts
 *   4. reminders made from the items, or naming the person
 *   5. chat messages naming the person, staging rows, thread receipts
 *   6. the person record and its surfaces; topics
 *   7. readable exports not yet fetched
 *   8. the card's own text, cut to counts
 *   9. the forget epoch, so Brain reloads its thread copies
 *  10. one audit entry, counts only
 *
 * Each step is idempotent and recorded as done; a job interrupted by a crash
 * resumes at boot. A persona that closed before its items were forgotten is
 * finished inside its next unlock, before it opens. The job state lives in
 * Core's key-value store (identity database), on both hosts.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { drawsOnlyFrom, verifySpanProof, type SpanProof } from '../a2a/span_proof';
import { appendAudit } from '../audit/service';
import { getChatMessageRepository } from '../chat/repository';
import { removeFromIndex } from '../embedding/persona_index';
import { kvGet, kvList, kvSet } from '../kv/store';
import { getTopicRepository } from '../memory/repository';
import { getPeopleRepository } from '../people/repository';
import { setUnlockForgetHook } from '../persona/orchestrator';
import { isPersonaOpen, listPersonas } from '../persona/service';
import { deleteReminder, listByPersona } from '../reminders/service';
import { forgetStagingItems, stagingIdsForItems } from '../staging/service';
import { getVaultRepository } from '../vault/repository';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

export const OWNER_FORGET_APPROVAL_TYPE = 'owner_forget';

/** What the owner asked to forget: exactly one of the three. */
export type ForgetRequest =
  | { person: string }
  | { persona: string; keep_item_ids?: string[] }
  | { item_ids: string[] };

export interface ForgetPlan {
  request: ForgetRequest;
  /** Person resolved by Core; empty for a persona or item request. */
  personId: string;
  personName: string;
  /** Whole-word surfaces of the person (lower-cased). */
  surfaces: string[];
  items: { persona: string; id: string; label: string }[];
  /** Items Brain named (item_ids request): marked on the card. */
  chosenByDina: boolean;
  reminders: { id: string; label: string }[];
  chatMessages: { id: string; threadId: string }[];
  stagingIds: string[];
  topics: { persona: string; topic: string }[];
  /** Personas closed when the plan was made: not searched. */
  closedPersonas: string[];
  /** Persona or item requests do not search conversation text. */
  conversationKept: boolean;
}

/** Ambiguous or unknown person: the plan cannot be approved. */
export type PlanOutcome =
  | { ok: true; plan: ForgetPlan }
  | { ok: false; reason: 'ambiguous'; candidates: string[] }
  | { ok: false; reason: 'not_found' | 'empty' | 'bad_request' };

const FORGET_VERBS = /\b(forget|delete|erase|remove|archive|wipe|get rid of|clear out)\b/i;
const NS = 'forget_jobs';
const EPOCH_KEY = 'forget_epoch';

// ---------------------------------------------------------------------------
// Matching: whole words only. "Anna" never plans "Annabel".
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mentionsWholeWord(text: string, surfaces: readonly string[]): boolean {
  if (text === '' || surfaces.length === 0) return false;
  return surfaces.some((s) => s !== '' && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(s)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
}

function label(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= 80 ? t : `${t.slice(0, 80)}…`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planForget(request: ForgetRequest): Promise<PlanOutcome> {
  const personas = listPersonas();
  const open = personas.filter((p) => p.isOpen).map((p) => p.name);
  const closedPersonas = personas.filter((p) => !p.isOpen).map((p) => p.name);
  const plan: ForgetPlan = {
    request,
    personId: '',
    personName: '',
    surfaces: [],
    items: [],
    chosenByDina: false,
    reminders: [],
    chatMessages: [],
    stagingIds: [],
    topics: [],
    closedPersonas,
    conversationKept: true,
  };

  if ('person' in request) {
    const want = request.person.trim().toLowerCase();
    if (want === '') return { ok: false, reason: 'bad_request' };
    const people = getPeopleRepository()?.listPeople() ?? [];
    const matches = people.filter(
      (p) =>
        p.status !== 'rejected' &&
        (p.canonicalName.toLowerCase() === want ||
          (p.surfaces ?? []).some((s) => s.status !== 'rejected' && s.normalizedSurface === want)),
    );
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', candidates: matches.map((m) => m.canonicalName) };
    const person = matches[0];
    plan.personName = person?.canonicalName ?? request.person.trim();
    plan.personId = person?.personId ?? '';
    plan.surfaces = [
      ...new Set(
        [plan.personName, ...(person?.surfaces ?? []).filter((s) => s.status !== 'rejected').map((s) => s.surface)]
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length >= 2),
      ),
    ];
    plan.conversationKept = false;
    for (const persona of open) {
      const repo = getVaultRepository(persona);
      if (repo === null) continue;
      const linked = new Set(plan.personId !== '' ? repo.getItemIdsForPersonSync(plan.personId) : []);
      for (const item of repo.valuesSync()) {
        const text = `${item.summary} ${item.body}`;
        if (linked.has(item.id) || mentionsWholeWord(text, plan.surfaces)) {
          plan.items.push({ persona, id: item.id, label: label(item.summary || item.body) });
        }
      }
    }
    if (person === undefined && plan.items.length === 0) return { ok: false, reason: 'not_found' };
  } else if ('persona' in request) {
    const persona = request.persona.trim().toLowerCase();
    if (!personas.some((p) => p.name === persona)) return { ok: false, reason: 'not_found' };
    if (!isPersonaOpen(persona)) {
      plan.closedPersonas = [...new Set([...plan.closedPersonas, persona])];
    } else {
      const keep = new Set(request.keep_item_ids ?? []);
      for (const item of getVaultRepository(persona)?.valuesSync() ?? []) {
        if (!keep.has(item.id)) plan.items.push({ persona, id: item.id, label: label(item.summary || item.body) });
      }
    }
  } else if ('item_ids' in request) {
    if (!Array.isArray(request.item_ids) || request.item_ids.length === 0) return { ok: false, reason: 'bad_request' };
    plan.chosenByDina = true;
    const ids = new Set(request.item_ids);
    for (const persona of open) {
      for (const item of getVaultRepository(persona)?.valuesSync() ?? []) {
        if (ids.has(item.id)) plan.items.push({ persona, id: item.id, label: label(item.summary || item.body) });
      }
    }
  } else {
    return { ok: false, reason: 'bad_request' };
  }

  const itemIds = new Set(plan.items.map((i) => i.id));
  for (const persona of open) {
    for (const r of listByPersona(persona)) {
      if (itemIds.has(r.source_item_id) || mentionsWholeWord(r.message, plan.surfaces)) {
        plan.reminders.push({ id: r.id, label: label(r.message) });
      }
    }
  }
  plan.stagingIds = stagingIdsForItems([...itemIds], plan.surfaces);
  // Topics drawn from a forgotten item, or naming the person, go for every
  // kind of request: the ToC must not keep what the vault no longer holds.
  for (const persona of open) {
    const topics = getTopicRepository(persona);
    if (topics === null) continue;
    for (const t of await topics.top(500, Math.floor(Date.now() / 1000))) {
      if (plan.surfaces.includes(t.topic.toLowerCase()) || (t.sample_item_id !== undefined && itemIds.has(t.sample_item_id))) {
        plan.topics.push({ persona, topic: t.topic });
      }
    }
  }
  if (!plan.conversationKept) {
    const chat = getChatMessageRepository();
    if (chat !== null) {
      for (const threadId of await chat.listThreadIds()) {
        // A contact's Talk thread (keyed by DID) is kept; the card says so.
        if (threadId.startsWith('did:')) continue;
        for (const m of await chat.listByThread(threadId)) {
          if (mentionsWholeWord(m.content, plan.surfaces)) plan.chatMessages.push({ id: m.id, threadId });
        }
      }
    }
  }
  if (plan.items.length === 0 && plan.reminders.length === 0 && plan.chatMessages.length === 0 && plan.personId === '') {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, plan };
}

/** What the card says: counts, short labels, and what forgetting cannot reach. */
export function describePlan(plan: ForgetPlan): string {
  const what =
    'person' in plan.request
      ? `everything about ${plan.personName}`
      : 'persona' in plan.request
        ? `the items in ${plan.request.persona}${(plan.request.keep_item_ids ?? []).length > 0 ? ` except ${plan.request.keep_item_ids!.length} you keep` : ''}`
        : `${plan.items.length} item${plan.items.length === 1 ? '' : 's'}${plan.chosenByDina ? ' (chosen by Dina: check them)' : ''}`;
  const lines = [`Forget ${what}:`];
  if (plan.items.length > 0) lines.push(`- ${plan.items.length} note${plan.items.length === 1 ? '' : 's'}: ${plan.items.slice(0, 5).map((i) => `"${i.label}"`).join('; ')}${plan.items.length > 5 ? '; …' : ''}`);
  if (plan.reminders.length > 0) lines.push(`- ${plan.reminders.length} reminder${plan.reminders.length === 1 ? '' : 's'}`);
  if (plan.chatMessages.length > 0) lines.push(`- ${plan.chatMessages.length} chat message${plan.chatMessages.length === 1 ? '' : 's'}`);
  if (plan.personId !== '') lines.push(`- the person ${plan.personName} in People`);
  lines.push('This cannot be undone.');
  const kept: string[] = [];
  if (plan.closedPersonas.length > 0) kept.push(`${plan.closedPersonas.join(', ')} ${plan.closedPersonas.length === 1 ? 'was' : 'were'} closed and not searched: unlock and ask again to include ${plan.closedPersonas.length === 1 ? 'it' : 'them'}`);
  if (plan.conversationKept) kept.push('what you said about it in conversation stays; ask me to forget a person to remove that too');
  if ('person' in plan.request) kept.push('a contact and your message thread with them stay (remove them in People)');
  kept.push('backups made earlier, and messages already sent to other people, still hold it');
  lines.push(`Not reached: ${kept.join('; ')}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export type ForgetProposeOutcome =
  | { status: 'confirm_pending'; task_id: string; summary: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'refused'; reason: string };

/** Brain proposes with the owner's turn; Core plans and always raises a card. */
export async function proposeForget(input: { proof: SpanProof; request: ForgetRequest }): Promise<ForgetProposeOutcome> {
  const checked = verifySpanProof(input.proof, 'forget');
  if (!checked.ok) return { status: 'refused', reason: `owner turn not proven (${checked.reason})` };
  // The owner's own turn must ask to forget, delete or archive something:
  // an agent's text or a contact's message cannot start this.
  if (!FORGET_VERBS.test(checked.turnText)) return { status: 'refused', reason: 'the owner did not ask to forget anything' };
  if ('person' in input.request && !drawsOnlyFrom(input.request.person, checked.turnText)) {
    return { status: 'refused', reason: 'the person must be named in the owner\'s words' };
  }
  const outcome = await planForget(input.request);
  if (!outcome.ok) {
    if (outcome.reason === 'ambiguous') return { status: 'ambiguous', candidates: outcome.candidates };
    return { status: 'refused', reason: outcome.reason === 'empty' ? 'nothing to forget' : outcome.reason };
  }
  const service = getWorkflowService();
  if (service === null) return { status: 'refused', reason: 'approvals are not available' };
  const jobId = `forget-${bytesToHex(randomBytes(8))}`;
  const summary = describePlan(outcome.plan);
  await saveJob({ id: jobId, state: 'proposed', plan: outcome.plan, done: [], pending: [], createdAt: Date.now() });
  service.create({
    id: jobId,
    kind: WorkflowTaskKind.Approval,
    description: summary,
    payload: JSON.stringify({ type: OWNER_FORGET_APPROVAL_TYPE, job_id: jobId }),
    expiresAtSec: Math.floor(Date.now() / 1000) + 24 * 3600,
    origin: 'system',
    initialState: WorkflowTaskState.PendingApproval,
  });
  return { status: 'confirm_pending', task_id: jobId, summary };
}

export function isOwnerForgetApproval(task: WorkflowTask | null): boolean {
  if (task === null) return false;
  try {
    return (JSON.parse(task.payload) as { type?: unknown }).type === OWNER_FORGET_APPROVAL_TYPE;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The durable job
// ---------------------------------------------------------------------------

type Step =
  | 'items'
  | 'vectors'
  | 'links'
  | 'reminders'
  | 'chat_staging'
  | 'person_topics'
  | 'exports'
  | 'card'
  | 'epoch'
  | 'audit';

const STEPS: readonly Step[] = ['items', 'vectors', 'links', 'reminders', 'chat_staging', 'person_topics', 'exports', 'card', 'epoch', 'audit'];

interface ForgetJob {
  id: string;
  /**
   * 'closing': every step ran; other waiting cards that quote the same
   * person or items (`closeIds`) are still to be closed. The plan's content
   * is dropped only once they are.
   */
  state: 'proposed' | 'running' | 'closing' | 'waiting_on_unlock' | 'done' | 'cancelled';
  /** Other proposals to close before this job finishes (opaque ids). */
  closeIds?: string[];
  plan: ForgetPlan;
  done: Step[];
  /** Items in a persona that closed before they were forgotten. */
  pending: { persona: string; id: string }[];
  createdAt: number;
  finishedAt?: number;
  /** Counts kept once the plan's content is dropped. */
  counts?: { items: number; reminders: number; chat: number; person: number };
}

/**
 * The plan with every name, surface, label and id-to-text link removed:
 * what a finished, declined or expired job keeps. Only counts, and the
 * opaque ids of items still waiting for a closed persona, remain.
 */
function contentFree(job: ForgetJob): ForgetJob {
  const p = job.plan;
  const counts = job.counts ?? { items: p.items.length, reminders: p.reminders.length, chat: p.chatMessages.length, person: p.personId !== '' ? 1 : 0 };
  const request: ForgetRequest = 'person' in p.request ? { person: '' } : 'persona' in p.request ? { persona: p.request.persona } : { item_ids: [] };
  return {
    ...job,
    counts,
    plan: {
      request,
      personId: '',
      personName: '',
      surfaces: [],
      items: [],
      chosenByDina: p.chosenByDina,
      reminders: [],
      chatMessages: [],
      stagingIds: [],
      topics: [],
      closedPersonas: [],
      conversationKept: p.conversationKept,
    },
  };
}

/** A repository method forget needs; missing means the step cannot be done. */
function required<T>(fn: T | undefined, what: string): T {
  if (fn === undefined) throw new Error(`forget: this host cannot ${what}`);
  return fn;
}

/** One job at a time per id: approve, resume and unlock share it. */
const jobLocks = new Map<string, Promise<unknown>>();
async function withJobLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  jobLocks.set(id, next);
  try {
    return await next;
  } finally {
    if (jobLocks.get(id) === next) jobLocks.delete(id);
  }
}

async function saveJob(job: ForgetJob): Promise<void> {
  await kvSet(job.id, JSON.stringify(job), NS);
}

async function loadJob(id: string): Promise<ForgetJob | null> {
  const raw = await kvGet(id, NS);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ForgetJob;
  } catch {
    return null;
  }
}

/** Hooks other features register (readable exports, §5). */
const exportCancellers: (() => number)[] = [];
export function onForgetCancelExports(fn: () => number): void {
  exportCancellers.push(fn);
}

export async function forgetEpoch(): Promise<number> {
  return Number((await kvGet(EPOCH_KEY, NS)) ?? '0') || 0;
}

/** The text of every planned item, for scrubbing receipts that quote them. */
function plannedTexts(plan: ForgetPlan): string[] {
  return plan.items.map((i) => i.label.replace(/…$/, '').toLowerCase()).filter((t) => t.length >= 4);
}

async function runStep(job: ForgetJob, step: Step): Promise<void> {
  const plan = job.plan;
  switch (step) {
    case 'items': {
      for (const item of plan.items) {
        if (!isPersonaOpen(item.persona)) {
          // Closed: finished inside its next unlock, before it opens.
          if (!job.pending.some((p) => p.id === item.id)) job.pending.push({ persona: item.persona, id: item.id });
          continue;
        }
        const repo = getVaultRepository(item.persona);
        // Open but not loaded yet (early boot): try again on the next resume.
        if (repo === null) throw new Error('vault not loaded yet');
        repo.forgetItemSync(item.id);
      }
      for (const persona of new Set(plan.items.map((i) => i.persona))) getVaultRepository(persona)?.checkpointSync();
      return;
    }
    case 'vectors':
      for (const item of plan.items) removeFromIndex(item.persona, item.id);
      return;
    case 'links': {
      const people = getPeopleRepository();
      for (const item of plan.items) people?.clearExcerptsForItem(item.id);
      return;
    }
    case 'reminders':
      for (const r of plan.reminders) deleteReminder(r.id);
      return;
    case 'chat_staging': {
      forgetStagingItems(plan.stagingIds);
      const chat = getChatMessageRepository();
      if (chat === null) return;
      // The planned messages, and any naming the person written since the
      // plan (the forget request itself, Dina's card reply), so the thread
      // keeps no trace of who was forgotten. A contact's Talk thread is kept.
      const ids = new Set(plan.chatMessages.map((m) => m.id));
      if (!plan.conversationKept && plan.surfaces.length > 0) {
        for (const threadId of await chat.listThreadIds()) {
          if (threadId.startsWith('did:')) continue;
          for (const m of await chat.listByThread(threadId)) {
            if (mentionsWholeWord(m.content, plan.surfaces)) ids.add(m.id);
          }
        }
      }
      if (ids.size > 0) {
        await required(chat.deleteMessages?.bind(chat), 'delete chat messages')([...ids]);
      }
      // Receipts (REAL_LIFE_FIXES_2 §3) hold names and message text: drop
      // any that name the person or quote a forgotten item.
      const texts = plannedTexts(plan);
      for (const threadId of await chat.listThreadIds()) {
        for (const m of await chat.listByThread(threadId)) {
          const receipts = m.metadata?.receipts;
          if (!Array.isArray(receipts)) continue;
          const kept = (receipts as { targets?: unknown; object?: unknown }[]).filter((r) => {
            const blob = `${Array.isArray(r.targets) ? r.targets.join(' ') : ''} ${typeof r.object === 'string' ? r.object : ''}`;
            return !mentionsWholeWord(blob, plan.surfaces) && !texts.some((t) => blob.toLowerCase().includes(t));
          });
          if (kept.length !== receipts.length) await chat.append({ ...m, metadata: { ...m.metadata, receipts: kept } });
        }
      }
      return;
    }
    case 'person_topics': {
      const people = getPeopleRepository();
      if (plan.personId !== '' && people !== null) {
        // Erased, not only marked rejected: no name, surface or excerpt stays.
        required(people.erasePerson?.bind(people), 'erase a person')(plan.personId);
      }
      for (const t of plan.topics) {
        const topics = getTopicRepository(t.persona);
        if (topics === null) continue;
        await required(topics.remove?.bind(topics), 'remove a topic')(t.topic);
      }
      return;
    }
    case 'exports':
      for (const cancel of exportCancellers) cancel();
      return;
    case 'card': {
      const repo = getWorkflowService()?.store();
      const counts = `Forgotten: ${plan.items.length} notes, ${plan.reminders.length} reminders, ${plan.chatMessages.length} chat messages${plan.personId !== '' ? ', 1 person' : ''}.`;
      if (repo !== undefined) required(repo.scrubCardText?.bind(repo), 'scrub card text')(job.id, counts, JSON.stringify({ type: OWNER_FORGET_APPROVAL_TYPE, job_id: job.id }), Date.now());
      return;
    }
    case 'epoch':
      await kvSet(EPOCH_KEY, String((await forgetEpoch()) + 1), NS);
      return;
    case 'audit':
      appendAudit(
        'owner',
        'forget_done',
        job.id,
        `items=${plan.items.length} reminders=${plan.reminders.length} chat=${plan.chatMessages.length} staging=${plan.stagingIds.length} person=${plan.personId !== '' ? 1 : 0} pending=${job.pending.length}`,
      );
      return;
  }
}

/** Run (or resume) a job from its first unfinished step. */
export async function runForgetJob(jobId: string): Promise<ForgetJob['state'] | null> {
  const ran = await withJobLock(jobId, () => runForgetJobLocked(jobId));
  if (ran !== 'closing') return ran;
  // Outside this job's lock (never two locks held at once): close the other
  // waiting cards found in the steps, then finish under the lock again. Both
  // parts are safe to repeat, so a crash in between resumes here.
  const job = await loadJob(jobId);
  for (const id of job?.closeIds ?? []) await closeProposal(id);
  return withJobLock(jobId, async () => {
    const j = await loadJob(jobId);
    if (j === null || j.state !== 'closing') return j?.state ?? null;
    // A persona that opened while this job ran (its unlock already passed):
    // forget its waiting items now rather than at some later unlock.
    for (const persona of new Set(j.pending.map((p) => p.persona))) {
      if (!isPersonaOpen(persona)) continue;
      const repo = getVaultRepository(persona);
      if (repo === null) continue;
      for (const p of j.pending.filter((x) => x.persona === persona)) {
        repo.forgetItemSync(p.id);
        // Its index was loaded on open, from the embedding still stored then.
        removeFromIndex(persona, p.id);
      }
      repo.checkpointSync();
      j.pending = j.pending.filter((x) => x.persona !== persona);
    }
    const state: ForgetJob['state'] = j.pending.length > 0 ? 'waiting_on_unlock' : 'done';
    await saveJob(contentFree({ ...j, state, closeIds: [], ...(state === 'done' ? { finishedAt: Date.now() } : {}) }));
    return state;
  });
}

async function runForgetJobLocked(jobId: string): Promise<ForgetJob['state'] | null> {
  const job = await loadJob(jobId);
  if (job === null || job.state !== 'running') return job?.state ?? null;
  for (const step of STEPS) {
    if (job.done.includes(step)) continue;
    await runStep(job, step);
    job.done.push(step);
    await saveJob(job);
  }
  // Every step ran. Record which other waiting cards quote the same person
  // or items before any of this job's content is dropped.
  job.closeIds = await overlappingProposals(job);
  job.state = 'closing';
  await saveJob(job);
  return 'closing';
}

/** Other forget proposals still waiting whose plan names the same person or items. */
async function overlappingProposals(job: ForgetJob): Promise<string[]> {
  const ids = new Set(job.plan.items.map((i) => i.id));
  const out: string[] = [];
  for (const entry of await kvList(NS)) {
    if (entry.key.endsWith(EPOCH_KEY)) continue;
    const other = await loadJob(entry.key.replace(`${NS}:`, ''));
    if (other === null || other.id === job.id || other.state !== 'proposed') continue;
    const overlaps =
      (job.plan.personId !== '' && other.plan.personId === job.plan.personId) ||
      other.plan.items.some((i) => ids.has(i.id)) ||
      (job.plan.surfaces.length > 0 && other.plan.surfaces.some((s) => job.plan.surfaces.includes(s)));
    if (overlaps) out.push(other.id);
  }
  return out;
}

/** Close one waiting proposal another forget covered (safe to repeat). */
async function closeProposal(id: string): Promise<void> {
  await withJobLock(id, async () => {
    const other = await loadJob(id);
    if (other === null || other.state !== 'proposed') return;
    try {
      getWorkflowService()?.cancel(other.id, 'superseded by an approved forget');
    } catch {
      /* already decided or gone */
    }
    await dropProposal(other, 'Not needed: an approved forget covered this.');
  });
}

/** A proposal that will not run: keep counts only, and cut its card to them. */
async function dropProposal(job: ForgetJob, cardText: string): Promise<void> {
  // Card first: if a crash comes between, the job is still 'proposed' with
  // its card no longer waiting, and the next resume drops it again.
  const repo = getWorkflowService()?.store();
  if (repo !== undefined) required(repo.scrubCardText?.bind(repo), 'scrub card text')(job.id, cardText, JSON.stringify({ type: OWNER_FORGET_APPROVAL_TYPE, job_id: job.id }), Date.now());
  await saveJob(contentFree({ ...job, state: 'cancelled' }));
}

/** The owner approved the card: start the job. */
export async function approveForget(task: WorkflowTask): Promise<ForgetJob['state'] | null> {
  const id = (JSON.parse(task.payload) as { job_id?: string }).job_id ?? '';
  await withJobLock(id, async () => {
    const job = await loadJob(id);
    if (job !== null && job.state === 'proposed') {
      job.state = 'running';
      await saveJob(job);
    }
  });
  return runForgetJob(id);
}

/** The owner declined: the plan is dropped and the card cut to a line. */
export async function cancelForget(task: WorkflowTask): Promise<void> {
  const id = (JSON.parse(task.payload) as { job_id?: string }).job_id ?? '';
  await withJobLock(id, async () => {
    const job = await loadJob(id);
    if (job !== null && job.state === 'proposed') await dropProposal(job, 'Not forgotten: you declined.');
  });
}

/** Boot: resume every job a crash or restart interrupted. */
let resuming = false;
export async function resumeForgetJobs(): Promise<number> {
  if (resuming) return 0;
  resuming = true;
  try {
    return await resumeOnce();
  } finally {
    resuming = false;
  }
}

async function resumeOnce(): Promise<number> {
  let resumed = 0;
  for (const entry of await kvList(NS)) {
    if (entry.key.endsWith(EPOCH_KEY)) continue;
    let job = await loadJob(entry.key.replace(`${NS}:`, ''));
    // Without the workflow service a card's fate cannot be read: leave
    // proposals as they are (boot runs this again once it is installed).
    if (job !== null && job.state === 'proposed' && getWorkflowService() === null) continue;
    if (job !== null && job.state === 'proposed') {
      // The card was approved but a crash came before the job started; or
      // it expired or was declined without reaching cancelForget.
      const task = getWorkflowService()?.store().getById(job.id) ?? null;
      const approved = task !== null && (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running);
      const waiting = task !== null && task.status === WorkflowTaskState.PendingApproval;
      if (approved) {
        await withJobLock(job.id, async () => {
          const j = await loadJob(job!.id);
          if (j !== null && j.state === 'proposed') await saveJob({ ...j, state: 'running' });
        });
        job = await loadJob(job.id);
      } else if (!waiting) {
        await withJobLock(job.id, async () => {
          const j = await loadJob(job!.id);
          if (j !== null && j.state === 'proposed') await dropProposal(j, 'Not forgotten: the card expired.');
        });
        continue;
      }
    }
    if (job !== null && (job.state === 'running' || job.state === 'closing' || job.state === 'done' || job.state === 'waiting_on_unlock')) {
      try {
        const state = job.state === 'running' || job.state === 'closing' ? await runForgetJob(job.id) : job.state;
        if (job.state === 'running' || job.state === 'closing') resumed++;
        // The card stayed open across the restart: settle it now.
        const service = getWorkflowService();
        const task = service?.store().getById(job.id) ?? null;
        if (service !== null && task !== null && (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running)) {
          if (state === 'done' || state === 'waiting_on_unlock') {
            try {
              // queued → running → completed (see settleApprovedCard).
              service.store().claimApprovalForExecution(job.id, 60, Math.floor(Date.now() / 1000));
              service.complete(job.id, JSON.stringify({ forgotten: true }), 'forgotten');
            } catch {
              /* already settled */
            }
          }
        }
      } catch {
        /* not ready yet; the next resume tries again */
      }
    }
  }
  return resumed;
}

/**
 * Inside a persona's unlock, after its file opens and before it is marked
 * open or its index loads: forget the items that were waiting for it. A
 * failure keeps the persona closed (the caller refuses the unlock).
 */
export async function finishPendingForgets(persona: string): Promise<boolean> {
  for (const entry of await kvList(NS)) {
    if (entry.key.endsWith(EPOCH_KEY)) continue;
    const id = entry.key.replace(`${NS}:`, '');
    const ok = await withJobLock(id, async () => {
      const job = await loadJob(id);
      // Items gathered while the persona was closed wait in `pending` from
      // the first step on, whatever the job's state: the persona never opens
      // with them in it.
      if (job === null || !['running', 'closing', 'waiting_on_unlock'].includes(job.state)) return true;
      const mine = job.pending.filter((p) => p.persona === persona);
      if (mine.length === 0) return true;
      const repo = getVaultRepository(persona);
      if (repo === null) return false;
      for (const p of mine) repo.forgetItemSync(p.id);
      repo.checkpointSync();
      job.pending = job.pending.filter((p) => p.persona !== persona);
      if (job.state !== 'waiting_on_unlock') {
        // Still running or closing: keep its plan and state; it finishes itself.
        await saveJob(job);
        return true;
      }
      if (job.pending.length === 0) {
        job.state = 'done';
        job.finishedAt = Date.now();
        appendAudit('owner', 'forget_done_after_unlock', job.id, `persona_items=${mine.length}`);
      }
      await saveJob(contentFree(job));
      return true;
    });
    if (!ok) return false;
  }
  return true;
}

/** Jobs a reply may report on (owner-facing). */
export async function forgetJobState(jobId: string): Promise<{ state: ForgetJob['state']; pendingPersonas: string[] } | null> {
  const job = await loadJob(jobId);
  if (job === null) return null;
  return { state: job.state, pendingPersonas: [...new Set(job.pending.map((p) => p.persona))] };
}

// Pending forgets finish inside a persona's next unlock.
setUnlockForgetHook(finishPendingForgets);
