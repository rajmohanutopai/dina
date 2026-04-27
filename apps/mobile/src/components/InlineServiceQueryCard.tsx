/**
 * `InlineServiceQueryCard` — chat-thread inline renderer for a `'dina'`
 * message tagged with `metadata.lifecycle.kind === 'service_query'`.
 *
 * The card is posted by the chat orchestrator at dispatch time
 * (`addLifecycleMessage`, status `pending`) and patched in place by
 * the WorkflowEventConsumer when the response lands
 * (`updateMessageLifecycle`, status → `resolved` / `failed` /
 * `expired`). One artifact, four states — replaces the prior pattern
 * where the LLM narrative + the workflow-event push produced two
 * messages for a single query.
 *
 * The renderer dispatches on the four terminal states. Capability-
 * specific rendering today is `eta_query` (bus / transit). A generic
 * fallback handles every other capability so unknown providers still
 * land cleanly.
 */

import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { readLifecycle, type ChatMessage } from '@dina/brain/src/chat/thread';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';

export interface InlineServiceQueryCardProps {
  message: ChatMessage;
}

export function InlineServiceQueryCard({
  message,
}: InlineServiceQueryCardProps): React.JSX.Element | null {
  const lc = readLifecycle(message);
  if (lc === null || lc.kind !== 'service_query') return null;

  const { status, serviceName, capability, result, error } = lc;

  if (status === 'pending') {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <ActivityIndicator color={colors.textMuted} size="small" />
          <Text style={styles.title}>Looking up {serviceName}…</Text>
        </View>
        <Text style={styles.subtitle}>{labelForCapability(capability)}</Text>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  if (status === 'resolved') {
    if (capability === 'eta_query' && result !== undefined) {
      return <EtaResultBody serviceName={serviceName} result={result} timestamp={message.timestamp} />;
    }
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{serviceName}</Text>
        <Text style={styles.body}>{message.content}</Text>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  if (status === 'expired') {
    return (
      <View style={[styles.card, styles.cardMuted]}>
        <View style={styles.headerRow}>
          <Ionicons name="time-outline" size={18} color={colors.textMuted} />
          <Text style={styles.title}>No response from {serviceName}</Text>
        </View>
        <Text style={styles.subtitle}>Try again in a moment.</Text>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  // failed
  return (
    <View style={[styles.card, styles.cardError]}>
      <View style={styles.headerRow}>
        <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
        <Text style={styles.title}>{serviceName} — couldn't reach</Text>
      </View>
      {error !== undefined && error !== '' && <Text style={styles.errorText}>{error}</Text>}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

function labelForCapability(capability: string): string {
  switch (capability) {
    case 'eta_query':
      return 'Estimated time of arrival';
    case 'appointment_status':
      return 'Appointment status';
    case 'price_check':
      return 'Price check';
    default:
      return capability || 'Service query';
  }
}

interface EtaResultBodyProps {
  serviceName: string;
  result: Record<string, unknown>;
  timestamp: number;
}

function EtaResultBody({ serviceName, result, timestamp }: EtaResultBodyProps): React.JSX.Element {
  const eta =
    typeof result.eta_minutes === 'number'
      ? `${result.eta_minutes} min`
      : typeof result.eta_minutes === 'string'
        ? `${result.eta_minutes} min`
        : null;
  const stop = typeof result.stop_name === 'string' ? result.stop_name : null;
  const route = typeof result.route_name === 'string' ? result.route_name : null;
  const mapUrl = typeof result.map_url === 'string' ? result.map_url : null;

  const onOpenMap = useCallback(() => {
    if (mapUrl !== null) {
      void Linking.openURL(mapUrl).catch(() => {
        /* user can ignore */
      });
    }
  }, [mapUrl]);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="bus-outline" size={20} color={colors.textPrimary} />
        <Text style={styles.title}>{route ?? serviceName}</Text>
      </View>
      {eta !== null && (
        <Text style={styles.etaPrimary}>
          {eta}
          {stop !== null ? <Text style={styles.etaSecondary}> to {stop}</Text> : null}
        </Text>
      )}
      {mapUrl !== null && (
        <TouchableOpacity
          testID="service-query-map-button"
          style={styles.mapButton}
          onPress={onOpenMap}
          activeOpacity={0.7}
        >
          <Ionicons name="map-outline" size={16} color={colors.bgPrimary} />
          <Text style={styles.mapButtonText}>Open in Maps</Text>
        </TouchableOpacity>
      )}
      <MessageTimestamp timestamp={timestamp} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  cardMuted: {
    backgroundColor: colors.bgTertiary,
  },
  cardError: {
    borderColor: colors.error,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  body: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  etaPrimary: {
    fontFamily: fonts.headingBold,
    fontSize: 28,
    color: colors.textPrimary,
    marginVertical: spacing.xs,
  },
  etaSecondary: {
    fontFamily: fonts.sansMedium,
    fontSize: 16,
    color: colors.textSecondary,
  },
  mapButton: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  mapButtonText: {
    fontFamily: fonts.sansSemibold,
    color: colors.bgPrimary,
    fontSize: 14,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
    marginTop: spacing.xs,
  },
});
