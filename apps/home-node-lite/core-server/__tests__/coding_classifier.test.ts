/**
 * Item 3b — path-aware file-tool classifier tests.
 *
 * Exercises the security core: a read/write whose CANONICAL (symlink- and
 * `..`-resolved) path targets a protected artifact classifies as
 * `secret_read`/`secret_write` (BLOCKED); a project path is `code_read`/
 * `code_edit` (SAFE). Uses a real on-disk vault dir + project dir + symlinks so
 * the canonicalisation path (not just string matching) is covered.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  canonicalizePath,
  classifyFileToolCall,
  isProtectedPath,
} from '../src/gate/coding_classifier';

let root: string; // realpath'd test root
let vaultDir: string; // <root>/vault
let projectDir: string; // <root>/project

beforeEach(() => {
  // realpath the temp root: on macOS os.tmpdir() is a symlink (/var → /private/var).
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cls-')));
  vaultDir = path.join(root, 'vault');
  projectDir = path.join(root, 'project');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  // Vault artifacts.
  fs.writeFileSync(path.join(vaultDir, 'keyfile'), 'SEED');
  fs.writeFileSync(path.join(vaultDir, 'personal.sqlite'), 'DB');
  fs.writeFileSync(path.join(vaultDir, 'recovery-phrase.txt'), 'twelve words');
  // Project artifacts.
  fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isProtectedPath (pure, canonical input)', () => {
  it('flags a file directly under the vault dir', () => {
    expect(isProtectedPath(path.join(vaultDir, 'keyfile'), { vaultDir })).toBe(true);
    expect(isProtectedPath(path.join(vaultDir, 'personal.sqlite'), { vaultDir })).toBe(true);
  });

  it('flags a file in a nested vault subdir (inbox/, etc.)', () => {
    expect(isProtectedPath(path.join(vaultDir, 'inbox', 'blob.bin'), { vaultDir })).toBe(true);
  });

  it('does not flag a project file', () => {
    expect(isProtectedPath(path.join(projectDir, 'index.ts'), { vaultDir })).toBe(false);
  });

  it('flags the unambiguous Dina state basenames anywhere (defence in depth)', () => {
    expect(isProtectedPath(path.join(projectDir, 'wrapped_seed.bin'), { vaultDir })).toBe(true);
    expect(isProtectedPath(path.join(projectDir, 'recovery-phrase.txt'), { vaultDir })).toBe(true);
    expect(isProtectedPath(path.join(projectDir, 'pds_identity.json'), { vaultDir })).toBe(true);
  });

  it('does NOT flag a bare project file named "keyfile" (over-block avoided) — vault keyfile is caught by containment', () => {
    // 'keyfile' is a common word; matching it anywhere over-blocks grep/cat.
    expect(isProtectedPath(path.join(projectDir, 'keyfile'), { vaultDir })).toBe(false);
    // the REAL seed under the vault dir is still protected (containment).
    expect(isProtectedPath(path.join(vaultDir, 'keyfile'), { vaultDir })).toBe(true);
  });

  it('flags secret basenames: .env, .env.local, *.pem, *.key, id_rsa, credentials', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      'server.pem',
      'private.key',
      'id_rsa',
      'id_ed25519',
      'credentials',
      'aws.credentials',
      'store.keystore',
    ]) {
      expect(isProtectedPath(path.join(projectDir, name), { vaultDir })).toBe(true);
    }
  });

  it('does not flag lookalikes that are not secrets', () => {
    for (const name of ['environment.ts', 'keyboard.ts', 'monkey.ts', 'readme.md']) {
      expect(isProtectedPath(path.join(projectDir, name), { vaultDir })).toBe(false);
    }
  });

  it('flags files under an extra keyDir', () => {
    const keyDir = path.join(root, 'keys');
    fs.mkdirSync(keyDir);
    expect(isProtectedPath(path.join(keyDir, 'device.key'), { vaultDir, keyDirs: [keyDir] })).toBe(
      true,
    );
  });

  it('returns false for empty input', () => {
    expect(isProtectedPath('', { vaultDir })).toBe(false);
  });

  it('does not flag a sibling dir whose name prefixes the vault dir', () => {
    // /root/vault-backup must NOT count as under /root/vault.
    const sibling = path.join(root, 'vault-backup', 'notes.txt');
    expect(isProtectedPath(sibling, { vaultDir })).toBe(false);
  });
});

describe('canonicalizePath', () => {
  it('resolves a symlink pointing into the vault', () => {
    const link = path.join(projectDir, 'sneaky');
    fs.symlinkSync(path.join(vaultDir, 'keyfile'), link);
    expect(canonicalizePath(link, projectDir)).toBe(path.join(vaultDir, 'keyfile'));
  });

  it('resolves `..` traversal', () => {
    const traversal = path.join(projectDir, '..', 'vault', 'keyfile');
    expect(canonicalizePath(traversal, projectDir)).toBe(path.join(vaultDir, 'keyfile'));
  });

  it('resolves relative paths against cwd', () => {
    expect(canonicalizePath('index.ts', projectDir)).toBe(path.join(projectDir, 'index.ts'));
  });

  it('resolves a non-existent write target via its symlinked parent', () => {
    // A symlinked dir whose target is the vault; a new file under it must
    // canonicalise into the vault even though the leaf does not exist yet.
    const linkDir = path.join(projectDir, 'vlink');
    fs.symlinkSync(vaultDir, linkDir);
    expect(canonicalizePath(path.join(linkDir, 'newfile.sqlite'), projectDir)).toBe(
      path.join(vaultDir, 'newfile.sqlite'),
    );
  });
});

describe('classifyFileToolCall', () => {
  const call = (toolName: string, rawPath: string, keyDirs?: string[]) =>
    classifyFileToolCall({ toolName, rawPaths: [rawPath], vaultDir, cwd: projectDir, keyDirs });

  it('Read of a project file → code_read (SAFE)', () => {
    expect(call('Read', 'index.ts')).toEqual({ action: 'code_read', risk: 'SAFE' });
  });

  it('Read of the seed keyfile → secret_read (BLOCKED)', () => {
    expect(call('Read', path.join(vaultDir, 'keyfile'))).toEqual({
      action: 'secret_read',
      risk: 'BLOCKED',
    });
  });

  it('Read of a vault .sqlite → secret_read (BLOCKED)', () => {
    expect(call('Read', path.join(vaultDir, 'personal.sqlite'))).toEqual({
      action: 'secret_read',
      risk: 'BLOCKED',
    });
  });

  it('Read of .env → secret_read (BLOCKED)', () => {
    expect(call('Read', '.env')).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('Grep/Glob/LS of a project file → code_read (SAFE)', () => {
    for (const tool of ['Grep', 'Glob', 'LS']) {
      expect(call(tool, 'index.ts')).toEqual({ action: 'code_read', risk: 'SAFE' });
    }
  });

  it('Write to a project file → code_edit (SAFE)', () => {
    expect(call('Write', 'newmodule.ts')).toEqual({ action: 'code_edit', risk: 'SAFE' });
  });

  it('Write to the vault keyfile → secret_write (BLOCKED)', () => {
    expect(call('Write', path.join(vaultDir, 'keyfile'))).toEqual({
      action: 'secret_write',
      risk: 'BLOCKED',
    });
  });

  it('Edit of .env → secret_write (BLOCKED)', () => {
    expect(call('Edit', '.env')).toEqual({ action: 'secret_write', risk: 'BLOCKED' });
  });

  it('NotebookEdit of a project notebook → code_edit_external (MODERATE)', () => {
    expect(call('NotebookEdit', 'analysis.ipynb')).toEqual({
      action: 'code_edit_external',
      risk: 'MODERATE',
    });
  });

  it('NotebookEdit of a protected path is still secret_write (protection wins)', () => {
    expect(call('NotebookEdit', path.join(vaultDir, 'x.ipynb'))).toEqual({
      action: 'secret_write',
      risk: 'BLOCKED',
    });
  });

  it('an unrecognised file tool does NOT fall through to SAFE (conservative MODERATE)', () => {
    // Safety net: if the dispatcher ever mis-routes an unknown tool here, an
    // unprotected target must be at least MODERATE (approval), never SAFE.
    expect(call('SomeFutureWriteTool', 'index.ts')).toEqual({
      action: 'code_edit_external',
      risk: 'MODERATE',
    });
  });

  it('symlink from the project into the vault → secret_read (canonicalised)', () => {
    const link = path.join(projectDir, 'sneaky.ts');
    fs.symlinkSync(path.join(vaultDir, 'keyfile'), link);
    expect(call('Read', 'sneaky.ts')).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('`..` traversal to the keyfile → secret_read (canonicalised)', () => {
    expect(call('Read', '../vault/keyfile')).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('AUDIT: a DANGLING symlink leaf into the vault → secret_write (create-only plant)', () => {
    // project/plant -> <vault>/newsecret.sqlite whose target does NOT exist yet.
    const link = path.join(projectDir, 'plant');
    fs.symlinkSync(path.join(vaultDir, 'newsecret.sqlite'), link);
    expect(call('Write', 'plant')).toEqual({ action: 'secret_write', risk: 'BLOCKED' });
  });

  it('AUDIT: a dangling symlink leaf read → secret_read', () => {
    const link = path.join(projectDir, 'peek');
    fs.symlinkSync(path.join(vaultDir, 'notyet.sqlite'), link);
    expect(call('Read', 'peek')).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('AUDIT2: relative symlink target through a symlinked dir resolves to the vault → secret_read', () => {
    // project/dirlink -> vault (symlinked dir); project/dirlink/rel -> ./keyfile
    // (relative). The relative target must resolve against the REAL dir (vault).
    const dirlink = path.join(projectDir, 'dirlink');
    fs.symlinkSync(vaultDir, dirlink);
    fs.symlinkSync('keyfile', path.join(vaultDir, 'rel')); // relative leaf
    expect(call('Read', path.join('dirlink', 'rel'))).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('AUDIT2: a symlink CYCLE fails closed (BLOCKED), never open', () => {
    // a -> b, b -> a (a cycle). Must not classify as a benign SAFE read.
    fs.symlinkSync(path.join(projectDir, 'b'), path.join(projectDir, 'a'));
    fs.symlinkSync(path.join(projectDir, 'a'), path.join(projectDir, 'b'));
    expect(call('Read', 'a').risk).toBe('BLOCKED');
  });

  it('AUDIT3: case-variant path under the vault is protected (case-insensitive fs)', () => {
    // isUnder compares case-insensitively so /Vault/KeyFile is caught.
    expect(isProtectedPath('/root/Vault/KeyFile', { vaultDir: '/root/vault' })).toBe(true);
    // a genuinely distinct sibling dir is still not under it
    expect(isProtectedPath('/root/vault-backup/x', { vaultDir: '/root/vault' })).toBe(false);
  });

  it('AUDIT3: mid-path .. after a symlinked dir resolves to the vault → secret_read', () => {
    // project/inbox -> vault; reading project/inbox/../keyfile must resolve
    // inbox to vault FIRST (kernel order), landing at /keyfile's real parent.
    fs.symlinkSync(vaultDir, path.join(projectDir, 'inbox'));
    // inbox/keyfile == vault/keyfile (exists) — reachable via the symlink
    expect(call('Read', path.join('inbox', 'keyfile'))).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('AUDIT3: broadened credential basenames are protected', () => {
    for (const name of ['.netrc', '.pgpass', '.git-credentials', '.npmrc', 'key.jks', 'cert.der', 'authorized_keys']) {
      expect(isProtectedPath(path.join(projectDir, name), { vaultDir })).toBe(true);
    }
  });

  it('AUDIT3: a deeply-nested legit path is NOT over-blocked (no depth-cap false positive)', () => {
    let deep = projectDir;
    for (let i = 0; i < 30; i++) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'file.ts'), 'x');
    expect(call('Read', path.join(deep, 'file.ts'))).toEqual({ action: 'code_read', risk: 'SAFE' });
  });

  it('a write whose symlinked parent resolves into the vault → secret_write', () => {
    const linkDir = path.join(projectDir, 'vlink');
    fs.symlinkSync(vaultDir, linkDir);
    expect(call('Write', path.join('vlink', 'exfil.sqlite'))).toEqual({
      action: 'secret_write',
      risk: 'BLOCKED',
    });
  });

  it('multi-path call is protected if ANY operand is protected', () => {
    const res = classifyFileToolCall({
      toolName: 'Read',
      rawPaths: ['index.ts', path.join(vaultDir, 'keyfile')],
      vaultDir,
      cwd: projectDir,
    });
    expect(res).toEqual({ action: 'secret_read', risk: 'BLOCKED' });
  });

  it('honours a keyDir for device credentials', () => {
    const keyDir = path.join(root, 'agentkeys');
    fs.mkdirSync(keyDir);
    fs.writeFileSync(path.join(keyDir, 'device_ed25519'), 'k');
    expect(call('Read', path.join(keyDir, 'device_ed25519'), [keyDir])).toEqual({
      action: 'secret_read',
      risk: 'BLOCKED',
    });
  });
});
