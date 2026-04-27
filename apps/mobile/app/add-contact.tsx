/**
 * Add Contact — form to append a peer to the core contact directory.
 *
 * Accepts a DID directly, or a handle (e.g.
 * `busdriver.test-pds.dinakernel.com`) which we resolve via the PDS's
 * `com.atproto.identity.resolveHandle` endpoint. The resolved DID
 * flows into `addContact` and the screen pops back to People on save.
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
import { colors, fonts, spacing, radius } from '../src/theme';

// TEST_PDS_URL is a sensible default for the Dina test network. Users
// can paste an arbitrary PDS URL to resolve handles on other networks.
const DEFAULT_PDS_URL = 'https://test-pds.dinakernel.com';

export default function AddContactScreen() {
  const router = useRouter();
  const [didOrHandle, setDidOrHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pdsUrl, setPdsUrl] = useState(DEFAULT_PDS_URL);
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
        did = await resolveHandle(raw, pdsUrl.trim() || DEFAULT_PDS_URL);
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

    const name = displayName.trim() !== '' ? displayName.trim() : prettyNameFromDid(did, raw);

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
        <Text style={styles.heading}>Add a contact</Text>
        <Text style={styles.sub}>
          Paste a DID (did:plc:… or did:key:…) or a handle (busdriver.test-pds.dinakernel.com).
        </Text>

        <Text style={styles.label}>DID or handle</Text>
        <TextInput
          value={didOrHandle}
          onChangeText={setDidOrHandle}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder="did:plc:… or alice.test-pds.dinakernel.com"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          editable={!busy}
        />

        <Text style={styles.label}>Display name (optional)</Text>
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="e.g. Bus Driver"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          editable={!busy}
        />

        <Text style={styles.label}>PDS URL (for handle resolution)</Text>
        <TextInput
          value={pdsUrl}
          onChangeText={setPdsUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={DEFAULT_PDS_URL}
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

async function resolveHandle(handle: string, pdsUrl: string): Promise<string> {
  const base = pdsUrl.replace(/\/$/, '');
  const url = `${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json()) as { did?: string };
  if (typeof body.did !== 'string' || !body.did.startsWith('did:')) {
    throw new Error('PDS returned no DID');
  }
  return body.did;
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
  heading: {
    fontFamily: fonts.headingBold,
    fontSize: 24,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  sub: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
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
