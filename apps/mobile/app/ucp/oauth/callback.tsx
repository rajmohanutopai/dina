/**
 * A merchant sending the owner back after linking an account (UCP plan
 * §3.17): `https://<label>.<profile host>/oauth/callback`, claimed by this
 * app and routed here by `+native-intent`. The parameters go to Core once:
 * this phone's own link finishes here; a paired server's waits on the phone
 * for that server to pull. The screen says which.
 */

import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ownerErrorText } from '../../../src/services/owner_errors';
import { getOwnerUcpClient } from '../../../src/services/owner_ucp_client';
import { callbackText } from '../../../src/services/ucp_link_words';
import { colors, spacing, textStyles } from '../../../src/theme';

const PARAMS = ['code', 'state', 'iss', 'error'] as const;
/** While the app unlocks after a cold start, Core is not there yet: ask again, for a while. */
const WAIT_STEP_MS = 500;
const WAIT_FOR_MS = 60_000;

export default function UcpLinkCallback(): React.ReactElement {
  const params = useLocalSearchParams<Record<string, string>>();
  const [text, setText] = useState('Finishing the link…');
  const [done, setDone] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    let live = true;
    const given: Record<string, string> = {};
    for (const k of PARAMS) {
      const v = params[k];
      if (typeof v === 'string' && v !== '') given[k] = v;
    }
    void (async () => {
      for (let waited = 0; live && waited < WAIT_FOR_MS; waited += WAIT_STEP_MS) {
        const client = getOwnerUcpClient();
        if (client !== null) {
          if (sent.current) return;
          sent.current = true;
          try {
            const out = await client.linkCallback(given);
            if (live) setText(callbackText(out));
          } catch (err) {
            if (live) setText(ownerErrorText(err));
          }
          if (live) setDone(true);
          return;
        }
        await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
      }
      if (live) {
        setText('Dina is not open yet. Unlock Dina, then start the link again.');
        setDone(true);
      }
    })();
    return () => {
      live = false;
    };
    // The callback is handed in once, on mount.
  }, []);

  return (
    <View style={styles.container} testID="ucp-link-callback">
      <Stack.Screen options={{ title: 'Linked accounts' }} />
      <Text style={styles.text} testID="ucp-link-callback-text">
        {text}
      </Text>
      {done && (
        <Pressable
          testID="ucp-link-callback-done"
          accessibilityRole="button"
          onPress={() => router.replace('/linked-accounts')}
        >
          <Text style={styles.link}>See linked accounts</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.bgPrimary,
  },
  text: { ...textStyles.body, color: colors.textPrimary, textAlign: 'center' },
  link: { ...textStyles.body, color: colors.accent, marginTop: spacing.lg },
});
