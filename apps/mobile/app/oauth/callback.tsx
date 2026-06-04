/**
 * OAuth callback route — `<scheme>:/oauth/callback`.
 *
 * Catches the "Login with Bluesky" redirect when the router is mounted
 * (or when the app was cold-started by the redirect). It forwards the
 * URL to the shared `oauth_flow_store` bridge — which resolves the
 * pending `loginWithBluesky` promise — then pops back. During onboarding
 * the router isn't rendered (UnlockGate shows OnboardingFlow), so the
 * Linking listener handles it there; this route makes the callback a
 * real, matched route in every other state (no more "Unmatched Route").
 */

import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { deliverRedirect } from '../../src/services/oauth_flow_store';
import { colors, textStyles } from '../../src/theme';

export default function OAuthCallback(): React.ReactElement {
  const params = useLocalSearchParams<Record<string, string>>();

  useEffect(() => {
    // Reconstruct the callback URL from the route params (warm nav). Fall
    // back to the launch URL when the app was cold-started by the redirect.
    const q = new URLSearchParams();
    for (const k of ['code', 'state', 'iss', 'error', 'error_description']) {
      const v = params[k];
      if (typeof v === 'string' && v.length > 0) q.set(k, v);
    }
    const fromParams = `dina://oauth/callback?${q.toString()}`;

    void (async () => {
      let delivered = false;
      try {
        const initial = await Linking.getInitialURL();
        if (initial !== null) delivered = deliverRedirect(initial);
      } catch {
        /* ignore */
      }
      if (!delivered) deliverRedirect(fromParams);
      // Return to whatever was underneath (e.g. onboarding). No-op if the
      // stack is empty.
      try {
        router.back();
      } catch {
        /* nothing to pop */
      }
    })();
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>Completing sign-in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPrimary,
  },
  text: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
});
