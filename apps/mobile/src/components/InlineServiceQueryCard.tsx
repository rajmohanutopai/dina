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

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';
import { buildResultCardSpec } from '@dina/brain';
import { validateCardSpec } from '@dina/protocol';

import { colors, radius, shadows, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';
import { SafeCardRenderer } from './SafeCardRenderer';

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
      <ServiceQueryProgress
        serviceName={serviceName}
        capability={capability}
        providerDid={lc.providerDid}
        params={lc.params}
        timestamp={message.timestamp}
      />
    );
  }

  if (status === 'resolved') {
    const elapsedSeconds =
      typeof lc.resolvedAt === 'number' && lc.resolvedAt > message.timestamp
        ? Math.max(1, Math.round((lc.resolvedAt - message.timestamp) / 1000))
        : undefined;
    // Card as DATA, not per-capability code: prefer a brain-supplied
    // CardSpec (Card-4 threads `lc.cardSpec`); else derive one
    // deterministically from the result on the fly; else fall back to the
    // generic text card. One render path for every capability.
    //
    // Re-validate `lc.cardSpec` as UNTRUSTED at the render boundary even
    // though the delivery path already validated before persisting: a
    // corrupt / imported / legacy chat row (readLifecycle only checks the
    // discriminator, then casts) must not bypass the safety rules. Invalid
    // or absent → null, so we fall through to the deterministic mapper.
    const spec =
      validateCardSpec(lc.cardSpec, { trusted: false }) ??
      (result !== undefined ? buildResultCardSpec({ capability, serviceName, result }) : null);
    if (spec !== null) {
      return (
        <View testID="chat-card-service-response" style={styles.card}>
          <SafeCardRenderer spec={spec} />
          <ProviderAttribution
            serviceName={serviceName}
            providerDid={lc.providerDid}
            capability={capability}
            params={lc.params}
            elapsedSeconds={elapsedSeconds}
          />
          <MessageTimestamp timestamp={message.timestamp} />
        </View>
      );
    }
    return (
      <View testID="chat-card-service-response" style={styles.card}>
        <Text testID={`service-query-card-title-${message.id}`} style={styles.title}>{serviceName}</Text>
        <Text testID={`service-query-card-body-${message.id}`} style={styles.body}>{message.content}</Text>
        <ProviderAttribution
          serviceName={serviceName}
          providerDid={lc.providerDid}
          capability={capability}
          params={lc.params}
          elapsedSeconds={elapsedSeconds}
        />
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
        <Text style={styles.title}>{serviceName}: couldn't reach</Text>
      </View>
      {error !== undefined && error !== '' && <Text style={styles.errorText}>{error}</Text>}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

interface ProviderAttributionProps {
  serviceName: string;
  providerDid?: string;
  capability: string;
  params?: Record<string, unknown>;
  elapsedSeconds?: number;
}

/**
 * Persistent "you asked another Dina" footer on a resolved result card,
 * expandable into the full handoff path. The hop cards morph away once
 * the answer lands; this keeps the provider identity (name + DID)
 * visible and — on tap — reveals the audit trail of exactly what
 * happened: which directory, which provider, what was shared, how long
 * it took, and that it stayed private to the two Dinas. Collapsed by
 * default so the resting card stays clean; the trail is a tap away.
 */
function ProviderAttribution({
  serviceName,
  providerDid,
  capability,
  params,
  elapsedSeconds,
}: ProviderAttributionProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const did =
    providerDid !== undefined && providerDid !== '' ? ` · ${truncateDid(providerDid)}` : '';
  return (
    <View style={styles.attributionWrap}>
      <TouchableOpacity
        style={styles.attributionRow}
        onPress={() => setExpanded((e) => !e)}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide handoff path' : 'Show handoff path'}
        testID="service-query-card-toggle-trace"
      >
        <Ionicons name="git-network-outline" size={13} color={colors.textMuted} />
        <Text style={styles.attributionText} numberOfLines={1}>
          via {serviceName}
          {did}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={13}
          color={colors.textMuted}
        />
      </TouchableOpacity>
      {expanded && (
        <HandoffTrace
          serviceName={serviceName}
          capability={capability}
          providerDid={providerDid}
          params={params}
          elapsedSeconds={elapsedSeconds}
        />
      )}
    </View>
  );
}

/**
 * The expanded handoff trail — literally the same hop cards the live
 * card walked, frozen in their completed state (tap "show path" to bring
 * them back). An audit record of the cross-Dina exchange, derived
 * entirely from the lifecycle so it mirrors exactly what happened. The
 * last hop reads "{provider} replied in Ns" instead of "waiting…".
 */
function HandoffTrace({
  serviceName,
  capability,
  providerDid,
  params,
  elapsedSeconds,
}: {
  serviceName: string;
  capability: string;
  providerDid?: string;
  params?: Record<string, unknown>;
  elapsedSeconds?: number;
}): React.JSX.Element {
  const hops = buildHops(serviceName, capability, providerDid, params, {
    replied: true,
    elapsedSeconds,
  });
  // activeIndex === hops.length → every hop renders `done` (no spinner).
  return (
    <View style={styles.traceList}>
      <HopList hops={hops} activeIndex={hops.length} />
    </View>
  );
}

/**
 * Human phrase for "what your Dina went looking for" — used as the
 * subtitle of the first hop card. Generic across capabilities so the
 * handoff card works for any service, not just transit.
 */
function lookingForLabel(capability: string): string {
  switch (capability) {
    case 'eta_query':
      return 'live transit ETA';
    case 'appointment_status':
      return 'an appointment status';
    case 'price_check':
      return 'a price quote';
    default:
      return capability !== '' ? capability.replace(/_/g, ' ') : 'a service';
  }
}

/** Shorten a DID for display: `did:plc:6sk7wchkm6sf…` → `did:plc:6sk7wc…`. */
function truncateDid(did: string): string {
  const m = /^(did:[a-z]+:)([a-z0-9]+)/i.exec(did);
  if (m !== null) return `${m[1]}${m[2].slice(0, 6)}…`;
  return did.length > 18 ? `${did.slice(0, 16)}…` : did;
}

/**
 * One-line summary of the query params for the "sent query" hop. Picks
 * the first couple of scalar fields and humanises their keys
 * (`route_id: "22"` → `route 22`). Nested objects (e.g. geo) are
 * skipped. Returns `null` when there's nothing printable.
 */
function summarizeParams(params: Record<string, unknown> | undefined): string | null {
  if (params === undefined || params === null) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (parts.length >= 2) break;
    const scalar =
      typeof value === 'string' && value !== ''
        ? value
        : typeof value === 'number'
          ? String(value)
          : null;
    if (scalar === null) continue;
    const label = key.replace(/_id$/, '').replace(/_/g, ' ').trim();
    parts.push(label !== '' ? `${label} ${scalar}` : scalar);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Staged handoff shown while a service query is in flight (lifecycle
 * `pending`). Renders the Dina-to-Dina handoff as a column of connected
 * hop cards — your Dina asks the directory, finds the provider's Dina
 * (by name + DID), sends the query, and waits for a reply — so the
 * viewer *sees* the request travel to someone else, instead of a single
 * opaque spinner.
 *
 * This is the canonical service-discovery presentation: every capability
 * call (transit, appointments, price checks, …) flows through the same
 * four hops, so the card is generic — capability/params/provider come
 * from the lifecycle, copy is derived, nothing is transit-specific.
 *
 * Hops advance on a presentation timeline (real discovery + dispatch all
 * happen inside the `pending` window — there are no granular backend
 * sub-events). The final "waiting" hop holds its spinner until the
 * response lands and the whole card morphs into the result body.
 * `STUB_ETA_DELAY_SECONDS` on the provider side keeps the reply from
 * arriving before the sequence finishes (demo pacing).
 */
const STEP_ADVANCE_MS = [1100, 2300, 3600];

type HopState = 'done' | 'active' | 'upcoming';

interface Hop {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string | null;
}

/**
 * Build the four handoff hops from the lifecycle. Shared by the live
 * progress card and the expandable trail on the resolved card, so both
 * render identical hop visuals — the trail is just the same hops frozen
 * in their completed state. `replied` flips the last hop from
 * "waiting…" to "{provider} replied in Ns".
 */
function buildHops(
  serviceName: string,
  capability: string,
  providerDid: string | undefined,
  params: Record<string, unknown> | undefined,
  opts?: { replied?: boolean; elapsedSeconds?: number },
): Hop[] {
  const last: Hop =
    opts?.replied === true
      ? {
          icon: 'arrow-undo-outline',
          title:
            opts.elapsedSeconds !== undefined
              ? `${serviceName} replied in ${opts.elapsedSeconds}s`
              : `${serviceName} replied`,
          subtitle: 'Private. Only your two Dinas see this',
        }
      : {
          icon: 'hourglass-outline',
          title: `Waiting for ${serviceName} to reply…`,
          subtitle: 'Private. Only your two Dinas see this',
        };
  return [
    {
      icon: 'search-outline',
      title: 'Asked the Dina service directory',
      subtitle: `Looking for ${lookingForLabel(capability)}`,
    },
    {
      icon: 'git-network-outline',
      title: `Found ${serviceName}`,
      subtitle:
        providerDid !== undefined && providerDid !== ''
          ? truncateDid(providerDid)
          : 'Discovered via PeerLens',
    },
    {
      icon: 'paper-plane-outline',
      title: 'Sent your query to their Dina',
      subtitle: summarizeParams(params),
    },
    last,
  ];
}

/**
 * Render the connected hop cards. `activeIndex` drives state: hops
 * before it are `done`, the one at it is `active` (spinner), after it
 * `upcoming`. Pass `activeIndex === hops.length` to freeze them all
 * `done` — that's the expanded trail on a resolved card.
 */
function HopList({ hops, activeIndex }: { hops: Hop[]; activeIndex: number }): React.JSX.Element {
  return (
    <View>
      {hops.map((hop, i) => {
        const state: HopState =
          i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'upcoming';
        return (
          <React.Fragment key={i}>
            <HopCardRow hop={hop} state={state} />
            {i < hops.length - 1 && (
              <View style={styles.connectorWrap}>
                <View style={[styles.connector, i < activeIndex && styles.connectorDone]} />
              </View>
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

interface ServiceQueryProgressProps {
  serviceName: string;
  capability: string;
  providerDid?: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

function ServiceQueryProgress({
  serviceName,
  capability,
  providerDid,
  params,
  timestamp,
}: ServiceQueryProgressProps): React.JSX.Element {
  const hops = useMemo(
    () => buildHops(serviceName, capability, providerDid, params),
    [serviceName, capability, providerDid, params],
  );

  const [active, setActive] = useState(0);
  useEffect(() => {
    // Advance through the first three hops on a timeline; the last
    // (index 3, "waiting") becomes active and stays there until the
    // card unmounts / swaps to the resolved result.
    const timers = STEP_ADVANCE_MS.map((ms, i) => setTimeout(() => setActive(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <View style={styles.card}>
      <View style={styles.handoffHeader}>
        <Ionicons name="git-network-outline" size={14} color={colors.textMuted} />
        <Text style={styles.handoffEyebrow}>SERVICE HANDOFF</Text>
      </View>
      <HopList hops={hops} activeIndex={active} />
      <MessageTimestamp timestamp={timestamp} />
    </View>
  );
}

function HopCardRow({ hop, state }: { hop: Hop; state: HopState }): React.JSX.Element {
  return (
    <View
      style={[
        styles.hopCard,
        state === 'active' && styles.hopCardActive,
        state === 'upcoming' && styles.hopCardUpcoming,
      ]}
    >
      <View
        style={[
          styles.hopIcon,
          state === 'active' && styles.hopIconActive,
          state === 'upcoming' && styles.hopIconUpcoming,
        ]}
      >
        <Ionicons
          name={hop.icon}
          size={16}
          color={state === 'active' ? colors.white : colors.textSecondary}
        />
      </View>
      <View style={styles.hopBody}>
        <Text
          style={[
            styles.hopTitle,
            state === 'active' && styles.hopTitleActive,
            state === 'upcoming' && styles.hopTitleUpcoming,
          ]}
          numberOfLines={1}
        >
          {hop.title}
        </Text>
        {hop.subtitle !== null && hop.subtitle !== '' && (
          <Text style={styles.hopSub} numberOfLines={1}>
            {hop.subtitle}
          </Text>
        )}
      </View>
      <View style={styles.hopStatus}>
        {state === 'done' && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
        {state === 'active' && <ActivityIndicator size="small" color={colors.accent} />}
        {state === 'upcoming' && (
          <Ionicons name="ellipse-outline" size={16} color={colors.textMuted} />
        )}
      </View>
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
    ...textStyles.bodyStrong,
    flexShrink: 1,
  },
  subtitle: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
  },
  body: textStyles.body,
  etaPrimary: {
    ...textStyles.h2,
    marginVertical: spacing.xs,
  },
  etaSecondary: {
    ...textStyles.bodyLarge,
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
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
  errorText: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.xs,
  },
  handoffHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  handoffEyebrow: {
    ...textStyles.eyebrow,
    color: colors.textMuted,
  },
  hopCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  hopCardActive: {
    backgroundColor: colors.bgSecondary,
    borderColor: colors.accent,
    ...shadows.sm,
  },
  hopCardUpcoming: {
    backgroundColor: 'transparent',
    borderColor: colors.borderLight,
    opacity: 0.55,
  },
  hopIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.full,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hopIconActive: {
    backgroundColor: colors.accent,
  },
  hopIconUpcoming: {
    backgroundColor: colors.bgTertiary,
  },
  hopBody: {
    flex: 1,
    minWidth: 0,
  },
  hopTitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  hopTitleActive: {
    ...textStyles.bodySmallStrong,
    color: colors.textPrimary,
  },
  hopTitleUpcoming: {
    color: colors.textMuted,
  },
  hopSub: {
    ...textStyles.tiny,
    color: colors.textMuted,
    marginTop: 1,
  },
  hopStatus: {
    width: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectorWrap: {
    height: 12,
    paddingLeft: spacing.sm + 15,
  },
  connector: {
    width: 2,
    flex: 1,
    backgroundColor: colors.border,
    borderRadius: 1,
  },
  connectorDone: {
    backgroundColor: colors.success,
  },
  attributionWrap: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  attributionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  attributionText: {
    ...textStyles.tiny,
    color: colors.textMuted,
    flex: 1,
  },
  traceList: {
    marginTop: spacing.sm,
  },
});
