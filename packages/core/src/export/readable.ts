/**
 * "Everything you know about me" (REAL_LIFE_FIXES_2 §5).
 *
 * A readable JSON document of what Dina holds, for the owner. Brain may ask
 * Core to PREPARE one and gets back only the manifest and a random id; the
 * document itself is held in memory (never written by Core), for 15
 * minutes, and handed over once, to the owner's own device. Possessing the
 * id gives no access.
 *
 * A persona is included when the owner has it open (a locked one only after
 * its passphrase); a closed one is named with how to include it.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { listContacts } from '../contacts/directory';
import { onForgetCancelExports } from '../forget/forget';
import { getTopicRepository } from '../memory/repository';
import { getPeopleRepository } from '../people/repository';
import { listPersonas } from '../persona/service';
import { listByPersona } from '../reminders/service';
import { getVaultRepository } from '../vault/repository';

export interface ExportManifestEntry {
  persona: string;
  tier: string;
  included: boolean;
  /** For an excluded persona: how to include it. */
  why?: string;
  items: number;
}

export interface ExportManifest {
  personas: ExportManifestEntry[];
  people: number;
  contacts: number;
  reminders: number;
}

const TTL_MS = 15 * 60 * 1000;
const held = new Map<string, { doc: string; expiresAt: number }>();

function sweep(now: number): void {
  for (const [id, e] of held) if (e.expiresAt <= now) held.delete(id);
}

/** Build the document and its manifest from what Core holds now. */
export async function buildReadableExport(): Promise<{ manifest: ExportManifest; doc: Record<string, unknown> }> {
  const personas: ExportManifestEntry[] = [];
  const vault: Record<string, unknown[]> = {};
  const reminders: unknown[] = [];
  const topics: Record<string, string[]> = {};
  for (const p of listPersonas()) {
    const repo = getVaultRepository(p.name);
    if (!p.isOpen || repo === null) {
      personas.push({
        persona: p.name,
        tier: p.tier,
        included: false,
        why: p.tier === 'locked' ? `locked: unlock ${p.name} with your passphrase and ask again` : `closed: unlock ${p.name} and ask again`,
        items: 0,
      });
      continue;
    }
    const items = repo.valuesSync().map((i) => ({
      id: i.id,
      type: i.type,
      summary: i.summary,
      body: i.body,
      created: new Date(i.created_at || i.timestamp).toISOString(),
    }));
    vault[p.name] = items;
    personas.push({ persona: p.name, tier: p.tier, included: true, items: items.length });
    for (const r of listByPersona(p.name)) {
      reminders.push({ persona: p.name, message: r.message, due: new Date(r.due_at).toISOString() });
    }
    const t = getTopicRepository(p.name);
    if (t !== null) topics[p.name] = (await t.top(200, Math.floor(Date.now() / 1000))).map((x) => x.topic);
  }
  const people = (getPeopleRepository()?.listPeople() ?? [])
    .filter((p) => p.status !== 'rejected')
    .map((p) => ({
      name: p.canonicalName,
      relationship: p.relationshipHint,
      also_called: (p.surfaces ?? []).filter((s) => s.status !== 'rejected').map((s) => s.surface),
    }));
  const contacts = listContacts().map((c) => ({ name: c.displayName, did: c.did, relationship: c.relationship }));
  const manifest: ExportManifest = { personas, people: people.length, contacts: contacts.length, reminders: reminders.length };
  return {
    manifest,
    doc: { exported_at: new Date().toISOString(), manifest, vault, people, contacts, reminders, topics },
  };
}

/** Prepare an export: held in memory; the caller gets the manifest and an id. */
export async function prepareReadableExport(now: number = Date.now()): Promise<{ id: string; manifest: ExportManifest }> {
  sweep(now);
  // A forget that cancels exports while this one is being built (it awaits
  // topic reads) must not let a document holding the forgotten data be
  // stored afterwards: build again until no cancel came in between.
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = cancelGeneration;
    const { manifest, doc } = await buildReadableExport();
    if (generation !== cancelGeneration) continue;
    const id = `exp-${bytesToHex(randomBytes(16))}`;
    held.set(id, { doc: JSON.stringify(doc, null, 2), expiresAt: now + TTL_MS });
    return { id, manifest };
  }
  throw new Error('export: data kept changing while it was prepared; try again');
}

/** Raised by every cancel; a build that saw it change is thrown away. */
let cancelGeneration = 0;

/** Hand the document over once; null when unknown, expired or already taken. */
export function takeReadableExport(id: string, now: number = Date.now()): string | null {
  sweep(now);
  const e = held.get(id);
  if (e === undefined) return null;
  held.delete(id);
  return e.doc;
}

/** Drop every export not yet taken (a forget ran; REAL_LIFE_FIXES_2 §4.4). */
export function cancelReadableExports(): number {
  cancelGeneration++;
  const n = held.size;
  held.clear();
  return n;
}

onForgetCancelExports(cancelReadableExports);
