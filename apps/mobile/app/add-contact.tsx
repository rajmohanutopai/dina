/**
 * Add Contact — form to append a peer to the core contact directory.
 *
 * Accepts a DID directly, or a handle (e.g.
 * `busdriver.test-pds.dinakernel.com`). For handle input, we resolve
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
import { addContact, getContact } from '@dina/core/src/contacts/directory';
import { getProfile as getTrustProfile } from '../src/trust/appview_runtime';
import { colors, fonts, spacing, radius } from '../src/theme';

export default function AddContactScreen() {
  const router = useRouter();
  const [didOrHandle, setDidOrHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'idle' | 'resolving' | 'saving' | 'error'>('idle');
  const [errorText, setErrorText] = useState('');

  const submit = async (): Promise<void> => {
    setErrorText('');
    const raw = didOrHandle.trim();
    if (raw === '') {
      setStatus('error');
      setErrorText('Enter a DID or handle.');
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

    if (getContact(did) !== null) {
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
      router.back();
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
          Paste a handle (alice.test-pds.dinakernel.com) or a DID (did:plc:…).
          Just the handle is enough — the host is the PDS.
        </Text>

        <Text style={styles.label}>Handle or DID</Text>
        <TextInput
          value={didOrHandle}
          onChangeText={setDidOrHandle}
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
            onPress={() => router.back()}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            disabled={busy}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
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
 * Two strategies, tried in order — both per the AT Protocol spec
 * (atproto.com/specs/handle):
 *
 *   1. **Well-known HTTPS** — GET `https://<handle>/.well-known/atproto-did`.
 *      Returns the DID as plain text. Canonical method; the handle's
 *      host serves it directly. Works for hosted PDS where users get
 *      subdomains and the PDS routes well-known correctly.
 *
 *   2. **PDS xrpc resolve** — POST to
 *      `https://<inferred-host>/xrpc/com.atproto.identity.resolveHandle`
 *      with the inferred host being everything after the leftmost
 *      label of the handle (`alice.test-pds.dinakernel.com` →
 *      `test-pds.dinakernel.com`). Fallback for dev environments
 *      where well-known isn't wired up yet.
 *
 * The DNS TXT method (the third spec'd path, `_atproto.<handle>`) is
 * intentionally skipped — React Native has no built-in DNS resolver
 * and the well-known + xrpc paths cover the deployments we care
 * about (hosted PDS with TLS).
 *
 * Throws on resolution failure with a message that names which path
 * failed last so the user can recover (e.g. typo'd handle vs.
 * unreachable PDS).
 */
async function resolveHandle(handle: string): Promise<string> {
  const trimmed = handle.trim().toLowerCase();
  // Path 1: well-known. Bypasses any need for the user to know the
  // PDS URL — the handle IS the host.
  try {
    const wkDid = await resolveViaWellKnown(trimmed);
    if (wkDid !== null) return wkDid;
  } catch {
    // Fall through to xrpc path; the well-known endpoint can be
    // missing on dev PDS deployments without affecting xrpc.
  }

  // Path 2: xrpc on the inferred PDS host. Strip the leftmost label
  // — `alice.test-pds.dinakernel.com` → `test-pds.dinakernel.com`.
  const dot = trimmed.indexOf('.');
  if (dot < 0) {
    throw new Error('Handle must include a domain (e.g. alice.test-pds.dinakernel.com)');
  }
  const pdsHost = trimmed.slice(dot + 1);
  if (pdsHost === '') {
    throw new Error('Handle must include a domain');
  }
  const xrpcUrl = `https://${pdsHost}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(trimmed)}`;
  const res = await fetch(xrpcUrl);
  if (!res.ok) {
    throw new Error(`PDS ${pdsHost} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { did?: string };
  if (typeof body.did !== 'string' || !body.did.startsWith('did:')) {
    throw new Error(`PDS ${pdsHost} returned no DID`);
  }
  return body.did;
}

/**
 * Try the AT Protocol well-known method. Returns the DID on success,
 * `null` if the endpoint exists but returns no usable body, throws
 * on transport error.
 */
async function resolveViaWellKnown(handle: string): Promise<string | null> {
  const url = `https://${handle}/.well-known/atproto-did`;
  const res = await fetch(url);
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
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm,
    fontFamily: fonts.mono,
    fontSize: 15,
  },
  error: {
    fontFamily: fonts.sansMedium,
    marginTop: spacing.md,
    color: colors.error,
    fontSize: 14,
  },
  hint: {
    fontFamily: fonts.sans,
    marginTop: spacing.md,
    color: colors.textMuted,
    fontSize: 13,
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
  cancelText: {
    fontFamily: fonts.sansSemibold,
    color: colors.textPrimary,
    fontSize: 15,
  },
  save: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  saveText: {
    fontFamily: fonts.sansSemibold,
    color: '#FFFFFF',
    fontSize: 15,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
