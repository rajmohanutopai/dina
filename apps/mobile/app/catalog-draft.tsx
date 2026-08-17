/**
 * One catalog draft, staged by its state (§4.2 of the photo-commerce
 * design) — the two screens the lane doc requires, plus the ceremony
 * steps, in one route:
 *
 *   REPAIR   rows and findings beside the photograph; set/clear a cell,
 *            remove a row. This is where the smudged photo lands, and the
 *            seller works here until findings are gone and items exist.
 *   REVIEW   assembled items with per-field provenance. NO accept-all
 *            button — a screen rule the design states honestly: deliberation
 *            lives here, each field beside the photograph.
 *   CONFIRM/APPROVE/PUBLISH — the presence sheet (passphrase) appears when
 *            Core answers `no_user_presence`; approve names the EXACT
 *            snapshot digest the seller reviewed; publish shows what
 *            actually happened.
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

import type { CatalogDraft } from '@dina/core';

const CATALOG_ID = 'main';

const PROVENANCE_LABEL: Record<string, string> = {
  proposed: 'needs your eye',
  accepted: '✓ you confirmed',
  edited: '✎ you wrote this',
  not_model_derived: 'from your settings',
};

export default function CatalogDraftScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ draft_id?: string }>();
  const draftId = typeof params.draft_id === 'string' ? params.draft_id : '';
  const [draft, setDraft] = useState<CatalogDraft | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [cellEdit, setCellEdit] = useState<{ row: number; column: string; value: string } | null>(
    null,
  );
  const [presencePrompt, setPresencePrompt] = useState<{ retry: () => Promise<void> } | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const reload = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null || draftId === '') return;
    const answer = await client.listDrafts(CATALOG_ID);
    const found = answer.drafts.find((d) => d.draftId === draftId) ?? null;
    setDraft(found);
    // The photograph, beside the values — the screens' whole point (§6).
    if (found?.photoExtraction != null && pages.length === 0) {
      const loaded: string[] = [];
      for (const page of found.photoExtraction.manifest) {
        try {
          const bytes = await client.photoPage(page.artifact_id);
          loaded.push(`data:${bytes.mime};base64,${bytes.bytes_base64}`);
        } catch {
          loaded.push(''); // "page unavailable" renders as a gap, not a crash
        }
      }
      setPages(loaded);
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

  if (draft === null) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Catalog draft' }} />
        <ActivityIndicator style={styles.spinner} />
      </View>
    );
  }

  const client = getOwnerCommerceClient();
  const findings = draft.findings as { refusal?: string; row?: number; column?: string; detail?: string }[];
  const needsRepair = draft.items.length === 0 || findings.length > 0;

  return (
    <View style={styles.container} testID="catalog-draft-screen">
      <Stack.Screen options={{ title: needsRepair ? 'Repair' : 'Review' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* The photograph, always beside the values. */}
        {pages.map((uri, index) =>
          uri === '' ? (
            <Text key={index} style={styles.pageGone}>{`Page ${String(index + 1)} unavailable`}</Text>
          ) : (
            <Image key={index} source={{ uri }} style={styles.page} resizeMode="contain" />
          ),
        )}

        {needsRepair ? (
          <>
            <Text style={styles.sectionTitle}>Rows</Text>
            {draft.rows.map((row) => (
              <View key={row.row} style={styles.rowCard} testID={`repair-row-${String(row.row)}`}>
                <Text style={styles.rowNumber}>Row {row.row}</Text>
                {Object.entries(row.cells).map(([column, value]) => (
                  <Pressable
                    key={column}
                    testID={`repair-cell-${String(row.row)}-${column}`}
                    onPress={() => setCellEdit({ row: row.row, column, value })}
                  >
                    <Text style={styles.cell}>
                      <Text style={styles.cellName}>{column}: </Text>
                      {value}
                    </Text>
                  </Pressable>
                ))}
                <View style={styles.rowActions}>
                  <Pressable
                    testID={`repair-add-cell-${String(row.row)}`}
                    onPress={() => setCellEdit({ row: row.row, column: '', value: '' })}
                  >
                    <Text style={styles.link}>Add a value</Text>
                  </Pressable>
                  <Pressable
                    testID={`repair-remove-row-${String(row.row)}`}
                    onPress={() =>
                      void withPresence(async () => {
                        await client?.repair({ draftId, row: row.row, column: null, value: null });
                      })
                    }
                  >
                    <Text style={styles.removeLink}>Remove row</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {findings.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>What needs fixing</Text>
                {findings.map((finding, index) => (
                  <Text key={index} style={styles.finding} testID={`finding-${String(index)}`}>
                    Row {finding.row ?? '?'}
                    {finding.column !== undefined ? ` · ${finding.column}` : ''}: {finding.detail}
                  </Text>
                ))}
              </>
            )}
          </>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Products</Text>
            {draft.items.map((item, index) => {
              const provenance = draft.provenance[String(index)] ?? {};
              const record = item as unknown as Record<string, unknown>;
              return (
                <View key={index} style={styles.rowCard} testID={`review-item-${String(index)}`}>
                  <Text style={styles.rowNumber}>{String(record.name ?? record.product ?? '')}</Text>
                  {Object.entries(provenance).map(([field, state]) => (
                    <View key={field} style={styles.fieldRow}>
                      <Text style={styles.cell}>
                        <Text style={styles.cellName}>{field}: </Text>
                        {typeof record[field] === 'object'
                          ? JSON.stringify(record[field])
                          : String(record[field] ?? '')}
                      </Text>
                      <Text style={styles.provenance}>{PROVENANCE_LABEL[state] ?? state}</Text>
                      {state === 'proposed' && (
                        <Pressable
                          testID={`accept-${String(index)}-${field}`}
                          onPress={() =>
                            void withPresence(async () => {
                              await client?.accept(draftId, [`${String(index)}.${field}`]);
                            })
                          }
                        >
                          <Text style={styles.link}>Accept</Text>
                        </Pressable>
                      )}
                    </View>
                  ))}
                </View>
              );
            })}
          </>
        )}

        {/* The ceremony steps, offered only where the state machine allows. */}
        {draft.state === 'created' && !needsRepair && (
          <Pressable
            testID="draft-confirm"
            style={styles.primaryButton}
            disabled={busy}
            onPress={() => void withPresence(async () => { await client?.confirm(draftId); })}
          >
            <Text style={styles.primaryLabel}>Confirm these products</Text>
          </Pressable>
        )}
        {draft.state === 'confirmed' && (
          <Pressable
            testID="draft-prepare"
            style={styles.primaryButton}
            disabled={busy}
            onPress={() => void withPresence(async () => { await client?.prepare(draftId); })}
          >
            <Text style={styles.primaryLabel}>Build the catalog</Text>
          </Pressable>
        )}
        {draft.state === 'prepared' && draft.held !== null && (
          <>
            <Text style={styles.sectionTitle}>Ready to publish</Text>
            <Text style={styles.meta}>
              {String(draft.held.pages.length)} page(s), sequence{' '}
              {String(draft.held.snapshot.snapshot_sequence)}
            </Text>
            <Pressable
              testID="draft-approve"
              style={styles.primaryButton}
              disabled={busy}
              onPress={() =>
                void withPresence(async () => {
                  const digest = draft.held?.snapshot.snapshot_digest ?? '';
                  await client?.approve(draftId, digest);
                })
              }
            >
              <Text style={styles.primaryLabel}>Approve this exact catalog</Text>
            </Pressable>
          </>
        )}
        {draft.state === 'approved' && (
          <Pressable
            testID="draft-publish"
            style={styles.primaryButton}
            disabled={busy}
            onPress={() => void withPresence(async () => { await client?.publish(draftId); })}
          >
            <Text style={styles.primaryLabel}>Publish</Text>
          </Pressable>
        )}
        {draft.state === 'published' && draft.publication !== null && (
          <View testID="draft-published">
            <Text style={styles.sectionTitle}>Published</Text>
            <Text style={styles.meta}>
              Sequence {String(draft.publication.pointer.snapshot_sequence)} is live in your repo.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* The cell editor. */}
      <Modal visible={cellEdit !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.sectionTitle}>
              Row {cellEdit?.row}
              {cellEdit?.column !== '' ? ` · ${cellEdit?.column ?? ''}` : ''}
            </Text>
            {cellEdit?.column === '' && (
              <TextInput
                testID="repair-column-input"
                style={styles.input}
                placeholder="column (sku, name, list_price_minor_units, …)"
                autoCapitalize="none"
                onChangeText={(text) =>
                  setCellEdit((prev) => (prev === null ? null : { ...prev, column: text }))
                }
              />
            )}
            <TextInput
              testID="repair-value-input"
              style={styles.input}
              defaultValue={cellEdit?.value ?? ''}
              placeholder="value (leave empty to clear)"
              autoCapitalize="none"
              onChangeText={(text) =>
                setCellEdit((prev) => (prev === null ? null : { ...prev, value: text }))
              }
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setCellEdit(null)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="repair-save"
                onPress={() => {
                  const edit = cellEdit;
                  setCellEdit(null);
                  if (edit === null || edit.column === '') return;
                  void withPresence(async () => {
                    await client?.repair({
                      draftId,
                      row: edit.row,
                      column: edit.column,
                      value: edit.value === '' ? null : edit.value,
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

      {/* §4.3 — the presence sheet: passphrase (or the biometric-released
          passphrase upstream), five-minute window, typed once per ceremony. */}
      <Modal visible={presencePrompt !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="presence-sheet">
            <Text style={styles.sectionTitle}>Confirm it’s you</Text>
            <Text style={styles.meta}>
              This step signs your catalog, so Dina checks a person is here.
            </Text>
            <TextInput
              testID="presence-passphrase"
              style={styles.input}
              secureTextEntry
              placeholder="Your passphrase"
              value={passphrase}
              onChangeText={setPassphrase}
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
              <Pressable testID="presence-submit" onPress={() => void submitPresence()}>
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
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl },
  spinner: { marginTop: spacing.xl },
  page: {
    width: '100%',
    height: 220,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgTertiary,
  },
  pageGone: { ...textStyles.caption, color: colors.textMuted, marginBottom: spacing.sm },
  sectionTitle: {
    ...textStyles.body,
    color: colors.textPrimary,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  rowCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowNumber: { ...textStyles.caption, color: colors.textMuted, marginBottom: spacing.xs },
  cell: { ...textStyles.body, color: colors.textPrimary, paddingVertical: 2 },
  cellName: { color: colors.textSecondary },
  fieldRow: { marginBottom: spacing.xs },
  provenance: { ...textStyles.caption, color: colors.textMuted },
  rowActions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
  link: { ...textStyles.body, color: colors.core },
  removeLink: { ...textStyles.body, color: colors.error },
  finding: { ...textStyles.body, color: colors.warning, marginBottom: spacing.xs },
  meta: { ...textStyles.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  primaryLabel: { ...textStyles.button, color: colors.bgPrimary },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
    ...textStyles.body,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
});
