/**
 * Add Contact — form to append a peer to the core contact directory.
 *
 * Accepts a DID directly, or a handle (e.g.
 * `demoprovider.test-pds.dinakernel.com`). For handle input, we resolve
 * to a DID via AT Protocol's standard methods — `.well-known/atproto-
 * did` on the handle's host, falling back to the PDS xrpc endpoint
 * with the host inferred from the handle (strip the leftmost label).
 * The resolved DID flows into `addContact` and the screen pops back
 * to People on save.
 *
 * **No separate PDS URL field**: the handle's host IS the PDS, so
 * asking the user to type both was redundant friction. The fallback
 * chain handles the rare case where well-known fails (e.g. local
 * dev PDS without TLS / well-known not served), inferring the PDS
 * URL from the handle automatically.
 *
 * Trust defaults to `verified` — it's an explicit user action, not
 * an auto-discovery, so the default lets the peer's inbound messages
 * stage immediately. Users can tighten this later from the contact
 * detail view (not built yet).
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { addContact, getContact } from '@dina/core';
import { getProfile as getTrustProfile } from '../src/peerlens/appview_runtime';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import { parseContactCard } from '../src/services/contact_card';
import { colors, spacing, radius, textStyles } from '../src/theme';

export default function AddContactScreen() {
  const router = useRouter();
  const [didOrHandle, setDidOrHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'idle' | 'resolving' | 'saving' | 'error'>('idle');
  const [errorText, setErrorText] = useState('');

  const submit = async (): Promise<void> => {
    setErrorText('');
    // Parse at submit (NOT on every keystroke — rewriting the field as the
    // user types mangles a multi-line paste). Whatever is in the field —
    // a bare handle, a bare DID, or a whole pasted contact card — is run
    // through the card parser, which pulls out a clean identifier + name.
    const parsed = parseContactCard(didOrHandle);
    const raw = parsed.identifier.trim();
    if (raw === '') {
      setStatus('error');
      setErrorText('Enter a DID, handle, or paste a contact card.');
      return;
    }

    let did = raw;
    if (!raw.startsWith('did:')) {
      setStatus('resolving');
      try {
        did = await resolveHandle(raw);
      } catch (err) {
        setStatus('error');
        setErrorText(
          `Couldn't resolve handle: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    // You can't be your own contact. Adding the owner's own DID collides
    // with the owner's existing record in the people graph and wedges the
    // save (the spinner never clears). Reject it with a clear message
    // BEFORE any write. (People often paste their own card to test Share.)
    const ownDid = getBootedNode()?.did ?? null;
    if (ownDid !== null && did === ownDid) {
      setStatus('error');
      setErrorText("That's your own contact card. You can't add yourself.");
      return;
    }

    const existing = getContact(did);
    if (existing !== null) {
      setStatus('error');
      setErrorText('That DID is already in your contacts.');
      return;
    }

    // If the user typed a bare DID and didn't enter a display name,
    // try the AppView for the contact's published handle and use it
    // as the default — `did:plc:abc1234…` is unreadable, but
    // `alice.pds.dinakernel.com` is recognisable. The lookup is
    // best-effort; on failure we fall back to the existing
    // `prettyNameFromDid` (handle-first-label or DID slice).
    let name = displayName.trim();
    // A pasted card carries the sender's name — prefer it over a lookup.
    if (name === '' && parsed.name != null && parsed.name.trim() !== '') {
      name = parsed.name.trim();
    }
    if (name === '') {
      if (raw.startsWith('did:')) {
        try {
          const profile = await getTrustProfile(did);
          if (profile?.handle) name = profile.handle;
        } catch {
          // Best-effort — silent on failure; fall through to prettyName.
        }
      }
      if (name === '') name = prettyNameFromDid(did, raw);
    }

    setStatus('saving');
    try {
      addContact(did, name, 'verified');
      router.replace('/people');
    } catch (err) {
      setStatus('error');
      setErrorText(`Couldn't add contact: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const busy = status === 'resolving' || status === 'saving';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* The Stack header already shows "Add Contact" — repeating it
            as a serif H1 here doubled the title for no benefit. The
            helper line carries the actual instruction the user reads
            first. */}
        <Text style={styles.sub}>
          Paste a contact card someone shared, or a handle
          (alice.test-pds.dinakernel.com) or DID (did:plc:…). Just the handle
          is enough. The host is the PDS.
        </Text>

        <Text style={styles.label}>Handle, DID, or pasted card</Text>
        <TextInput
          testID="add-contact-handle-input"
          value={didOrHandle}
          onChangeText={setDidOrHandle}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder="alice.test-pds.dinakernel.com"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          editable={!busy}
        />

        <Text style={styles.label}>Display name (optional)</Text>
        <TextInput
          testID="add-contact-name-input"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="e.g. Alice"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          editable={!busy}
        />

        {errorText !== '' && <Text style={styles.error}>{errorText}</Text>}

        <View style={styles.buttons}>
          <Pressable
            testID="add-contact-cancel"
            accessibilityRole="button"
            onPress={() => router.replace('/people')}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            disabled={busy}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            testID="add-contact-save"
            accessibilityRole="button"
            onPress={submit}
            style={({ pressed }) => [
              styles.save,
              pressed && styles.pressed,
              busy && styles.disabled,
            ]}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.saveText}>Save contact</Text>
            )}
          </Pressable>
        </View>

        {status === 'resolving' && <Text style={styles.hint}>Resolving handle via PDS…</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Resolve a handle (e.g. `alice.test-pds.dinakernel.com`) to a DID.
 *
 * Two strategies, both per the AT Protocol spec (atproto.com/specs/handle):
 *
 *   1. **PDS xrpc resolve** (tried first) — GET
 *      `https://<inferred-host>/xrpc/com.atproto.identity.resolveHandle`
 *      with the inferred host being everything after the leftmost label
 *      of the handle (`alice.test-pds.dinakernel.com` →
 *      `test-pds.dinakernel.com`). This is the common case for every
 *      PDS-hosted handle: the handle is a subdomain *of* the PDS, the
 *      PDS knows the DID.
 *
 *   2. **Well-known HTTPS** (fallback) — GET
 *      `https://<handle>/.well-known/atproto-did`. Canonical for
 *      self-hosted handles where the handle is a real DNS host that
 *      serves its own DID document.
 *
 * Order matters: PDS-hosted handles dominate, and Path 2 always issues
 * a DNS lookup against the handle as if it were a host (e.g.
 * `alonso64.test-pds.dinakernel.com`). For PDS-hosted handles that DNS
 * lookup is guaranteed to NXDOMAIN. On iOS, RN's fetch wraps the failed
 * response in an `RCTBlobManager` Blob whose ID dangles before the
 * surrounding catch can swallow it, producing a useless
 * `"Unable to resolve data for blob: <UUID>"` error that bypasses
 * fallback. Putting xrpc first means we never trip the iOS quirk on
 * the common path.
 *
 * The DNS TXT method (the third spec'd path, `_atproto.<handle>`) is
 * intentionally skipped — React Native has no built-in DNS resolver
 * and the xrpc + well-known paths cover the deployments we care about
 * (hosted PDS with TLS, plus self-hosted handles with /.well-known).
 *
 * Throws on resolution failure with a message that names which path
 * failed last so the user can recover (e.g. typo'd handle vs.
 * unreachable PDS).
 */
/**
 * fetch with a hard timeout. Without this, a non-responsive PDS host
 * leaves the "Save" spinner hung forever (there is no other way out of
 * `resolveHandle`). On timeout the AbortError propagates like any other
 * transport error, so the existing fallback + error handling kicks in.
 */
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveHandle(handle: string): Promise<string> {
  const trimmed = handle.trim().toLowerCase();
  const dot = trimmed.indexOf('.');
  if (dot < 0) {
    throw new Error('Handle must include a domain (e.g. alice.test-pds.dinakernel.com)');
  }
  const pdsHost = trimmed.slice(dot + 1);
  if (pdsHost === '') {
    throw new Error('Handle must include a domain');
  }

  // Path 1 (preferred): PDS xrpc on the inferred host. Works for every
  // PDS-hosted handle without a DNS round-trip against the handle itself.
  let xrpcError: Error | null = null;
  try {
    const xrpcUrl = `https://${pdsHost}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(trimmed)}`;
    const res = await fetchWithTimeout(xrpcUrl);
    if (res.ok) {
      const body = (await res.json()) as { did?: string };
      if (typeof body.did === 'string' && body.did.startsWith('did:')) {
        return body.did;
      }
      xrpcError = new Error(`PDS ${pdsHost} returned no DID`);
    } else {
      xrpcError = new Error(`PDS ${pdsHost} returned HTTP ${res.status}`);
    }
  } catch (err) {
    xrpcError = err instanceof Error ? err : new Error(String(err));
  }

  // Path 2 (fallback): well-known on the handle itself. Only meaningful
  // for self-hosted handles where the handle is a real DNS host.
  try {
    const wkDid = await resolveViaWellKnown(trimmed);
    if (wkDid !== null) return wkDid;
  } catch {
    // Swallow; report xrpc's error below since it was the primary path.
  }

  throw xrpcError ?? new Error(`Could not resolve handle ${trimmed}`);
}

/**
 * Try the AT Protocol well-known method. Returns the DID on success,
 * `null` if the endpoint exists but returns no usable body, throws
 * on transport error.
 */
async function resolveViaWellKnown(handle: string): Promise<string | null> {
  const url = `https://${handle}/.well-known/atproto-did`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    // 404 / 503 / etc are not errors at this layer — the caller falls
    // back to xrpc. Throwing here would short-circuit the fallback.
    return null;
  }
  const text = (await res.text()).trim();
  if (!text.startsWith('did:')) return null;
  return text;
}

function prettyNameFromDid(did: string, originalInput: string): string {
  // If the original input was a handle, use its first label as the name.
  if (!originalInput.startsWith('did:')) {
    const first = originalInput.split('.')[0];
    if (first !== '') return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return `${did.slice(0, 14)}\u2026`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  content: {
    padding: spacing.lg,
  },
  sub: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  label: {
    ...textStyles.label,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    ...textStyles.mono,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm,
  },
  error: {
    ...textStyles.body,
    marginTop: spacing.md,
    color: colors.error,
  },
  hint: {
    ...textStyles.bodySmall,
    marginTop: spacing.md,
  },
  buttons: {
    flexDirection: 'row',
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  cancelText: textStyles.bodyStrong,
  save: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  saveText: {
    ...textStyles.bodyStrong,
    color: colors.white,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
