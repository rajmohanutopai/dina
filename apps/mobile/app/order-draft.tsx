/**
 * One photographed order, staged by its §5.1 state — the buyer's review
 * screen, the photograph always beside the values:
 *
 *   REVIEW    every machine-read field arrives `proposed` and is decided
 *             HERE, per field, beside the photograph — no accept-all
 *             button, the same screen rule as the seller lane. Repair
 *             writes `edited`; resolve names the supplier's product.
 *   CONFIRM   the §5.3 ceremony (presence, unconditional): the batch
 *             receipt commits the extraction digest before anything can
 *             leave the building.
 *   ASK/APPROVE/SEND — per supplier conversation: the send gate, the
 *             §5.5 divergence badges ON the approval card, and the
 *             submission protocol's classified outcome, rendered honestly.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { OwnerCommerceHttpError } from '@dina/core';

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { OrderConversation, OrderDraft } from '@dina/core';

const PROVENANCE_LABEL: Record<string, string> = {
  proposed: 'needs your eye',
  accepted: '✓ you confirmed',
  edited: '✎ you wrote this',
};

const CONVERSATION_LABEL: Record<OrderConversation['state'], string> = {
  draft: 'Draft',
  sent: 'Asked — waiting',
  quoted: 'Quote in',
  approved: 'Approved',
  submitting: 'Sending…',
  submitted_unconfirmed: 'Sent — awaiting confirmation',
  submitted: 'Ordered',
  timed_out: 'No answer',
  rejected: 'Declined',
  superseded: 'Superseded',
  quote_expired: 'Quote lapsed',
  dispatch_refused: 'Could not send',
  closed: 'Closed',
};

const DISPATCH_MESSAGE: Record<string, string> = {
  confirmed: 'Order placed.',
  uncertain: 'Sent. Waiting for the supplier to confirm.',
  transient: 'Could not reach the courier just now. Dina keeps trying.',
  refused: 'Could not send — the terms are no longer current. Ask again.',
};

export default function OrderDraftScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ draft_id?: string }>();
  const draftId = typeof params.draft_id === 'string' ? params.draft_id : '';
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldEdit, setFieldEdit] = useState<{ lineId: string; field: string; value: string } | null>(null);
  const [resolveEdit, setResolveEdit] = useState<{ lineId: string; supplier: string; sku: string } | null>(null);
  const [requirementEdit, setRequirementEdit] = useState<{ key: string; value: string } | null>(null);
  const [askEdit, setAskEdit] = useState<{ supplier: string; postal: string } | null>(null);
  const [presencePrompt, setPresencePrompt] = useState<{ retry: () => Promise<void> } | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const reload = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null || draftId === '') return;
    try {
      const answer = await client.orderDraft(draftId);
      setDraft(answer.draft);
      if (pages.length === 0) {
        const loaded: string[] = [];
        for (const page of answer.draft.manifest) {
          try {
            const bytes = await client.photoPage(page.artifact_id);
            loaded.push(`data:${bytes.mime};base64,${bytes.bytes_base64}`);
          } catch {
            loaded.push('');
          }
        }
        setPages(loaded);
      }
    } catch {
      setDraft(null);
    }
  }, [draftId, pages.length]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Run an operation; on `no_user_presence` raise the passphrase sheet. */
  const withPresence = useCallback(
    async (operation: () => Promise<void>) => {
      setBusy(true);
      try {
        await operation();
      } catch (err) {
        if (err instanceof OwnerCommerceHttpError && err.errorKey === 'no_user_presence') {
          setPresencePrompt({ retry: operation });
        } else if (
          err instanceof OwnerCommerceHttpError &&
          err.errorKey === 'presence_unavailable'
        ) {
          Alert.alert(
            'Set a passphrase first',
            'Vouching a photographed order needs a presence proof; this device has none configured.',
          );
        } else {
          Alert.alert('Refused', (err as Error).message);
        }
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [reload],
  );

  const submitPresence = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null || presencePrompt === null) return;
    const retry = presencePrompt.retry;
    setBusy(true);
    try {
      await client.provePresence(passphrase);
      setPresencePrompt(null);
      setPassphrase('');
      await retry();
    } catch {
      Alert.alert('Not verified', 'That passphrase did not verify. Try again.');
    } finally {
      setBusy(false);
      void reload();
    }
  }, [passphrase, presencePrompt, reload]);

  const approveConversation = useCallback(
    async (conversation: OrderConversation) => {
      const client = getOwnerCommerceClient();
      if (client === null || draft === null) return;
      await withPresence(async () => {
        const answer = await client.orderApprove({
          draftId: draft.draftId,
          conversationId: conversation.conversationId,
          quoteId: '',
          projection: { region: { scheme: 'postal_area', value: askEdit?.postal ?? '000000' } },
        });
        // §5.5 — the divergence column, exactly where the decision is.
        const badges = answer.divergence
          .map((entry) => {
            const verdict = entry.verdict as {
              kind: string;
              ratioPct?: number;
              flagged?: boolean;
              direction?: string;
            };
            if (verdict.kind === 'no_reference_price') return `${entry.line_id}: no reference price`;
            if (verdict.kind === 'no_comparable_basis') return `${entry.line_id}: no comparable basis`;
            return `${entry.line_id}: ${String(verdict.ratioPct)}% of reference${verdict.flagged === true ? ` — ${verdict.direction ?? ''} your band` : ''}`;
          })
          .join('\n');
        Alert.alert('Approved', `The order is ready to send.\n\n${badges}`);
      });
    },
    [askEdit?.postal, draft, withPresence],
  );

  const submitConversation = useCallback(
    async (conversation: OrderConversation) => {
      const client = getOwnerCommerceClient();
      if (client === null || draft === null) return;
      setBusy(true);
      try {
        const answer = await client.orderSubmit({
          draftId: draft.draftId,
          conversationId: conversation.conversationId,
        });
        Alert.alert(
          'Send order',
          DISPATCH_MESSAGE[answer.dispatch_class] ?? answer.dispatch_class,
        );
      } catch (err) {
        Alert.alert('Refused', (err as Error).message);
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [draft, reload],
  );

  // Reached with no draft_id (a stray deep link, or the tab-leak build) the
  // screen used to show the loading spinner for ever, because reload() has
  // nothing to load. Say so instead.
  if (draftId === '') {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Order' }} />
        <Text style={styles.emptyState} testID="order-draft-empty">
          No order selected. Photograph an order from My Orders to start one.
        </Text>
      </View>
    );
  }

  if (draft === null) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Order' }} />
        <ActivityIndicator style={styles.spinner} />
      </View>
    );
  }

  const client = getOwnerCommerceClient();
  const unvouched = draft.lines.some((line) => line.vouch === null && line.submittedIn === null);
  const resolvedSupplier =
    draft.lines
      .map((line) => (line.resolution.kind === 'resolved' ? line.resolution.supplierDid : null))
      .find((did) => did !== null) ?? '';

  return (
    <View style={styles.container} testID="order-draft-screen">
      <Stack.Screen options={{ title: unvouched ? 'Review order' : 'Order' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {pages.map((uri, index) =>
          uri === '' ? (
            <Text key={index} style={styles.pageGone}>{`Page ${String(index + 1)} unavailable`}</Text>
          ) : (
            <Image key={index} source={{ uri }} style={styles.page} resizeMode="contain" />
          ),
        )}

        <Text style={styles.sectionTitle}>Lines</Text>
        {draft.lines.map((line) => (
          <View key={line.lineId} style={styles.card} testID={`order-line-${line.lineId}`}>
            <Text style={styles.lineText}>{line.text}</Text>
            {Object.entries(line.fields).map(([field, value]) => (
              <View key={field} style={styles.fieldRow}>
                <Pressable
                  style={styles.fieldTap}
                  testID={`order-field-${line.lineId}-${field}`}
                  onPress={() => setFieldEdit({ lineId: line.lineId, field, value })}
                >
                  <Text style={styles.cell}>
                    <Text style={styles.cellName}>{field}: </Text>
                    {value}
                  </Text>
                  <Text style={styles.provenance}>
                    {PROVENANCE_LABEL[line.provenance[field] ?? ''] ?? line.provenance[field]}
                  </Text>
                </Pressable>
                {line.provenance[field] === 'proposed' && (
                  <Pressable
                    testID={`order-accept-${line.lineId}-${field}`}
                    onPress={() =>
                      void withPresence(async () => {
                        await client?.orderAcceptFields(draft.draftId, [
                          { lineId: line.lineId, field },
                        ]);
                      })
                    }
                  >
                    <Text style={styles.link}>Confirm</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {line.resolution.kind === 'resolved' ? (
              <Text style={styles.resolved}>
                {`→ ${line.resolution.product.value} from ${line.resolution.supplierDid.slice(0, 24)}…`}
                {line.resolution.flaggedNewSupplier ? '  ⚠ new supplier' : ''}
              </Text>
            ) : (
              <Pressable
                testID={`order-resolve-${line.lineId}`}
                onPress={() =>
                  setResolveEdit({ lineId: line.lineId, supplier: resolvedSupplier, sku: '' })
                }
              >
                <Text style={styles.link}>Choose the product…</Text>
              </Pressable>
            )}
          </View>
        ))}

        {draft.requirements.length > 0 && <Text style={styles.sectionTitle}>For the order</Text>}
        {draft.requirements.map((requirement) => (
          <View key={requirement.key} style={styles.card} testID={`order-req-${requirement.key}`}>
            <View style={styles.fieldRow}>
              <Pressable
                style={styles.fieldTap}
                onPress={() =>
                  setRequirementEdit({ key: requirement.key, value: requirement.value ?? '' })
                }
              >
                <Text style={styles.cell}>
                  <Text style={styles.cellName}>{requirement.key}: </Text>
                  {requirement.omitted ? '(left out)' : requirement.value}
                </Text>
                <Text style={styles.provenance}>
                  {PROVENANCE_LABEL[requirement.provenance] ?? requirement.provenance}
                </Text>
              </Pressable>
              {requirement.provenance === 'proposed' && (
                <Pressable
                  testID={`order-req-accept-${requirement.key}`}
                  onPress={() =>
                    void withPresence(async () => {
                      await client?.orderRequirement({
                        draftId: draft.draftId,
                        key: requirement.key,
                        action: 'accept',
                      });
                    })
                  }
                >
                  <Text style={styles.link}>Confirm</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}

        {unvouched ? (
          <Pressable
            testID="order-confirm"
            style={[styles.primaryButton, busy && styles.busy]}
            disabled={busy}
            onPress={() =>
              void withPresence(async () => {
                await client?.orderConfirm(draft.draftId);
              })
            }
          >
            <Text style={styles.primaryLabel}>Confirm what leaves the building</Text>
          </Pressable>
        ) : (
          <Pressable
            testID="order-ask"
            style={[styles.primaryButton, busy && styles.busy]}
            disabled={busy}
            onPress={() => setAskEdit({ supplier: resolvedSupplier, postal: '' })}
          >
            <Text style={styles.primaryLabel}>Ask for a quote</Text>
          </Pressable>
        )}

        {draft.conversations.length > 0 && <Text style={styles.sectionTitle}>Suppliers</Text>}
        {draft.conversations.map((conversation) => (
          <View
            key={conversation.conversationId}
            style={styles.card}
            testID={`order-conversation-${conversation.conversationId}`}
          >
            <Text style={styles.cell}>{conversation.supplierDid.slice(0, 28)}…</Text>
            <Text style={styles.provenance}>{CONVERSATION_LABEL[conversation.state]}</Text>
            {conversation.state === 'quoted' && (
              <Pressable
                testID={`order-approve-${conversation.conversationId}`}
                onPress={() => void approveConversation(conversation)}
              >
                <Text style={styles.link}>Review and approve</Text>
              </Pressable>
            )}
            {conversation.state === 'approved' && (
              <Pressable
                testID={`order-send-${conversation.conversationId}`}
                onPress={() => void submitConversation(conversation)}
              >
                <Text style={styles.link}>Send the order</Text>
              </Pressable>
            )}
            {['timed_out', 'rejected', 'quote_expired', 'dispatch_refused'].includes(
              conversation.state,
            ) && (
              <Pressable
                testID={`order-reopen-${conversation.conversationId}`}
                onPress={() =>
                  void withPresence(async () => {
                    await client?.orderReopen(draft.draftId, conversation.conversationId);
                  })
                }
              >
                <Text style={styles.link}>Reopen these lines</Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>

      {/* Field repair */}
      <Modal visible={fieldEdit !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{fieldEdit?.field}</Text>
            <TextInput
              testID="order-field-input"
              style={styles.input}
              value={fieldEdit?.value ?? ''}
              onChangeText={(value) =>
                setFieldEdit((edit) => (edit === null ? null : { ...edit, value }))
              }
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setFieldEdit(null)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="order-field-save"
                onPress={() => {
                  const edit = fieldEdit;
                  setFieldEdit(null);
                  if (edit === null) return;
                  void withPresence(async () => {
                    await client?.orderRepairLine({
                      draftId: draft.draftId,
                      lineId: edit.lineId,
                      field: edit.field,
                      value: edit.value,
                    });
                  });
                }}
              >
                <Text style={styles.link}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Resolve a line to a supplier product */}
      <Modal visible={resolveEdit !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Which product is this?</Text>
            <TextInput
              testID="order-resolve-supplier"
              style={styles.input}
              placeholder="Supplier DID (did:plc:…)"
              value={resolveEdit?.supplier ?? ''}
              onChangeText={(supplier) =>
                setResolveEdit((edit) => (edit === null ? null : { ...edit, supplier }))
              }
              autoCapitalize="none"
            />
            <TextInput
              testID="order-resolve-sku"
              style={styles.input}
              placeholder="Product number (SKU)"
              value={resolveEdit?.sku ?? ''}
              onChangeText={(sku) =>
                setResolveEdit((edit) => (edit === null ? null : { ...edit, sku }))
              }
              autoCapitalize="characters"
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setResolveEdit(null)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="order-resolve-save"
                onPress={() => {
                  const edit = resolveEdit;
                  setResolveEdit(null);
                  if (edit === null || edit.supplier === '' || edit.sku === '') return;
                  void withPresence(async () => {
                    await client?.orderResolveLine({
                      draftId: draft.draftId,
                      lineId: edit.lineId,
                      resolution: {
                        kind: 'resolved',
                        product: {
                          scheme: 'manufacturer_sku',
                          value: edit.sku,
                          issuer_did: edit.supplier,
                        },
                        supplierDid: edit.supplier,
                        flaggedNewSupplier: false,
                      },
                    });
                  });
                }}
              >
                <Text style={styles.link}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Requirement edit */}
      <Modal visible={requirementEdit !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{requirementEdit?.key}</Text>
            <TextInput
              testID="order-req-input"
              style={styles.input}
              value={requirementEdit?.value ?? ''}
              onChangeText={(value) =>
                setRequirementEdit((edit) => (edit === null ? null : { ...edit, value }))
              }
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRequirementEdit(null)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="order-req-save"
                onPress={() => {
                  const edit = requirementEdit;
                  setRequirementEdit(null);
                  if (edit === null) return;
                  void withPresence(async () => {
                    await client?.orderRequirement({
                      draftId: draft.draftId,
                      key: edit.key,
                      action: 'edit',
                      value: edit.value,
                    });
                  });
                }}
              >
                <Text style={styles.link}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Ask for a quote */}
      <Modal visible={askEdit !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Ask a supplier</Text>
            <TextInput
              testID="order-ask-supplier"
              style={styles.input}
              placeholder="Supplier DID (did:plc:…)"
              value={askEdit?.supplier ?? ''}
              onChangeText={(supplier) =>
                setAskEdit((edit) => (edit === null ? null : { ...edit, supplier }))
              }
              autoCapitalize="none"
            />
            <TextInput
              testID="order-ask-postal"
              style={styles.input}
              placeholder="Delivery postal code"
              value={askEdit?.postal ?? ''}
              onChangeText={(postal) =>
                setAskEdit((edit) => (edit === null ? null : { ...edit, postal }))
              }
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setAskEdit(null)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="order-ask-send"
                onPress={() => {
                  const edit = askEdit;
                  setAskEdit((current) => (current === null ? null : current));
                  if (edit === null || edit.supplier === '' || edit.postal === '') return;
                  setAskEdit(null);
                  void withPresence(async () => {
                    await client?.orderRequestQuote({
                      draftId: draft.draftId,
                      supplierDid: edit.supplier,
                      projection: { region: { scheme: 'postal_area', value: edit.postal } },
                    });
                    Alert.alert('Asked', 'Dina will show the quote here when it arrives.');
                  });
                }}
              >
                <Text style={styles.link}>Ask</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Presence sheet */}
      <Modal visible={presencePrompt !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Prove it is you</Text>
            <Text style={styles.modalHint}>
              Vouching a photographed order needs a person present.
            </Text>
            <TextInput
              testID="order-presence-input"
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => {
                  setPresencePrompt(null);
                  setPassphrase('');
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable testID="order-presence-submit" onPress={() => void submitPresence()}>
                <Text style={styles.link}>Verify</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  spinner: { marginTop: spacing.xl },
  emptyState: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    textAlign: 'center',
  },
  page: { width: '100%', height: 220, borderRadius: radius.md, marginBottom: spacing.md },
  pageGone: { ...textStyles.caption, color: colors.textSecondary, marginBottom: spacing.md },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  lineText: { ...textStyles.body, color: colors.textPrimary, marginBottom: spacing.xs },
  fieldRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs },
  fieldTap: { flex: 1 },
  cell: { ...textStyles.body, color: colors.textPrimary },
  cellName: { color: colors.textSecondary },
  provenance: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  resolved: { ...textStyles.caption, color: colors.accent, marginTop: spacing.xs },
  link: { ...textStyles.body, color: colors.accent, paddingHorizontal: spacing.sm },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  busy: { opacity: 0.7 },
  primaryLabel: { ...textStyles.button, color: colors.bgPrimary },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg },
  modalTitle: { ...textStyles.h3, color: colors.textPrimary, marginBottom: spacing.sm },
  modalHint: { ...textStyles.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  input: {
    ...textStyles.body,
    color: colors.textPrimary,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
});
