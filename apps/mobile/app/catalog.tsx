/**
 * My Catalog — the seller's photo-catalog home (§4 of the photo-commerce
 * design). Drafts with their states, and the one action that starts the
 * lane: photograph a price list.
 *
 * Capture → the pages become bounded, EXIF-stripped artifacts and a
 * single-use egress authorization (photo_capture); extraction runs through
 * the §3 gate (photo_extract); the created draft opens in the repair
 * screen. Nothing leaves the node until the owner's provider transmits
 * under the authorization, and the seller lands exactly where the smudged
 * photo lands: repair.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { normalizePickedPages } from '../src/services/photo_pipeline';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { CatalogDraft } from '@dina/core';

/** One catalog per supplier in the photo lane's v1 (§4.2's one-catalog rule). */
const CATALOG_ID = 'main';

const STATE_LABEL: Record<CatalogDraft['state'], string> = {
  created: 'Needs review',
  confirmed: 'Confirmed',
  prepared: 'Ready to approve',
  approved: 'Approved',
  published: 'Published',
};

export default function CatalogScreen(): React.ReactElement {
  const router = useRouter();
  const [drafts, setDrafts] = useState<CatalogDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      setLoading(false);
      return;
    }
    try {
      const answer = await client.listDrafts(CATALOG_ID);
      setDrafts(answer.drafts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const capture = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) return;
    setCapturing(true);
    try {
      const picker = await import('expo-image-picker');
      const picked = await picker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 5,
        base64: true,
        quality: 0.9,
      });
      if (picked.canceled || picked.assets.length === 0) return;
      // An iPhone camera photo is HEIC; anything not already JPEG/PNG is
      // transcoded on-device before the capture gate sniffs it.
      const pages = await normalizePickedPages(picked.assets);
      if (pages.length === 0) {
        Alert.alert('Nothing to read', 'The photos could not be loaded.');
        return;
      }
      const captured = await client.photoCapture(CATALOG_ID, pages);
      const extracted = await client.photoExtract({
        catalogId: CATALOG_ID,
        draftId: captured.draft_id,
        authorizationId: captured.authorization_id,
      });
      router.push({
        pathname: '/catalog-draft',
        params: { draft_id: extracted.draft.draftId },
      });
    } catch (err) {
      const message = (err as Error).message;
      // The two named degradations get a pointer, not a stack trace.
      if (message.includes('no_egress_broker') || message.includes('provider_failed')) {
        Alert.alert(
          'No photo reader configured',
          'Starter credits cover photo reading once claimed. Or add an OpenAI or OpenRouter key under Settings → AI Providers, then try again.',
        );
      } else {
        Alert.alert('Could not read the photo', message);
      }
    } finally {
      setCapturing(false);
      void reload();
    }
  }, [reload, router]);

  const eraseDraft = useCallback(
    (draft: CatalogDraft) => {
      Alert.alert(
        'Erase this draft?',
        'The draft, its photographs, and its unpublished product numbers are removed. Anything already published stays published.',
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Erase',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await getOwnerCommerceClient()?.erase(draft.draftId);
                } catch (err) {
                  Alert.alert('Could not erase', (err as Error).message);
                }
                void reload();
              })();
            },
          },
        ],
      );
    },
    [reload],
  );

  return (
    <View style={styles.container} testID="catalog-screen">
      <Stack.Screen options={{ title: 'My Catalog' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Pressable
          testID="catalog-capture"
          style={[styles.captureButton, capturing && styles.captureBusy]}
          disabled={capturing}
          onPress={() => void capture()}
        >
          {capturing ? (
            <ActivityIndicator color={colors.bgPrimary} />
          ) : (
            <Text style={styles.captureLabel}>Photograph a price list</Text>
          )}
        </Pressable>
        <Text style={styles.captureHint}>
          Dina reads the rows off the photo. You review every value before anything is published.
        </Text>

        {loading && <ActivityIndicator style={styles.spinner} />}
        {error !== null && (
          <Text style={styles.error} testID="catalog-error">
            {error}
          </Text>
        )}
        {!loading && error === null && drafts.length === 0 && (
          <Text style={styles.empty} testID="catalog-empty">
            No drafts yet. Photograph a price list to start your catalog.
          </Text>
        )}
        {drafts.map((draft) => (
          <Pressable
            key={draft.draftId}
            testID={`catalog-draft-${draft.draftId}`}
            style={styles.draftRow}
            onPress={() =>
              router.push({ pathname: '/catalog-draft', params: { draft_id: draft.draftId } })
            }
            onLongPress={() => eraseDraft(draft)}
          >
            <View style={styles.draftText}>
              <Text style={styles.draftTitle}>
                {draft.items.length > 0
                  ? `${String(draft.items.length)} product${draft.items.length === 1 ? '' : 's'}`
                  : `${String(draft.rows.length)} row${draft.rows.length === 1 ? '' : 's'} to repair`}
              </Text>
              <Text style={styles.draftMeta}>
                {new Date(draft.updatedAtMs).toLocaleDateString()} · hold to erase
              </Text>
            </View>
            <Text style={styles.stateChip}>{STATE_LABEL[draft.state]}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  captureButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  captureBusy: { opacity: 0.7 },
  captureLabel: { ...textStyles.button, color: colors.bgPrimary },
  captureHint: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  spinner: { marginTop: spacing.xl },
  error: { ...textStyles.body, color: colors.error, marginTop: spacing.lg },
  empty: { ...textStyles.body, color: colors.textSecondary, marginTop: spacing.xl },
  draftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  draftText: { flex: 1 },
  draftTitle: { ...textStyles.body, color: colors.textPrimary },
  draftMeta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  stateChip: { ...textStyles.caption, color: colors.accent },
});
