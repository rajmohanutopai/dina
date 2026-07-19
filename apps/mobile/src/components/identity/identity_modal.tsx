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

import { Ionicons } from '@expo/vector-icons';
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

import { buildContactCard } from '../../services/contact_card';
import { lookupPlc, type PlcLookupResult } from '../../services/plc_lookup';
import { colors, radius, spacing, textStyles } from '../../theme';

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
  /**
   * Whose identity this is. `self` switches the section titles to the
   * first person ("Your handle", "Your Dina ID") and the helper copy.
   * Defaults to `peer` (inspecting a contact).
   */
  variant?: 'self' | 'peer';
  /**
   * Friendly name (self only). When set it becomes the sheet title and is
   * included in the shareable contact card. Falls back to the handle.
   */
  selfName?: string | null;
  /**
   * Reveal the technical sections (signing keys, network services,
   * registration date, other names). Default false — those are
   * infrastructure, not something a normal user wants on the People
   * page. The Settings → Infrastructure screen opens the modal with
   * this on.
   */
  showAdvanced?: boolean;
  /**
   * Optional callback for the "Signing keys & network services →" link
   * shown in the friendly (non-advanced) view. People wires this to
   * navigate to Settings → Infrastructure. Omit to hide the link.
   */
  onShowAdvanced?: () => void;
}

/** did:plc:xxx#dina_signing → "Dina signing key" (human, not the raw frag). */
function keyLabel(id: string): string {
  const frag = id.includes('#') ? id.slice(id.indexOf('#') + 1) : id;
  const f = frag.toLowerCase();
  if (f.includes('dina')) return 'Dina signing key';
  if (f.includes('atproto')) return 'Account signing key';
  return frag;
}

/** Map a PLC service entry to a plain-language name. */
function serviceLabel(s: { type: string; id: string }): string {
  const t = `${s.type} ${s.id}`.toLowerCase();
  if (t.includes('msgbox') || t.includes('messaging')) return 'Messaging server';
  if (t.includes('personaldataserver') || t.includes('atproto_pds') || t.includes('pds')) {
    return 'Personal data server';
  }
  return s.type || s.id;
}

