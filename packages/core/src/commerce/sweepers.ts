/**
 * The commerce background ticks, started together.
 *
 * There are three, they are unrelated, and all three were built and left
 * unstarted:
 *
 *   - ADMISSION RECOVERY (§9.9 step 3) turns an expired `pre_effect`
 *     reservation into `rejected(decision_timeout)` and refunds the capacity
 *     it held. Unstarted, every abandoned order held its quote capacity for
 *     ever and answered the buyer `received_processing` for ever.
 *   - EPOCH REVALIDATION (§16.2) re-reads the live epoch record so a
 *     forgotten pre-restore node converges instead of signing at a cached
 *     epoch indefinitely.
 *   - BUYER RE-POLL (§12.7) asks a supplier again about an order whose outcome
 *     this node does not know. Unstarted, an ambiguous order sat for ever,
 *     which looks exactly like an order nobody cared about.
 *
 * WHY ONE HELPER RATHER THAN TWO CALLS PER BOOT. There are two composition
 * roots — the server and the phone — and a background process each root must
 * remember to start is one a root eventually forgets. That is not
 * hypothetical here: the admission sweeper's own header records that the
 * engine beneath it "was written, tested, and never called", and the sweeper
 * written to fix that went the same way. One call, one stop, both boots.
 *
 * WHY NOT ONE TIMER RUNNING A LIST OF TASKS. A task list would hide what
 * runs. These two have different clocks (a minute-scale sweep and an
 * hour-scale re-read), different failure meanings, and different observers;
 * folding them together would cost more in obscurity than the second
 * `setInterval` costs in machinery.
 */

import { CommerceAdmissionSweeper } from './admission_sweeper';
import { ContinuityReleaseSweeper } from './continuity_release_sweeper';
import { DispatchIntentSweeper } from './dispatch_intent_sweeper';
import { CommerceEpochRevalidator } from './epoch_revalidator';
import { ReconcilePollSweeper } from './reconcile_sweeper';

import type { CommerceAdmissionSweeperOptions } from './admission_sweeper';
import type { ContinuityReleaseSweeperOptions } from './continuity_release_sweeper';
import type { DispatchIntentSweeperOptions } from './dispatch_intent_sweeper';
import type { CommerceEpochRevalidatorOptions } from './epoch_revalidator';
import type { ReconcilePollSweeperOptions } from './reconcile_sweeper';

export interface CommerceSweeperOptions {
  admission: Pick<
    CommerceAdmissionSweeperOptions,
    'engine' | 'intervalMs' | 'onTimedOut' | 'onStuck' | 'onError'
  >;
  epoch: Pick<CommerceEpochRevalidatorOptions, 'service' | 'intervalMs' | 'onOutcome' | 'onError'>;
  /**
   * §12.7's buyer-side re-poll. Optional because a node with no outbound
   * transport cannot ask anybody anything, and starting a tick that can only
   * fail would fill an operator's log with a problem they did not have.
   */
  reconcile?: Pick<ReconcilePollSweeperOptions, 'send' | 'intervalMs' | 'onSweep' | 'onError'>;
  /**
   * §9.13 — retire a prior manifest's lifecycle lane once its last order is
   * finished. Optional for the same reason `reconcile` is: a node with no
   * plugin registry has no lanes to retire, and starting a tick that can only
   * find nothing is noise.
   */
  continuity?: Pick<
    ContinuityReleaseSweeperOptions,
    'releasable' | 'release' | 'intervalMs' | 'onReleased'
  >;
  /**
   * §5.1's dispatch-intent replay (PC-7) — crash recovery and transient
   * retry for the draft-scoped submit orchestrator. ALWAYS STARTED, never
   * optional: it resolves the commerce runtime per tick and a node with
   * none simply ticks quietly, while an optional duty here would repeat
   * the exact "built and left unstarted" history this file's header
   * narrates. Only the cadence and observers are configurable.
   */
  dispatch?: Pick<DispatchIntentSweeperOptions, 'intervalMs' | 'now' | 'onOutcome' | 'onError'>;
  /** Injectable timer pair, shared by all five. Tests pass fakes. */
  setInterval?: CommerceAdmissionSweeperOptions['setInterval'];
  clearInterval?: CommerceAdmissionSweeperOptions['clearInterval'];
}

export interface CommerceSweepers {
  admission: CommerceAdmissionSweeper;
  epoch: CommerceEpochRevalidator;
  /** Absent on a node with no outbound transport. */
  reconcile: ReconcilePollSweeper | null;
  continuity: ContinuityReleaseSweeper | null;
  dispatch: DispatchIntentSweeper;
  /** Stops every tick. Idempotent, so a teardown that runs twice is harmless. */
  stop: () => void;
}

/** Construct and start the commerce ticks. */
export function startCommerceSweepers(options: CommerceSweeperOptions): CommerceSweepers {
  const timers = {
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
  };
  const admission = new CommerceAdmissionSweeper({ ...options.admission, ...timers });
  const epoch = new CommerceEpochRevalidator({ ...options.epoch, ...timers });
  const reconcile =
    options.reconcile === undefined
      ? null
      : new ReconcilePollSweeper({ ...options.reconcile, ...timers });
  // §9.13 — retire a prior manifest's lifecycle lane once its last order is
  // finished. Continuity entries carry no expiry, so nothing else ever would.
  const continuity =
    options.continuity === undefined
      ? null
      : new ContinuityReleaseSweeper({ ...options.continuity, ...timers });
  const dispatch = new DispatchIntentSweeper({ ...(options.dispatch ?? {}), ...timers });
  admission.start();
  epoch.start();
  reconcile?.start();
  continuity?.start();
  dispatch.start();
  return {
    admission,
    epoch,
    reconcile,
    continuity,
    dispatch,
    stop: () => {
      // All stopped even if an earlier one throws: a teardown that abandons a
      // later timer leaves a process that will not exit and a phone that keeps
      // polling a repo for an identity the user has switched away from.
      try {
        admission.stop();
      } finally {
        try {
          epoch.stop();
        } finally {
          try {
            reconcile?.stop();
          } finally {
            try {
              continuity?.stop();
            } finally {
              dispatch.stop();
            }
          }
        }
      }
    },
  };
}
