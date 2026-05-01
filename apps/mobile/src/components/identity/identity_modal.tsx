/**
 * IdentityModal — full identity card revealed when the user taps a
 * peer's short username anywhere in the app.
 *
 * Why a modal instead of a screen: the row that triggers it lives
 * inside a list (subject detail, network feed, search). Pushing a
 * full screen would dump the user out of their browse context for
 * what is essentially a "show me the receipts" tap. The modal slides
 * up, lets them scan the full handle / DID / PLC services, copy
 * anything, and dismiss back to where they were.
 *
 * What it shows:
 *   • Full handle (`alice.pds.dinakernel.com`) — copyable
 *   • Full DID (`did:plc:abc…`) — copyable
 *   • alsoKnownAs[] entries (rare to have more than one, but worth
 *     surfacing when present so the user can see prior handles)
 *   • Verification methods — one row per signing key, with multibase
 *     pubkey copyable for power users
 *   • Service endpoints — MsgBox / direct HTTPS routes published by
 *     the home node
 *
 * Loading model: PLC is fetched lazily on first open (with cache in
 * `services/plc_lookup`). If the caller already has a known handle
 * (from the wire), we render that immediately so the modal isn't
 * empty during the round-trip.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, spacing } from '../../theme';
import { lookupPlc, type PlcLookupResult } from '../../services/plc_lookup';

export interface IdentityModalProps {
  visible: boolean;
  onClose: () => void;
  /** The peer's DID. Required — the modal queries plc.directory for this. */
  did: string;
  /**
   * Optional pre-resolved handle (e.g. from a list-row wire field).
   * Shown immediately as the title while the PLC fetch is in flight,
   * then replaced with the canonical PLC value once it lands.
   */
  initialHandle?: string | null;
  /**
   * Test seam: lets specs inject a synchronous result and skip the
   * fetch path entirely. Production callers leave this undefined.
   */
  fetchPlc?: (did: string) => Promise<PlcLookupResult>;
}

