/**
 * Run the real-life scenarios (docs/REAL_LIFE_SCENARIOS.md) against the fleet.
 *
 *   npx tsx scripts/scenarios/run.ts                 every scenario
 *   npx tsx scripts/scenarios/run.ts --area A,B      some areas
 *   npx tsx scripts/scenarios/run.ts --only A7,E1    some scenarios
 *
 * Start the fleet first (`fleet.ts up`). Writes a report to
 * scripts/scenarios/.fleet/reports/ and prints a summary. Scenarios marked
 * [phone] are skipped; [gap] scenarios run and are expected to fail.
 */

import fs from 'node:fs';
import path from 'node:path';

import { areaA } from './areas/a_remember';
import { areaB } from './areas/b_ask';
import { areaC } from './areas/c_reminders';
import { areaD } from './areas/d_people';
import { areaE } from './areas/e_d2d';
import { areaF } from './areas/f_strangers';
import { areaG } from './areas/g_human';
import { areaH } from './areas/h_agents';
import { areaI, stopServices } from './areas/i_services';
import { areaJ } from './areas/j_groups';
import { areaK } from './areas/k_peerlens';
import { areaL, stopReferenceAgent } from './areas/l_a2a';
import { areaM, stopRecording } from './areas/m_privacy';
import { areaN } from './areas/n_errors';
import { Dina } from './client';
import { FLEET_DIR, loadDotEnv, NODE_NAMES, readState, type NodeName } from './fleet';
import { Ctx, type Check, type Scenario, type TurnRecord } from './scenario';

const ALL: Scenario[] = [...areaA, ...areaB, ...areaC, ...areaD, ...areaE, ...areaF, ...areaG, ...areaH, ...areaI, ...areaJ, ...areaK, ...areaL, ...areaM, ...areaN];

interface Outcome {
  id: string;
  title: string;
  mark?: string;
  status: 'pass' | 'fail' | 'error' | 'skipped' | 'gap-confirmed' | 'gap-passed';
  ms: number;
  checks: Check[];
  turns: TurnRecord[];
  error?: string;
}

function arg(name: string): string[] | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  return (process.argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Contacts the cast starts with (dina_details.md): Alonso and Sancho know
 * each other. Albert, the public bus and dentist provider, is a stranger to
 * Alonso, as in the bus example: Alonso's Dina must let in only the reply to
 * its own question. ChairMaker knows Alonso (it has his DID, as a shop
 * would), but Alonso does not know ChairMaker. Areas add contacts they need.
 */
async function setUp(d: Record<NodeName, Dina>): Promise<void> {
  const label = (n: NodeName) => n[0]!.toUpperCase() + n.slice(1);
  const pairs: [NodeName, NodeName][] = [['alonso', 'sancho']];
  for (const [x, y] of pairs) {
    await d[x].addContact(d[y].did, label(y));
    await d[y].addContact(d[x].did, label(x));
  }
  await d.chairmaker.addContact(d.alonso.did, label('alonso'));
}

async function main(): Promise<void> {
  loadDotEnv();
  const state = readState();
  if (state === null) throw new Error('no fleet: run `npx tsx scripts/scenarios/fleet.ts up` first');
  const dinas = {} as Record<NodeName, Dina>;
  for (const n of NODE_NAMES) dinas[n] = await Dina.connect(state.nodes[n]);
  await setUp(dinas);

  const only = arg('only');
  const areas = arg('area');
  const chosen = ALL.filter(
    (s) => (only === null || only.includes(s.id)) && (areas === null || areas.includes(s.id.replace(/\d+$/, ''))),
  );

  const outcomes: Outcome[] = [];
  for (const s of chosen) {
    const t0 = Date.now();
    if (s.mark === 'phone' || s.mark === 'harness') {
      outcomes.push({ id: s.id, title: s.title, mark: s.mark, status: 'skipped', ms: 0, checks: [], turns: [], ...(s.reason ? { error: s.reason } : {}) });
      console.log(`- ${s.id} ${s.title}: skipped (${s.mark}${s.reason ? `: ${s.reason}` : ''})`);
      continue;
    }
    const ctx = new Ctx(s.id, dinas);
    let error: string | undefined;
    try {
      await s.run(ctx);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const failed = ctx.checks.filter((c) => !c.pass);
    let status: Outcome['status'] =
      error !== undefined ? 'error' : failed.length > 0 || ctx.checks.length === 0 ? 'fail' : 'pass';
    if (s.mark === 'gap') status = status === 'pass' ? 'gap-passed' : 'gap-confirmed';
    const o: Outcome = { id: s.id, title: s.title, ...(s.mark ? { mark: s.mark } : {}), status, ms: Date.now() - t0, checks: ctx.checks, turns: ctx.turns, ...(error ? { error } : {}) };
    outcomes.push(o);
    const icon = { pass: '✓', fail: '✕', error: '!', skipped: '-', 'gap-confirmed': '○', 'gap-passed': '◎' }[status];
    console.log(`${icon} ${s.id} ${s.title} (${Math.round(o.ms / 1000)}s)${error ? ` — error: ${error}` : ''}`);
    for (const f of failed) console.log(`    ✕ ${f.name}${f.detail ? ` — ${f.detail.slice(0, 220)}` : ''}`);
  }

  // Put the fleet back as it was: Albert's runner, the A2A test agent, Alonso's direct model path.
  await stopServices().catch(() => undefined);
  stopReferenceAgent();
  await stopRecording().catch(() => undefined);

  const dir = path.join(FLEET_DIR, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `run-${stamp}.json`), JSON.stringify({ model: state.model, outcomes }, null, 2));
  const count = (st: Outcome['status']) => outcomes.filter((o) => o.status === st).length;
  console.log(
    `\n${outcomes.length} scenarios: ${count('pass')} pass, ${count('fail')} fail, ${count('error')} error, ` +
      `${count('gap-confirmed')} gaps confirmed, ${count('gap-passed')} gaps now passing, ${count('skipped')} skipped (phone)`,
  );
  console.log(`report: ${path.join(dir, `run-${stamp}.json`)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