export function IdentityModal(props: IdentityModalProps): React.ReactElement {
  const { visible, onClose, did, initialHandle, fetchPlc } = props;
  const isSelf = props.variant === 'self';
  const showAdvanced = props.showAdvanced === true;
  const selfName = props.selfName != null && props.selfName.trim() !== '' ? props.selfName.trim() : null;
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
  // For self, lead with the friendly name; the handle moves to the subtitle.
  const title = (isSelf ? selfName : null) ?? headerHandle ?? 'Identity';
  const subtitle = isSelf && selfName !== null ? (headerHandle ?? did) : did;

  const onShareCard = (): void => {
    void Share.share({
      message: buildContactCard({ name: selfName, handle: headerHandle, did }),
    });
  };

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
                {title}
              </Text>
              <Text style={styles.didCaption} numberOfLines={1} ellipsizeMode="middle">
                {subtitle}
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
                {/* Share the whole identity as one contact card (name +
                    handle + DID) — paste-able into someone else's Add
                    Contact. Self only. */}
                {isSelf ? (
                  <Pressable
                    testID="identity-modal-share-card"
                    onPress={onShareCard}
                    accessibilityRole="button"
                    accessibilityLabel="Share your contact card"
                    style={({ pressed }) => [styles.shareCardBtn, pressed && { opacity: 0.7 }]}
                  >
                    <Ionicons name="share-outline" size={18} color={colors.white} />
                    <Text style={styles.shareCardText}>Share contact card</Text>
                  </Pressable>
                ) : null}

                {/* ── Essentials: the only things a normal user needs ── */}
                <FieldGroup title={isSelf ? 'Your handle' : 'Handle'}>
                  <CopyableRow
                    value={doc.handle ?? '—'}
                    copyable={doc.handle !== null}
                    testIDPrefix="identity-modal-handle-row"
                  />
                  <Text style={styles.fieldHelp}>
                    {isSelf
                      ? 'People add you using this handle.'
                      : 'Their handle on the network.'}
                  </Text>
                </FieldGroup>

                <FieldGroup title={isSelf ? 'Your Dina ID' : 'Dina ID'}>
                  <CopyableRow
                    value={doc.did}
                    copyable
                    mono
                    testIDPrefix="identity-modal-did-row"
                  />
                  <Text style={styles.fieldHelp}>
                    {isSelf ? 'Your permanent ID. Safe to share.' : 'Their permanent ID.'}
                  </Text>
                </FieldGroup>

                {/* ── Technical: infrastructure, hidden unless asked for ── */}
                {showAdvanced ? (
                  <>
                    {doc.alsoKnownAs.length > 1 ? (
                      <FieldGroup title="Other names">
                        {doc.alsoKnownAs.slice(1).map((aka, i) => (
                          <CopyableRow
                            key={aka}
                            label={`Also known as ${i + 2}`}
                            value={aka.startsWith('at://') ? aka.slice('at://'.length) : aka}
                            copyable
                          />
                        ))}
                      </FieldGroup>
                    ) : null}

                    {doc.created !== null ? (
                      <FieldGroup title="Registered">
                        <CopyableRow value={doc.created} copyable={false} />
                      </FieldGroup>
                    ) : null}

                    {doc.verificationMethods.length > 0 ? (
                      <FieldGroup title="Signing keys">
                        {doc.verificationMethods.map((vm) => (
                          <CopyableRow
                            key={vm.id}
                            label={keyLabel(vm.id)}
                            value={vm.publicKeyMultibase ?? vm.id}
                            copyable={vm.publicKeyMultibase !== undefined}
                            mono
                          />
                        ))}
                      </FieldGroup>
                    ) : null}

                    {doc.services.length > 0 ? (
                      <FieldGroup title="Network services">
                        {doc.services.map((s) => (
                          <CopyableRow
                            key={s.id}
                            label={serviceLabel(s)}
                            value={s.serviceEndpoint}
                            copyable={s.serviceEndpoint !== ''}
                          />
                        ))}
                      </FieldGroup>
                    ) : null}
                  </>
                ) : props.onShowAdvanced !== undefined ? (
                  <Pressable
                    testID="identity-modal-advanced-link"
                    onPress={props.onShowAdvanced}
                    accessibilityRole="button"
                    accessibilityLabel="View signing keys and network services"
                    style={({ pressed }) => [styles.advancedLink, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={styles.advancedLinkText}>
                      Signing keys &amp; network services
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
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
  /** Optional sub-label. Omit for single-value sections where the group
   * title already says what the value is (avoids "Your handle → Canonical"
   * jargon stacking). */
  label?: string;
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
      {props.label !== undefined ? (
        <Text style={styles.fieldLabel}>{props.label}</Text>
      ) : null}
      <View style={styles.fieldValueWrap}>
        <Text
          // testID on the value Text (not just the row View) — a bare
          // container View doesn't reliably surface in the iOS
          // accessibility tree, so E2E can't see the row by its prefix.
          // The Text node does, and this also lets tests read the value.
          testID={
            props.testIDPrefix !== undefined ? `${props.testIDPrefix}-value` : undefined
          }
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
            accessibilityLabel={`Copy ${props.label ?? 'value'}`}
            hitSlop={10}
            style={styles.copyBtn}
            testID={
              props.testIDPrefix !== undefined
                ? `${props.testIDPrefix}-copy`
                : `identity-modal-copy-${(props.label ?? 'value')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '')}`
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
  handle: textStyles.h3,
  didCaption: {
    ...textStyles.monoSmall,
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
  loadingText: textStyles.bodySmall,
  errorPanel: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.xs,
  },
  errorTitle: {
    ...textStyles.bodyStrong,
    marginTop: spacing.xs,
  },
  errorBody: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  group: {
    gap: spacing.xs,
  },
  groupTitle: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
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
    ...textStyles.eyebrow,
    letterSpacing: 0.5,
  },
  fieldValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  fieldValue: {
    ...textStyles.bodySmall,
    flex: 1,
    color: colors.textPrimary,
  },
  fieldValueMono: textStyles.monoSmall,
  fieldHelp: {
    ...textStyles.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  shareCardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  shareCardText: {
    ...textStyles.button,
    color: colors.white,
  },
  advancedLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  advancedLinkText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  copyBtn: {
    padding: 2,
  },
});
