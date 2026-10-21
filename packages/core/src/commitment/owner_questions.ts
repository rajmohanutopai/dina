/**
 * Brain asks the owner where there is time (COMMITMENT_KERNEL §15 step 14).
 *
 * The step 11 question card for kinds outside the shelf engine: the organiser
 * of a group booking (always: the round waits on guests) and the shipper
 * (only when the hold leaves room for an answer and Brain's next move before
 * the seller's resend stops fitting). Goods counters never ask: a tender's
 * window is seconds.
 *
 * The kind decides whether there is time and how long the card stays open;
 * this module keeps the question and its card together, settles the answer
 * once, and hands it back to the kind. Nothing binds while a question is
 * open. The same two-question limit holds per negotiation.
 *
 *   - A YES OR A NO is kept, the card closes, and then the kind hands the turn
 *     back to Brain with every answer so far (`QuestionPort.after`).
 *   - A LAPSE closes the turn in the same write (`QuestionPort.answered`), and
 *     the fixed style plays it.
 *   - A QUESTION CORE WITHDRAWS (the deal moved on) is settled as a lapse
 *     before its card is cancelled, so the cancel's notice finds it settled.
 *
 * A crash between the answer and its card is finished at boot
 * (`reconcileOwnerQuestionsAtBoot`); one before the kind's follow-up, by the
 * kind's own next look.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import {
  getWorkflowService,
  type ApprovalDecisionHandler,
  type WorkflowHooks,
  type WorkflowService,
} from '../workflow/service';

import {
  LEAST_QUESTION_WAIT_MS,
  MAX_OWNER_QUESTIONS,
  StrategyQuestionStore,
  cleanQuestion,
  type OwnerAnswer,
  type StrategyQuestion,
} from './strategy_questions';

import type { DatabaseAdapter } from '../storage/db_adapter';

/** The card: Core's to mint, the owner's alone to answer. */
export const STRATEGY_QUESTION_TYPE = 'strategy_question';

/** What a kind does with its owner's answers. */
export interface QuestionPort {
  kind: string;
  /** What the deal is, in the card's words: "a group booking". */
  subject: string;
  /**
   * In the answer's own write: what must land with it (a lapse closes the
   * turn). Never opens a transaction of its own.
   */
  answered(question: StrategyQuestion, answer: OwnerAnswer, nowMs: number): void;
  /** After the answer is kept: hand the turn back to Brain, or let the fixed style answer. */
  after(question: StrategyQuestion, answer: OwnerAnswer, nowMs: number): void | Promise<void>;
}

interface Installed {
  questions: StrategyQuestionStore;
  atomically: (fn: () => void) => void;
}

let installed: Installed | null = null;
const ports = new Map<string, QuestionPort>();

/** Storage boot installs the store on the identity database; null in tests that do not. */
export function installOwnerQuestions(db: DatabaseAdapter | null): void {
  installed =
    db === null
      ? null
      : { questions: new StrategyQuestionStore(db), atomically: (fn) => db.transaction(fn) };
}

export function getOwnerQuestions(): StrategyQuestionStore | null {
  return installed?.questions ?? null;
}

export function installQuestionPort(port: QuestionPort): void {
  ports.set(port.kind, port);
}

export function uninstallQuestionPort(kind: string): void {
  ports.delete(kind);
}

/** The owner's answers so far, for the next brief; absent when there are none. */
export function ownerAnswersIn(
  kind: string,
  negotiationId: string,
): { ownerAnswers?: { question: string; answer: 'yes' | 'no' }[] } {
  const answers = installed?.questions.answered(kind, negotiationId) ?? [];
  return answers.length === 0 ? {} : { ownerAnswers: answers };
}

/**
 * Where a move stands against the owner's answers: `waiting` while this turn
 * has a question open (a replayed commit of the move that asked), `stale`
 * when the move's brief came before the owner's latest answer (the turn was
 * asked again with it), `current` otherwise.
 */