export function IdentityModal(props: IdentityModalProps): React.ReactElement {
  const { visible, onClose, did, initialHandle, fetchPlc } = props;
  const [doc, setDoc] = useState<PlcLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (did === '') {
      setError('No DID to look up');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher = fetchPlc ?? ((d: string) => lookupPlc(d));
    void fetcher(did)
      .then((result) => {
        if (!cancelled) setDoc(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, did, fetchPlc]);

  // Reset state when the modal closes so a re-open for a different
  // DID doesn't flash the previous peer's data.
  useEffect(() => {
    if (visible) return;
    setDoc(null);
    setError(null);
    setLoading(false);
  }, [visible]);

  const headerHandle = doc?.handle ?? initialHandle ?? null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        testID="identity-modal-backdrop"
      >
        {/* Inner pressable swallows backdrop taps so a tap inside the
            sheet doesn't dismiss it. */}
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.handleBar} />

          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={styles.handle} numberOfLines={1} testID="identity-modal-handle">
                {headerHandle ?? 'Identity'}
              </Text>
              <Text style={styles.didCaption} numberOfLines={1} ellipsizeMode="middle">
                {did}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityLabel="Close"
              accessibilityRole="button"
              hitSlop={12}
              style={styles.closeBtn}
              testID="identity-modal-close"
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {loading && doc === null && error === null ? (
              <View style={styles.center} testID="identity-modal-loading">
                <ActivityIndicator color={colors.textMuted} />
                <Text style={styles.loadingText}>Loading from plc.directory…</Text>
              </View>
            ) : null}

            {error !== null ? (
              <View style={styles.errorPanel} testID="identity-modal-error">
                <Ionicons name="alert-circle-outline" size={28} color={colors.error} />
                <Text style={styles.errorTitle}>Couldn’t load identity</Text>
                <Text style={styles.errorBody}>{error}</Text>
              </View>
            ) : null}

            {doc !== null ? (
              <>
                <FieldGroup title="Handle">
                  <CopyableRow
                    label="Canonical"
                    value={doc.handle ?? '—'}
                    copyable={doc.handle !== null}
                    testIDPrefix="identity-modal-handle-row"
                  />
                  {doc.alsoKnownAs.length > 1
                    ? doc.alsoKnownAs.slice(1).map((aka, i) => (
                        <CopyableRow
                          key={aka}
                          label={`Also known as ${i + 2}`}
                          value={aka.startsWith('at://') ? aka.slice('at://'.length) : aka}
                          copyable
                        />
                      ))
                    : null}
                </FieldGroup>

                <FieldGroup title="DID">
                  <CopyableRow
                    label="Identifier"
                    value={doc.did}
                    copyable
                    mono
                    testIDPrefix="identity-modal-did-row"
                  />
                  {doc.created !== null ? (
                    <CopyableRow label="Registered" value={doc.created} copyable={false} />
                  ) : null}
                </FieldGroup>

                {doc.verificationMethods.length > 0 ? (
                  <FieldGroup title="Signing keys">
                    {doc.verificationMethods.map((vm) => (
                      <CopyableRow
                        key={vm.id}
                        label={vmLabel(vm.id)}
                        value={vm.publicKeyMultibase ?? vm.id}
                        copyable={vm.publicKeyMultibase !== undefined}
                        mono
                      />
                    ))}
                  </FieldGroup>
                ) : null}

                {doc.services.length > 0 ? (
                  <FieldGroup title="Services">
                    {doc.services.map((s) => (
                      <CopyableRow
                        key={s.id}
                        label={`${s.type} ${s.id}`.trim()}
                        value={s.serviceEndpoint}
                        copyable={s.serviceEndpoint !== ''}
                      />
                    ))}
                  </FieldGroup>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function vmLabel(id: string): string {
  // `did:plc:xxxx#dina_signing` → `dina_signing`.
  const hash = id.indexOf('#');
  return hash >= 0 ? id.slice(hash + 1) : id;
}

function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title.toUpperCase()}</Text>
      <View style={styles.groupCard}>{children}</View>
    </View>
  );
}

function CopyableRow(props: {
  label: string;
  value: string;
  copyable: boolean;
  mono?: boolean;
  testIDPrefix?: string;
}): React.ReactElement {
  const onCopy = (): void => {
    void Share.share({ message: props.value });
  };
  return (
    <View style={styles.fieldRow} testID={props.testIDPrefix}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <View style={styles.fieldValueWrap}>
        <Text
          style={[styles.fieldValue, props.mono === true && styles.fieldValueMono]}
          numberOfLines={2}
          ellipsizeMode="middle"
          selectable
        >
          {props.value}
        </Text>
        {props.copyable ? (
          <Pressable
            onPress={onCopy}
            accessibilityRole="button"
            accessibilityLabel={`Copy ${props.label}`}
            hitSlop={10}
            style={styles.copyBtn}
            testID={
              props.testIDPrefix !== undefined ? `${props.testIDPrefix}-copy` : undefined
            }
          >
            <Ionicons name="copy-outline" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bgPrimary,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: '85%',
  },
  handleBar: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  headerText: { flex: 1 },
  handle: {
    fontFamily: fonts.headingBold,
    fontSize: 20,
    color: colors.textPrimary,
  },
  didCaption: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
  },
  closeBtn: {
    padding: 2,
  },
  body: {
    flexShrink: 1,
  },
  bodyContent: {
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  center: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  loadingText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  errorPanel: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.xs,
  },
  errorTitle: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  errorBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  group: {
    gap: spacing.xs,
  },
  groupTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
    paddingLeft: 4,
  },
  groupCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  fieldRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
    gap: 4,
  },
  fieldLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  fieldValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  fieldValue: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  },
  fieldValueMono: {
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  copyBtn: {
    padding: 2,
  },
});
