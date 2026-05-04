import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const FORBIDDEN_PUBLIC_CORE_DEEP_IMPORT =
  /from\s+['"]@dina\/core\/src\/(?:contacts\/directory|crypto\/(?:bip39|slip0010|ed25519|aesgcm|argon2id|hkdf)|identity\/(?:directory|did|did_document|handle_picker|keypair)|persona\/(?:service|names)|vault\/lifecycle|constants)['"]/;
const FORBIDDEN_PUBLIC_BRAIN_CHAT_IMPORT =
  /(?:from|import\()\s*['"]@dina\/brain\/src\/chat\/(?:thread|orchestrator)['"]/;

describe('mobile package boundaries', () => {
  it('does not import Core or Brain source paths from production mobile code', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/@dina\/(?:core|brain)\/src/.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports public Core onboarding, identity, contacts, crypto, and persona APIs from @dina/core', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (FORBIDDEN_PUBLIC_CORE_DEEP_IMPORT.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports public Brain chat APIs from @dina/brain/chat', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (FORBIDDEN_PUBLIC_BRAIN_CHAT_IMPORT.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps mobile boot composition on public runtime subpaths', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      join(root, 'src', 'services', 'bootstrap.ts'),
      join(root, 'src', 'services', 'boot_service.ts'),
      join(root, 'src', 'services', 'boot_capabilities.ts'),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/@dina\/(?:core|brain)\/src/.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps mobile persistence setup on the public Core storage subpath', async () => {
    const root = join(__dirname, '..', '..');
    const files = await listTsFiles(join(root, 'src', 'storage'));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/@dina\/core\/src/.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports public Brain LLM APIs from @dina/brain/llm', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/@dina\/brain\/src\/(?:llm|pipeline\/chat_reasoning)/.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports public Brain enrichment and service schema APIs from package surfaces', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      join(root, 'src', 'services', 'staging_enrichment.ts'),
      join(root, 'src', 'services', 'appview_stub.ts'),
      join(root, 'src', 'services', 'demo_bus_driver_responder.ts'),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (
        /@dina\/brain\/src\/(?:enrichment|appview_client|service\/capabilities)/.test(source)
      ) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports reminders and notification inbox APIs from public subpaths', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (
        /@dina\/core\/src\/reminders\/service/.test(source) ||
        /@dina\/brain\/src\/notifications\/inbox/.test(source)
      ) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports Core service config and workflow APIs from @dina/core', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      join(root, 'src', 'hooks', 'useServiceConfigForm.ts'),
      join(root, 'src', 'services', 'demo_bus_driver_responder.ts'),
      join(root, 'app', 'service-settings.tsx'),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/@dina\/core\/src\/(?:service\/service_config|workflow\/service)/.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports D2D and MsgBox helper APIs from @dina/core/d2d', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      join(root, 'src', 'services', 'msgbox_wiring.ts'),
      join(root, 'src', 'services', 'chat_d2d.ts'),
      join(root, 'src', 'hooks', 'useD2DMessages.ts'),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/@dina\/core\/src\/(?:d2d|server\/routes\/d2d_msg|relay\/msgbox_ws)/.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('imports public Core/Brain root APIs for vault, sharing, export, unlock, nudges, and service delivery', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      join(root, 'src', 'hooks', 'useContactDetail.ts'),
      join(root, 'src', 'hooks', 'useServiceThreadDelivery.ts'),
      join(root, 'src', 'hooks', 'useUnlock.ts'),
      join(root, 'src', 'hooks', 'useChatNudges.ts'),
      join(root, 'src', 'hooks', 'useVaultBrowser.ts'),
      join(root, 'src', 'hooks', 'useVaultItems.ts'),
      join(root, 'src', 'hooks', 'useShareExport.ts'),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (
        /@dina\/core\/src\/(?:gatekeeper\/sharing|vault\/crud|export\/archive)/.test(source) ||
        /@dina\/brain\/src\/(?:service\/workflow_event_consumer|vault_context\/assembly|nudge\/whisper)/.test(source)
      ) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listTsFiles(path);
      if (entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx'))) return [path];
      return [];
    }),
  );
  return nested.flat();
}