export function moveAgainstAnswers(
  kind: string,
  negotiationId: string,
  turn: number,
  answersSeen: number,
): 'waiting' | 'stale' | 'current' {
  const questions = installed?.questions;
  if (questions === undefined) return 'current';
  if (questions.openFor(kind, negotiationId, turn) !== null) return 'waiting';
  return questions.answered(kind, negotiationId).length === answersSeen ? 'current' : 'stale';
}

/** How many owner answers a move's brief carried, from Core's own input. */
export function answersSeenIn(input: unknown): number {
  const answers = (input as { ownerAnswers?: unknown } | null)?.ownerAnswers;
  return Array.isArray(answers) ? answers.length : 0;
}

/**
 * Put Brain's question to the owner on a card that lapses at `decideByMs`.
 * False (the caller lets the fixed style play) when the question is empty,
 * the deal has asked its share, the turn has one open, the card would give
 * the owner too little time, or no workflow can carry it.
 */
export function askOwnerOnCard(args: {
  kind: string;
  negotiationId: string;
  turn: number;
  question: string;
  decideByMs: number;
  nowMs: number;
  /** The deal's own ids, which Brain holds from its brief: never shown on the card. */
  hide?: readonly string[];
}): boolean {
  const store = installed;
  const workflow = getWorkflowService();
  const port = ports.get(args.kind);
  if (store === null || workflow === null || port === undefined) return false;
  let raw = args.question;
  for (const id of args.hide ?? []) if (id !== '') raw = raw.split(id).join('this deal');
  const question = cleanQuestion(raw);
  if (question === null) return false;
  if (args.decideByMs - args.nowMs < LEAST_QUESTION_WAIT_MS) return false;
  if (store.questions.countFor(args.kind, args.negotiationId) >= MAX_OWNER_QUESTIONS) return false;
  const cardId = `sq-${bytesToHex(randomBytes(12))}`;
  let asked = false;
  try {
    store.atomically(() => {
      if (
        !store.questions.ask({
          kind: args.kind,
          negotiationId: args.negotiationId,
          turn: args.turn,
          question,
          cardId,
          askedAt: args.nowMs,
        })
      )
        return;
      workflow.create({
        id: cardId,
        kind: WorkflowTaskKind.Approval,
        description: `Brain asks, on ${port.subject}: ${question}`,
        // No ids of the deal: the question as Brain wrote it, cleaned, and its kind.
        payload: JSON.stringify({
          type: STRATEGY_QUESTION_TYPE,
          card_id: cardId,
          kind: args.kind,
          question,
        }),
        idempotencyKey: `strategy_question:${cardId}`,
        correlationId: STRATEGY_QUESTION_TYPE,
        origin: 'system',
        initialState: WorkflowTaskState.PendingApproval,
        expiresAtSec: Math.floor(args.decideByMs / 1000),
      });
      asked = true;
    });
  } catch {
    return false; // nothing was kept: the question and its card land together
  }
  if (asked) appendAudit('commitment', 'strategy_question_asked', args.kind, `card=${cardId}`);
  return asked;
}

/**
 * Withdraw the questions still open in a negotiation that moved on (the owner
 * picked, the plan widened). Each is settled as a lapse first, so the
 * cancel's notice finds it settled; a crash between is finished at boot.
 * `keepTurn`: a turn whose question still stands.
 */
export function withdrawOwnerQuestions(
  kind: string,
  negotiationId: string,
  nowMs: number,
  keepTurn?: number,
): number {
  const store = installed;
  if (store === null) return 0;
  let withdrawn = 0;
  for (const q of store.questions.openIn(kind, negotiationId)) {
    if (q.turn === keepTurn) continue;
    if (settle(q, 'lapsed', nowMs) === null) continue;
    cancelCard(q.cardId);
    withdrawn += 1;
  }
  return withdrawn;
}

/**
 * Keep the answer once, with what the kind lands alongside it; the settled
 * question, or null when it was settled already or nothing is installed.
 */
function settle(q: StrategyQuestion, answer: OwnerAnswer, nowMs: number): StrategyQuestion | null {
  const store = installed;
  if (store === null) return null;
  let settled = false;
  store.atomically(() => {
    if (!store.questions.answer(q.cardId, answer, nowMs)) return;
    ports.get(q.kind)?.answered(q, answer, nowMs);
    settled = true;
  });
  return settled ? { ...q, answer, answeredAt: nowMs } : null;
}

