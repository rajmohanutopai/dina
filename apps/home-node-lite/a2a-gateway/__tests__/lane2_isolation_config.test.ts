/**
 * The gateway's isolation as shipped (design §4.1 precondition (a); plan
 * §3.18; notes M2 preconditions: "its own container, user (UID 10003),
 * read-only root and key volume, on a network that only Core shares. The
 * gateway cannot reach Brain or the vault volume"). Read from the compose
 * file and the image recipes; running the containers is owed to a Docker run.
 * A native install has no container: the README tells the operator what that
 * costs (plan C8).
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parse } from 'yaml';

const LITE = path.join(__dirname, '..', '..');

interface Service {
  profiles?: string[];
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  ports?: string[];
}

const compose = parse(readFileSync(path.join(LITE, 'docker-compose.lite.yml'), 'utf8')) as {
  services: Record<string, Service>;
};
const recipe = (name: string): string => readFileSync(path.join(LITE, 'docker', name), 'utf8');
const dockerfile = recipe('Dockerfile.a2a-gateway');
const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

/** Every user id (`adduser -u N`) and group id (`addgroup -g N`) an image recipe creates. */
function idsOf(text: string): { users: number[]; groups: number[] } {
  const all = (re: RegExp): number[] => [...text.matchAll(re)].map((m) => Number(m[1]));
  return { users: all(/adduser\s+(?:[^\n]*?\s)?-u\s+(\d+)/g), groups: all(/addgroup\s+(?:[^\n]*?\s)?-g\s+(\d+)/g) };
}

const networksOf = (s: Service | undefined): string[] =>
  s?.networks === undefined ? [] : Array.isArray(s.networks) ? s.networks : Object.keys(s.networks);
const volumeNames = (s: Service | undefined): string[] => (s?.volumes ?? []).map((v) => v.split(':')[0] ?? '');

describe('the gateway container (design §4.1 precondition (a))', () => {
  const gateway = compose.services['a2a-gateway'];
  const others = Object.entries(compose.services).filter(([name]) => name !== 'a2a-gateway');

  // Plan C7
  it('runs in its own container: read-only root, every capability dropped, no new privileges, only its own key volume', () => {
    expect(gateway).toBeDefined();
    expect(gateway?.read_only).toBe(true);
    expect(gateway?.cap_drop).toEqual(['ALL']);
    expect(gateway?.security_opt).toContain('no-new-privileges:true');
    const mine = volumeNames(gateway);
    expect(mine).toEqual(['dina-a2a-gateway-key']);
    // No other service mounts the gateway's key, and the gateway mounts no one else's volume.
    for (const [, service] of others) {
      expect(volumeNames(service)).not.toContain('dina-a2a-gateway-key');
      for (const volume of volumeNames(service)) expect(mine).not.toContain(volume);
    }
  });

  // Plan C7
  it('shares a network with Core only: never with Brain', () => {
    const nets = networksOf(gateway);
    expect(nets).toEqual(['dina-a2a']);
    const sharing = others.filter(([, s]) => networksOf(s).some((n) => nets.includes(n))).map(([name]) => name);
    expect(sharing).toEqual(['core-lite']);
  });

  // Plan C7
  it('runs as its own user, UID 10003, which neither Core’s nor Brain’s image uses', () => {
    // The reader finds the ids it should: a control on a line written for it.
    expect(idsOf('RUN addgroup -g 10003 -S dina-gw \\\n && adduser  -u 10003 -S -G dina-gw dina-gw')).toEqual({ users: [10003], groups: [10003] });
    expect(idsOf(dockerfile)).toEqual({ users: [10003], groups: [10003] });
    // The image runs as the user it made with that id.
    const line = dockerfile.match(/adduser\s+-u 10003\b[^\n]*/)?.[0] ?? '';
    const made = line.replace(/\\\s*$/, '').trim().split(/\s+/).pop();
    expect(made).toBe('dina-gw');
    // The image runs as the user on its last USER line; a later USER root would undo an earlier one.
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)\s*$/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe(made);
    for (const name of ['Dockerfile.core', 'Dockerfile.brain']) {
      const ids = idsOf(recipe(name));
      // Each image does make a user of its own, and never with the gateway's ids.
      expect([name, ids.users.length > 0, ids.groups.length > 0]).toEqual([name, true, true]);
      expect([name, ids.users.includes(10003), ids.groups.includes(10003)]).toEqual([name, false, false]);
    }
    // Compose sets no other user over the image's: none at all, or the same id.
    const user = gateway?.user;
    expect(user === undefined || user === '10003' || user.startsWith('10003:')).toBe(true);
  });
});

describe('a native install (plan C8)', () => {
  // Plan C8
  it('the README says a gateway run as Core’s user does not meet the precondition, and not to open its port', () => {
    const at = readme.indexOf('## Isolation');
    expect(at).toBeGreaterThanOrEqual(0);
    const section = readme.slice(at).replace(/\s+/g, ' ');
    expect(section).toContain('A native install that runs the gateway as the same OS user as Core and Brain does not meet this.');
    expect(section).toContain("Do not open the gateway's port to the network there.");
  });
});
