/**
 * My Orders — the buyer's photographed-order home (§5 of the photo-commerce
 * design). Drafts with their derived states, and the one action that starts
 * the lane: photograph an order sheet.
 *
 * Capture → bounded, EXIF-stripped artifacts + a single-use egress
 * authorization (order photo_capture); extraction through the §3 gate
 * creates the draft with every machine-read value `proposed`; the buyer
 * lands exactly where the review work is: the order-draft screen.
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

import {
  activateBuyerInstall,
  buyerInstallConsentSummary,
  buyerInstallStatus,
} from '../src/services/commerce_install';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { normalizePickedPages } from '../src/services/photo_pipeline';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { OrderDraftSummary } from '@dina/core';

const STATE_LABEL: Record<OrderDraftSummary['state'], string> = {
  open: 'Needs review',
  awaiting_answers: 'Waiting on suppliers',
  closed: 'Closed',
};

export default function OrdersScreen(): React.ReactElement {
  const router = useRouter();
  const [drafts, setDrafts] = useState<OrderDraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderingEnabled, setOrderingEnabled] = useState(true);
  const [enabling, setEnabling] = useState(false);

  const reload = useCallback(async () => {
    setOrderingEnabled(buyerInstallStatus().state === 'active');
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      setLoading(false);
      return;
    }
    try {
      const answer = await client.orderDrafts();
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
      const captured = await client.orderPhotoCapture(pages);
      const extracted = await client.orderPhotoExtract({
        draftId: captured.draft_id,
        authorizationId: captured.authorization_id,
      });
      router.push({
        pathname: '/order-draft',
        params: { draft_id: extracted.draft.draftId },
      });
    } catch (err) {
      const message = (err as Error).message;
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

  const abandonDraft = useCallback(
    (draft: OrderDraftSummary) => {
      Alert.alert(
        'Abandon this order?',
        'The draft and its photographs are removed. A conversation whose order may already be on its way holds the draft until that settles.',
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Abandon',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await getOwnerCommerceClient()?.orderAbandon(draft.draft_id);
                } catch (err) {
                  Alert.alert('Held', (err as Error).message);
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

  const enableOrdering = useCallback(() => {
    const consent = buyerInstallConsentSummary();
    Alert.alert(
      `Install ${consent.name}?`,
      `This lets your Dina place orders with suppliers you choose. It may:\n\n${consent.capabilities.map((c) => `• ${c}`).join('\n')}`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Install',
          onPress: () => {
            void (async () => {
              setEnabling(true);
              const outcome = await activateBuyerInstall();
              setEnabling(false);
              if (!outcome.ok) {
                Alert.alert('Could not enable ordering', outcome.error);
              }
              void reload();
            })();
          },
        },
      ],
    );
  }, [reload]);

  return (
    <View style={styles.container} testID="orders-screen">
      <Stack.Screen options={{ title: 'My Orders' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {!orderingEnabled && (
          <Pressable
            testID="orders-enable"
            style={styles.enableCard}
            disabled={enabling}
            onPress={enableOrdering}
          >
            {enabling ? (
              <ActivityIndicator />
            ) : (
              <>
                <Text style={styles.enableTitle}>Enable ordering on this phone</Text>
                <Text style={styles.enableBody}>
                  One-time consent: install the buyer pack so approved orders can be placed under
                  your authority.
                </Text>
              </>
            )}
          </Pressable>
        )}
        <Pressable
          testID="orders-capture"
          style={[styles.captureButton, capturing && styles.captureBusy]}
          disabled={capturing}
          onPress={() => void capture()}
        >
          {capturing ? (
            <ActivityIndicator color={colors.bgPrimary} />
          ) : (
            <Text style={styles.captureLabel}>Photograph an order</Text>
          )}
        </Pressable>
        <Text style={styles.captureHint}>
          Dina reads the lines off the photo. You confirm every quantity before anything reaches a
          supplier.
        </Text>

        {loading && <ActivityIndicator style={styles.spinner} />}
        {error !== null && (
          <Text style={styles.error} testID="orders-error">
            {error}
          </Text>
        )}
        {!loading && error === null && drafts.length === 0 && (
          <Text style={styles.empty} testID="orders-empty">
            No orders yet. Photograph an order sheet to start one.
          </Text>
        )}
        {drafts.map((draft) => (
          <Pressable
            key={draft.draft_id}
            testID={`order-draft-${draft.draft_id}`}
            style={styles.draftRow}
            onPress={() =>
              router.push({ pathname: '/order-draft', params: { draft_id: draft.draft_id } })
            }
            onLongPress={() => abandonDraft(draft)}
          >
            <View style={styles.draftText}>
              <Text style={styles.draftTitle}>
                {`${String(draft.lines)} line${draft.lines === 1 ? '' : 's'}`}
                {draft.conversations > 0
                  ? ` · ${String(draft.conversations)} supplier${draft.conversations === 1 ? '' : 's'}`
                  : ''}
              </Text>
              <Text style={styles.draftMeta}>
                {new Date(draft.updated_at_ms).toLocaleDateString()} · hold to abandon
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
  enableCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  enableTitle: { ...textStyles.body, fontWeight: '600', marginBottom: spacing.xs },
  enableBody: { ...textStyles.caption, color: colors.textSecondary },
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
