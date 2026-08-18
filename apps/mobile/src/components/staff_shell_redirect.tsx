/**
 * A staff-mode device has no vault to unlock and no owner surface — its
 * whole app is the §6.3 staff shell. The UnlockGate renders this when it
 * resolves 'staff' mode; it simply routes to the staff home once the
 * router is mounted, keeping the gate itself free of navigation.
 */

import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '../theme';

export function StaffShellRedirect(): React.ReactElement {
  const router = useRouter();
  useEffect(() => {
    router.replace('/staff-home');
  }, [router]);
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgPrimary },
});