function cancelCard(cardId: string): void {
  const workflow = getWorkflowService();
  if (workflow?.store().getById(cardId)?.status !== WorkflowTaskState.PendingApproval) return;
  try {
    workflow.cancel(cardId, 'the deal moved on');
  } catch {
    /* closed meanwhile */
  }
}

/** An approved card is done once its answer is kept. */
function completeCard(workflow: WorkflowService | null, task: WorkflowTask, nowMs: number): void {
  if (workflow === null) return;
  try {
    if (task.status === WorkflowTaskState.Queued)
      workflow
        .store()
        .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    workflow.complete(task.id, JSON.stringify({ answered: true }), 'answered');
  } catch {
    /* closed already */
  }
}

/** The kind's follow-up; a failure is finished by the kind's own next look. */
function followUp(q: StrategyQuestion, answer: OwnerAnswer, nowMs: number): void {
  const port = ports.get(q.kind);
  if (port === undefined) return;
  try {
    const pending = port.after(q, answer, nowMs);
    if (pending instanceof Promise) pending.catch(() => undefined);
  } catch {
    /* the kind looks again on its next turn */
  }
}

export function makeOwnerQuestionDecisionHandler(deps: {
  workflow: () => WorkflowService | null;
  nowMs: () => number;
}): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    const questions = installed?.questions;
    if (questions === undefined) return;
    const q = questions.byCard(task.id);
    if (q === null) return;
    const nowMs = deps.nowMs();
    const answer: OwnerAnswer =
      decision === 'approved' ? 'yes' : decision === 'denied' ? 'no' : 'lapsed';
    // A question Core withdrew is settled before its card is cancelled: the
    // cancel's notice lands here and finds nothing to do.
    const settled = q.answer === null ? settle(q, answer, nowMs) : null;
    if (decision === 'approved') completeCard(deps.workflow(), task, nowMs);
    if (settled !== null) {
      appendAudit('commitment', 'strategy_question_answered', q.kind, `answer=${answer}`);
      followUp(settled, answer, nowMs);
    }
  };
}

/** The question card's contribution to the workflow service, composed at every host. */
export function ownerQuestionWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeOwnerQuestionDecisionHandler({
      workflow: getWorkflowService,
      nowMs: over.nowMs ?? Date.now,
    }),
  };
}

/**
 * Boot: settle each open question whose card a crash left decided (approved:
 * yes; denied: no; lapsed, failed or gone: a lapse), finish approved cards
 * whose answer was kept, and cancel cards whose question was withdrawn.
 * Nothing goes back to Brain from here: the reasoning broker may not be up
 * yet, and a hand-back with no door would use up the owner's answer. Each
 * kind hands it back on its own next look (the plan's next read, the
 * seller's next resend). Returns how many questions it settled.
 */
export function reconcileOwnerQuestionsAtBoot(nowMs: number = Date.now()): number {
  const store = installed;
  const workflow = getWorkflowService();
  if (store === null || workflow === null) return 0;
  let settledCount = 0;
  for (const q of store.questions.openOf([...ports.keys()])) {
    const card = workflow.store().getById(q.cardId);
    const status = card?.status;
    if (status === WorkflowTaskState.PendingApproval) continue;
    const answer: OwnerAnswer =
      status === WorkflowTaskState.Queued ||
      status === WorkflowTaskState.Running ||
      status === WorkflowTaskState.Completed
        ? 'yes'
        : status === WorkflowTaskState.Cancelled
          ? 'no'
          : 'lapsed';
    const settled = settle(q, answer, nowMs);
    if (settled === null) continue;
    settledCount += 1;
  }
  for (const task of workflow.store().getByCorrelationId(STRATEGY_QUESTION_TYPE)) {
    const q = store.questions.byCard(task.id);
    if (q === null || q.answer === null) continue;
    if (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running)
      completeCard(workflow, task, nowMs);
    else if (task.status === WorkflowTaskState.PendingApproval) cancelCard(task.id);
  }
  return settledCount;
}
