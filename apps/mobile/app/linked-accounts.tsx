/**
 * Linked accounts (UCP plan §3.17): the owner's accounts at merchants that
 * Dina may use, with what each lets Dina do. Linking opens the shop's own
 * sign-in page; the shop sends the owner back to this app. Unlinking stops
 * Dina using the account at once, and Dina then asks the shop to cancel its
 * keys; where the shop never confirms that, the screen says so, and the owner
 * removes Dina there. Shops that asked for a linked account on some call are
 * offered here, and attempts that ended without a link say why. Dina asks
 * only for what it uses: reading orders and preparing checkouts, never
 * cancelling or returning anything.
 */

import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { linkScopeWords, type UcpLinksOwnerView } from '@dina/core';

import { ownerErrorText } from '../src/services/owner_errors';
import { getOwnerUcpClient } from '../src/services/owner_ucp_client';
import { attemptText, linkStateText, startRefusalText } from '../src/services/ucp_link_words';
import { colors, radius, spacing, textStyles } from '../src/theme';

const hostOf = (origin: string): string => new URL(origin).host;

export default function LinkedAccounts(): React.ReactElement {
  const [view, setView] = useState<UcpLinksOwnerView | null | undefined>(undefined);
  const [shops, setShops] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  // On the web app a page opened after a request is blocked: the owner taps this instead.
  const [signIn, setSignIn] = useState<{ host: string; url: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getOwnerUcpClient();
    if (client === null) return;
    try {
      const [loaded, settings] = await Promise.all([client.links(), client.settings()]);
      setView(loaded);
      setShops(settings.merchants);
    } catch (err) {
      setNote(ownerErrorText(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const link = useCallback(async (origin: string, scopes: readonly string[] = []) => {
    const client = getOwnerUcpClient();
    if (client === null) return;
    setBusy(origin);
    setNote(null);
    setSignIn(null);
    try {
      const out = await client.startLink(origin, scopes);
      if (!out.started) setNote(startRefusalText(out.reason, hostOf(origin)));
      else if (out.opens === 'phone')
        setNote(`Sent to your phone: approve the card there to sign in at ${hostOf(origin)}.`);
      else if (Platform.OS === 'web') setSignIn({ host: hostOf(origin), url: out.url });
      else await Linking.openURL(out.url);
    } catch (err) {
      setNote(ownerErrorText(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const act = useCallback(
    async (origin: string, run: () => Promise<unknown>) => {
      setBusy(origin);
      setConfirming(null);
      try {
        await run();
        await load();
      } catch (err) {
        setNote(ownerErrorText(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const links = view?.links ?? [];
  const linked = new Set(links.map((l) => l.merchant_origin));
  const wanted = (view?.wanted ?? []).filter((w) => !linked.has(w.merchant_origin));
  const asked = new Set(wanted.map((w) => w.merchant_origin));
  const unlinkedShops = shops.filter((s) => !linked.has(s) && !asked.has(s));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="linked-accounts"
    >
      <Stack.Screen options={{ title: 'Linked accounts' }} />
      <Text style={styles.intro}>
        A linked account lets Dina read your orders at a shop and prepare checkouts under your
        account. Dina never cancels, returns or pays. The shop learns that this Dina is linked to
        your account there.
      </Text>
      {view === null && (
        <Text style={styles.meta} testID="linked-accounts-off">
          Turn on shopping to link accounts.
        </Text>
      )}
      {note !== null && (
        <Text style={styles.error} testID="linked-accounts-note">
          {note}
        </Text>
      )}
      {signIn !== null && (
        <Pressable
          testID="linked-accounts-sign-in"
          accessibilityRole="link"
          onPress={() => void Linking.openURL(signIn.url).catch(() => undefined)}
        >
          <Text style={styles.link}>Open {signIn.host}’s sign-in</Text>
        </Pressable>
      )}
      {(view?.unrevoked ?? []).map((u) => (
        <View
          key={`unrevoked-${u.merchant_origin}`}
          style={styles.card}
          testID={`linked-accounts-unrevoked-${u.merchant_host}`}
        >
          <Text style={styles.shop}>{u.merchant_host}</Text>
          <Text style={styles.meta}>
            Dina could not cancel its access at {u.merchant_host}. Remove Dina from your account
            settings there.
          </Text>
          <Pressable
            testID={`linked-accounts-unrevoked-${u.merchant_host}-done`}
            accessibilityRole="button"
            disabled={busy !== null}
            onPress={() =>
              void act(u.merchant_origin, async () =>
                getOwnerUcpClient()?.dismissUnrevoked(u.merchant_origin),
              )
            }
          >
            <Text style={styles.link}>I removed it</Text>
          </Pressable>
        </View>
      ))}
      {links.map((l) => {
        const id = `linked-accounts-${l.merchant_host}`;
        return (
          <View key={l.merchant_origin} style={styles.card} testID={id}>
            <View style={styles.header}>
              <Text style={styles.shop} numberOfLines={1}>
                {l.merchant_host}
              </Text>
              <Text style={styles.state} testID={`${id}-state`}>
                {linkStateText(l)}
              </Text>
            </View>
            {l.scopes.length > 0 && (
              <Text style={styles.meta} testID={`${id}-scopes`}>
                Dina may {l.scopes.map(linkScopeWords).join(', ')}.
              </Text>
            )}
            {l.state === 'needs_relink' && (
              <Pressable
                testID={`${id}-relink`}
                accessibilityRole="button"
                disabled={busy !== null}
                onPress={() => void link(l.merchant_origin)}
              >
                <Text style={styles.link}>Link again</Text>
              </Pressable>
            )}
            {l.state !== 'revoking' &&
              (confirming === l.merchant_origin ? (
                <View style={styles.row}>
                  <Text style={styles.meta}>Unlink {l.merchant_host}?</Text>
                  <Pressable
                    testID={`${id}-unlink-yes`}
                    accessibilityRole="button"
                    disabled={busy !== null}
                    onPress={() =>
                      void act(l.merchant_origin, async () =>
                        getOwnerUcpClient()?.unlink(l.merchant_origin),
                      )
                    }
                  >
                    <Text style={styles.danger}>Unlink</Text>
                  </Pressable>
                  <Pressable
                    testID={`${id}-unlink-no`}
                    accessibilityRole="button"
                    onPress={() => setConfirming(null)}
                  >
                    <Text style={styles.link}>Keep</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  testID={`${id}-unlink`}
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => setConfirming(l.merchant_origin)}
                >
                  <Text style={styles.link}>Unlink</Text>
                </Pressable>
              ))}
          </View>
        );
      })}
      {(view?.failed ?? []).map((f) => (
        <Text
          key={`failed-${f.merchant_origin}`}
          style={styles.meta}
          testID={`linked-accounts-failed-${f.merchant_host}`}
        >
          {attemptText(f.outcome, f.merchant_host)}
        </Text>
      ))}
      {view !== null && view !== undefined && (wanted.length > 0 || unlinkedShops.length > 0) && (
        <View testID="linked-accounts-shops">
          <Text style={styles.sectionTitle}>Your shops</Text>
          {[
            ...wanted.map((w) => ({ origin: w.merchant_origin, scopes: w.scopes, asks: true })),
            ...unlinkedShops.map((origin) => ({ origin, scopes: [] as string[], asks: false })),
          ].map(({ origin, scopes, asks }) => (
            <View key={origin} style={styles.card}>
              <View style={styles.header}>
                <Text style={styles.shop} numberOfLines={1}>
                  {hostOf(origin)}
                </Text>
                <Pressable
                  testID={`linked-accounts-link-${hostOf(origin)}`}
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => void link(origin, scopes)}
                >
                  <Text style={styles.link}>Link</Text>
                </Pressable>
              </View>
              {asks && (
                <Text style={styles.meta} testID={`linked-accounts-asks-${hostOf(origin)}`}>
                  This shop asks you to link your account.
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg },
  intro: { ...textStyles.body, color: colors.textSecondary, marginBottom: spacing.md },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  shop: { ...textStyles.body, color: colors.textPrimary, flex: 1, fontWeight: '600' },
  state: { ...textStyles.caption, color: colors.textSecondary, marginLeft: spacing.sm },
  meta: { ...textStyles.caption, color: colors.textSecondary, marginTop: spacing.xs },
  error: { ...textStyles.body, color: colors.error, marginBottom: spacing.sm },
  link: { ...textStyles.caption, color: colors.accent, marginTop: spacing.sm },
  danger: { ...textStyles.caption, color: colors.error, marginTop: spacing.sm },
});
