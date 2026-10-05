/**
 * Agents — admin screen for authorizing remote clients that act on
 * the user's behalf (port of main-dina `dina-admin device pair` +
 * `device list`). Today every entry here is a `dina-agent` install
 * (or a thing that wraps it like OpenClaw or `dina-cli`); there is
 * no Dina-to-Dina pairing — that's Contacts (DIDs). Mobile supports
 * the signed agent data APIs, but the filesystem-aware coding gate
 * itself runs only on Home Node Lite.
 *
 * Mints a pairing code and wraps it (with relay URL + node DID) into a
 * one-paste `dina1:…` setup string the agent consumes via
 * `dina configure` (interactive paste) or `--setup-code`. The screen
 * talks to Core via the in-process ceremony / registry modules — no
 * HTTP round-trip needed because Admin UI runs inside the same JS
 * runtime as Core.
 *
 * Reached via the "Agents" row on the main Settings screen. Route
 * stays `/paired-devices` to avoid breaking the deep-link surface.
 * Hidden from the tab bar.
 */

import { Stack } from 'expo-router';
import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  OwnerSetupHttpError,
  type AgentSupervisionPolicies,
  type AgentSupervisionProfile,
  type ApprovalPhoneStatus,
  type OwnerSetupDeviceEntry,
} from '@dina/core';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import {
  activeConnectedBrainForPrincipal,
  disableConnectedBrain,
  enableConnectedBrain,
  type ConnectedBrainOwnerClient,
} from '../src/reasoning/connected_brain_control';
import { confirmDecision } from '../src/services/confirm_decision';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import {
  CONNECT_OWNER_DEVICE_MESSAGE,
  errorKeyOf,
  isPresenceRefusal,
  ownerErrorText,
} from '../src/services/owner_errors';
import { getOwnerRunClient } from '../src/services/owner_run_client';
import { getOwnerSetupClient } from '../src/services/owner_setup_client';
import { shareOrCopy, shareOutcomeLabel, type ShareOutcome } from '../src/services/share_text';
import { showMessage } from '../src/services/show_message';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

/**
 * How closely Dina supervises a coding agent (`/v1/owner/agent-policies`).
 * With no choice made, full supervision applies.
 */
const SUPERVISION: { profile: AgentSupervisionProfile; label: string; description: string }[] = [
  {
    profile: 'network_protection',
    label: 'Standard',
    description:
      'Dina provides identity, private context, services and connections. Your agent handles ordinary local work; requests from others stay fully supervised.',
  },
  {
    profile: 'sensitive_boundaries',
    label: 'Sensitive boundaries',
    description:
      'Dina also checks protected data, external sends, destructive operations, package changes and system changes.',
  },
  {
    profile: 'full_supervision',
    label: 'Full supervision',
    description:
      'Dina applies its full classifier and approval policy to every supported tool call.',
  },
];

interface SupervisionState {
  profile: AgentSupervisionProfile;
  /** The version the owner saw, for the next change; null before any choice. */
  version: number | null;
  /** An earlier owner identity chose it: full supervision applies until reconfirmed. */
  stale: boolean;
}

/** The two kinds this screen pairs; runners and plugins pair elsewhere. */
type PairableRole = 'agent' | 'node' | 'staff';

/** What each pairable kind is called on this screen. */
const ROLE_LABEL: Record<PairableRole, string> = {
  agent: 'Coding agent',
  node: 'Server node',
  staff: 'Staff phone',
};

/** A device as the list shows it (Core's owner-setup status, one row). */
interface DeviceRow {
  deviceId: string;
  did: string;
  deviceName: string;
  role: string;
  scope?: string;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
}

function toRow(entry: OwnerSetupDeviceEntry): DeviceRow {
  return {
    deviceId: entry.device_id,
    did: entry.did,
    deviceName: entry.name,
    role: entry.role,
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    createdAt: entry.created_at,
    lastSeen: entry.last_seen,
    revoked: entry.revoked,
  };
}

interface LiveCode {
  expiresAt: number; // unix seconds
  deviceName: string;
  role: PairableRole;
  /**
   * The one-paste `dina1:…` string bundling relay URL + node DID +
   * this pairing code — the only pairing artifact the UI shows.
   */
  setupCode: string;
}

export default function PairedDevicesScreen() {
  const insets = useSafeAreaInsets();
  const bottomPad = insets.bottom + 49 + spacing.md;
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  // Empty default; the placeholder below shows `openclaw-user` as a
  // hint. Pre-filling forced anyone pairing dina-cli or a phone to
  // clear the field before typing — a self-defeating "convenience".
  const [deviceName, setDeviceName] = useState('');
  // Two pairable roles: `agent` (a dina-agent install) and — the §6
  // trade slice — `staff`, a clerk's phone acting under value-capped
  // grants. Staff devices get their authority on the Staff screen; the
  // pairing only mints the identity.
  const [role, setRole] = useState<PairableRole>('agent');
  const [generating, setGenerating] = useState(false);
  const [liveCode, setLiveCode] = useState<LiveCode | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [shareOutcome, setShareOutcome] = useState<ShareOutcome | null>(null);
  /** Why the device list is empty when it could not load (e.g. a browser not connected). */
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [reasoningBackends, setReasoningBackends] = useState<
    Awaited<ReturnType<ConnectedBrainOwnerClient['reasoningBackends']>>['backends']
  >([]);
  const [brainBusyDid, setBrainBusyDid] = useState<string | null>(null);
  const [supervision, setSupervision] = useState<Record<string, SupervisionState>>({});
  // A server node can pair a phone to approve its cards; the phone app itself
  // never sees this (its status carries no `phone`).
  const [approvalPhone, setApprovalPhone] = useState<ApprovalPhoneStatus | undefined>(undefined);
  const [phoneCode, setPhoneCode] = useState('');

  const getBrainClient = useCallback((): ConnectedBrainOwnerClient | null => {
    const client = getOwnerRunClient();
    return client !== null &&
      typeof client.reasoningBackends === 'function' &&
      typeof client.reasoningRegisterBackend === 'function' &&
      typeof client.reasoningRevokeBackend === 'function'
      ? (client as ConnectedBrainOwnerClient)
      : null;
  }, []);

  const refreshBrainBindings = useCallback(async () => {
    const client = getBrainClient();
    if (client === null) {
      setReasoningBackends([]);
      return;
    }
    try {
      setReasoningBackends((await client.reasoningBackends()).backends);
    } catch (err) {
      console.warn(
        '[paired-devices] reasoning backend list failed',
        err instanceof Error ? err.message : String(err),
      );
      setReasoningBackends([]);
    }
  }, [getBrainClient]);

  // The list is Core's (the phone's in-process Core, or the Home Node's for a
  // browser connected as the owner), so every surface shows the same devices.
  const refreshDevices = useCallback(async () => {
    const client = getOwnerSetupClient();
    if (client === null) {
      setDevices([]);
      return;
    }
    try {
      const status = await client.status();
      setDevices(status.devices.map(toRow));
      setApprovalPhone(status.phone);
      setDevicesError(null);
    } catch (err) {
      // Not fatal: show an empty list and say why (a browser not connected
      // as the owner, a node still starting).
      setDevices([]);
      setDevicesError(
        errorKeyOf(err) === 'owner_device_not_connected'
          ? CONNECT_OWNER_DEVICE_MESSAGE
          : 'Could not load the devices. Try again shortly.',
      );
      console.warn('[paired-devices] device list failed', errorKeyOrMessage(err));
    }
    try {
      setSupervision(supervisionByAgent(await client.agentPolicies()));
    } catch {
      // Without the list every agent reads as full supervision, the default.
      setSupervision({});
    }
  }, []);

  // Revoke a paired device. Cascades through the registry to
  // unregister the DID from auth/caller_type so subsequent signed
  // requests fail with caller-type 'unknown' (auth middleware
  // rejects). Confirmation dialog is mandatory — revocation breaks
  // any agent-daemon currently polling against this DID and the user
  // would have to re-pair to recover.
  const handleRevoke = useCallback(
    (device: DeviceRow) => {
      if (device.revoked) return;
      void (async () => {
        const revoke = await confirmDecision(
          `Revoke "${device.deviceName}"?`,
          'The agent will lose access immediately. Any in-flight signed requests will fail and the agent must be re-paired with a new code to regain access.',
          'Revoke',
          true,
        );
        if (!revoke) return;
        // Durable revoke (issues.txt §5): Core persists revoked=1 before
        // answering 204, and says so when it could not.
        try {
          let brainCleanupFailed = false;
          const brainClient = getBrainClient();
          if (brainClient !== null) {
            try {
              await disableConnectedBrain(brainClient, device.did);
            } catch {
              // Device revocation remains the hard security boundary:
              // continue even when the convenience-policy cleanup
              // conflicts, then tell the owner it needs attention.
              brainCleanupFailed = true;
            }
          }
          const client = getOwnerSetupClient();
          if (client === null) throw new Error('Dina is still starting up.');
          let notDurable = false;
          try {
            await client.revokeDevice(device.deviceId);
          } catch (err) {
            if (!(err instanceof OwnerSetupHttpError) || err.status !== 503) throw err;
            notDurable = true;
          }
          await refreshDevices();
          await refreshBrainBindings();
          if (notDurable || brainCleanupFailed) {
            showMessage(
              'Revoke not fully saved',
              'Agent access was cut, but every related policy change could not be confirmed. Please retry after the app is fully available.',
            );
          }
        } catch (err) {
          showMessage('Revoke failed', ownerErrorText(err));
        }
      })();
    },
    [getBrainClient, refreshBrainBindings, refreshDevices],
  );

  useEffect(() => {
    void refreshDevices();
    void refreshBrainBindings();
  }, [refreshBrainBindings, refreshDevices]);

  // Tick the expiry countdown every second while a code is live.
  useEffect(() => {
    if (liveCode === null) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [liveCode]);

  // Auto-clear expired codes so the UI doesn't misleadingly keep
  // showing a code the ceremony module has already purged.
  useEffect(() => {
    if (liveCode !== null && liveCode.expiresAt <= now) {
      setLiveCode(null);
    }
  }, [liveCode, now]);

  // Share the one-paste setup string (AirDrop / Notes / clipboard apps).
  // Short-lived + single-use, same sensitivity envelope as the embedded
  // pairing code — the share sheet is the user's trust decision.
  const handleShareSetup = useCallback(() => {
    if (liveCode === null) return;
    void shareOrCopy(liveCode.setupCode).then((outcome) => {
      setShareOutcome(outcome);
      setTimeout(() => setShareOutcome(null), 2000);
    });
  }, [liveCode]);

  // Minting a code, lowering an agent's supervision and pairing an approval
  // phone all hand out authority, so Core asks for a person present (§3.8).
  // Each action reports its own failure; only a presence refusal reaches the
  // gate, which asks and runs the same action again.
  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const commerce = getOwnerCommerceClient();
      if (commerce === null) throw new Error('Dina is still starting up.');
      await commerce.provePresence(passphrase);
    },
    onError: (err) => showMessage('Something went wrong', ownerErrorText(err)),
    reason: 'This hands a device or an agent more authority, so Dina checks a person is here.',
  });

  const gated = useCallback(
    (title: string, action: () => Promise<void>): Promise<void> =>
      runGated(async () => {
        try {
          await action();
        } catch (err) {
          if (isPresenceRefusal(err)) throw err;
          showMessage(title, ownerErrorText(err));
        }
      }),
    [runGated],
  );

  // Turning Brain access ON lets the agent claim reasoning jobs carrying
  // vault context, so Core asks for a person present; turning it off does not.
  const handleToggleBrain = useCallback(
    (device: DeviceRow) => {
      const client = getBrainClient();
      if (client === null || device.revoked) return;
      const active = activeConnectedBrainForPrincipal(reasoningBackends, device.did);
      setBrainBusyDid(device.did);
      void gated('Could not update Brain access', async () => {
        if (active === null) await enableConnectedBrain(client, device);
        else await disableConnectedBrain(client, device.did);
      }).finally(() => {
        setBrainBusyDid(null);
        void refreshBrainBindings();
      });
    },
    [gated, getBrainClient, reasoningBackends, refreshBrainBindings],
  );

  const handleSupervision = useCallback(
    (device: DeviceRow, profile: AgentSupervisionProfile) => {
      const client = getOwnerSetupClient();
      if (client === null) return;
      const current = supervision[device.did];
      void gated('Could not change supervision', async () => {
        await client.setAgentPolicy(device.did, profile, current?.version ?? null);
        await refreshDevices();
      });
    },
    [gated, refreshDevices, supervision],
  );

  const handlePairPhone = useCallback(() => {
    const client = getOwnerSetupClient();
    const code = phoneCode.trim();
    if (client === null || code === '') return;
    void gated('Could not pair the phone', async () => {
      setApprovalPhone(await client.pairApprovalPhone(code));
      setPhoneCode('');
    });
  }, [gated, phoneCode]);

  const handleUnpairPhone = useCallback(() => {
    const client = getOwnerSetupClient();
    if (client === null) return;
    void (async () => {
      const unpair = await confirmDecision(
        'Unpair the approval phone?',
        'It stops deciding this node’s high-risk coding actions.',
        'Unpair',
        true,
      );
      if (!unpair) return;
      try {
        setApprovalPhone(await client.revokeApprovalPhone());
      } catch (err) {
        showMessage('Could not unpair the phone', ownerErrorText(err));
      }
    })();
  }, []);

  const handleGenerate = useCallback(() => {
    const name = deviceName.trim();
    if (name === '') {
      showMessage('Device name required', 'Give the device a name before generating a code.');
      return;
    }
    const client = getOwnerSetupClient();
    if (client === null) {
      showMessage('Could not generate setup code', 'Dina is still starting up.');
      return;
    }
    const pairing = role;
    setGenerating(true);
    // Pairing codes are short-lived shared secrets — never log the code value
    // itself (MT-33-I1): native logs persist, and a recent code would surface
    // to anyone reading them. Core mints the code and the one-paste setup
    // string (relay, node identity, and for a staff phone the node's signing
    // key); a coding agent is stamped `coding` scope there.
    void gated('Could not generate setup code', async () => {
      // A server node (UCP plan §3.9) mirrors its approval cards here: its own scope, so
      // no coding agent can send a checkout card or a link to open.
      const minted =
        pairing === 'agent'
          ? await client.mintCodingAgentCode(name)
          : pairing === 'node'
            ? await client.mintServerNodeCode(name)
            : await client.mintStaffCode(name);
      setLiveCode({
        expiresAt: minted.expires_at,
        deviceName: minted.device_name ?? name,
        role: pairing,
        setupCode: minted.setup_code,
      });
    }).finally(() => setGenerating(false));
  }, [deviceName, role, gated]);

  const secondsRemaining = liveCode === null ? 0 : Math.max(0, liveCode.expiresAt - now);

  return (
    <>
      <Stack.Screen options={{ title: 'Agents' }} />
      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        bottomOffset={24}
      >
        <Section title={`CONNECTED (${devices.length})`}>
          {devices.length === 0 ? (
            <Text style={styles.empty} testID="paired-devices-empty">
              {devicesError ?? 'No agents connected yet.'}
            </Text>
          ) : (
            devices.map((d) => {
              const activeBrain = activeConnectedBrainForPrincipal(reasoningBackends, d.did);
              const brainBusy = brainBusyDid === d.did;
              return (
                <View key={d.deviceId} style={styles.deviceRow}>
                  <View style={styles.deviceRowMain}>
                    <Text style={styles.deviceName}>{d.deviceName}</Text>
                    <Text style={styles.deviceMeta}>
                      {d.role}
                      {d.scope !== undefined ? ` · ${d.scope}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.deviceDID} numberOfLines={1} ellipsizeMode="middle">
                    {d.did}
                  </Text>
                  <Text style={styles.deviceMeta}>
                    Paired {new Date(d.createdAt).toLocaleDateString()}
                    {d.lastSeen > 0 ? ` • active ${new Date(d.lastSeen).toLocaleDateString()}` : ''}
                    {d.revoked ? ' • revoked' : ''}
                  </Text>
                  {/* Only a coding agent session can do Dina's reasoning. */}
                  {!d.revoked &&
                    d.role === 'agent' &&
                    d.scope === 'coding' &&
                    getBrainClient() !== null && (
                      <>
                        <Pressable
                          testID={`paired-devices-brain-${d.deviceId}`}
                          onPress={() => handleToggleBrain(d)}
                          disabled={brainBusy}
                          style={({ pressed }) => [
                            styles.brainButton,
                            activeBrain !== null && styles.brainButtonActive,
                            (pressed || brainBusy) && styles.brainButtonPressed,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={
                            activeBrain === null
                              ? `Use ${d.deviceName} as Brain`
                              : `Stop using ${d.deviceName} as Brain`
                          }
                        >
                          {brainBusy ? (
                            <ActivityIndicator size="small" color={colors.textPrimary} />
                          ) : (
                            <Text style={styles.brainButtonText}>
                              {activeBrain === null ? 'Use as Brain' : 'Stop using as Brain'}
                            </Text>
                          )}
                        </Pressable>
                        <Text style={styles.brainHelp}>
                          {activeBrain === null
                            ? 'Let this active Claude, Codex, or other coding-agent session perform bounded reasoning for Dina.'
                            : 'Foreground only. Dina still controls identity, context, approvals, state, and actions.'}
                        </Text>
                      </>
                    )}
                  {!d.revoked && d.role === 'agent' && d.scope === 'coding' && (
                    <SupervisionPicker
                      device={d}
                      state={supervision[d.did]}
                      onChoose={(profile) => handleSupervision(d, profile)}
                    />
                  )}
                  {!d.revoked && (
                    <Pressable
                      testID="paired-devices-revoke"
                      onPress={() => handleRevoke(d)}
                      style={({ pressed }) => [
                        styles.revokeButton,
                        pressed && styles.revokeButtonPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Revoke ${d.deviceName}`}
                    >
                      <Text style={styles.revokeText}>Revoke access</Text>
                    </Pressable>
                  )}
                </View>
              );
            })
          )}
          <Pressable
            testID="paired-devices-refresh"
            onPress={() => {
              void refreshDevices();
              void refreshBrainBindings();
            }}
            style={styles.refreshButton}
            accessibilityRole="button"
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </Section>

        {approvalPhone !== undefined && (
          <Section title="APPROVAL PHONE">
            <Text style={styles.help} testID="approval-phone-state">
              {approvalPhone.state === 'active'
                ? `Paired${approvalPhone.phoneDid !== undefined ? ` · ${approvalPhone.phoneDid}` : ''}. That phone decides this node’s high-risk coding actions.`
                : approvalPhone.state === 'revoking'
                  ? 'Unpaired here; the relay still owes the phone its cleanup.'
                  : 'No phone decides this node’s high-risk coding actions yet. Generate a setup code in the Dina phone app (Settings → Agents) and paste it here.'}
            </Text>
            {approvalPhone.state === 'active' ? (
              <Pressable
                testID="approval-phone-revoke"
                onPress={handleUnpairPhone}
                style={({ pressed }) => [
                  styles.revokeButton,
                  pressed && styles.revokeButtonPressed,
                ]}
                accessibilityRole="button"
              >
                <Text style={styles.revokeText}>Unpair phone</Text>
              </Pressable>
            ) : (
              <>
                <TextInput
                  testID="approval-phone-code"
                  style={styles.input}
                  value={phoneCode}
                  onChangeText={setPhoneCode}
                  secureTextEntry
                  placeholder="dina1:…"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable
                  testID="approval-phone-pair"
                  style={[
                    styles.primaryButton,
                    phoneCode.trim() === '' && styles.primaryButtonDisabled,
                  ]}
                  disabled={phoneCode.trim() === ''}
                  onPress={handlePairPhone}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>Pair phone</Text>
                </Pressable>
              </>
            )}
          </Section>
        )}

        <Section title="AUTHORIZE A NEW AGENT">
          <Text style={styles.help}>
            Agents act on your behalf. They run as <Text style={styles.mono}>dina-agent</Text>,
            submit Ed25519 signed requests to this device, and only do what you allow.
            {'\n\n'}
            This mobile setup enables Dina memory, Ask, validation, and PII tools. The Claude Code
            safety-gate plugin requires a Home Node Lite setup code instead; do not enable its
            fail-closed hook against this mobile node.
            {'\n\n'}
            To pair a new agent:{'\n'}
            1. Install on the agent host: <Text style={styles.mono}>pip install dina-agent</Text>.
            {'\n'}
            2. Generate a setup code below.{'\n'}
            3. On the agent host, run <Text style={styles.mono}>dina init</Text> and paste the setup
            code when asked — it pairs, then installs the Dina skill for the agents on that machine.
            {'\n\n'}
            The agent then registers its own keypair against the embedded pairing code. The code
            expires shortly after it's issued.
          </Text>

          <Text style={styles.label}>Agent name</Text>
          <TextInput
            testID="paired-devices-agent-name"
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="e.g. my-agent"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {/* §6 — a STAFF phone pairs here too: same ceremony, its own
              caller type, authority only through the Staff screen's grants. */}
          <View style={styles.roleRow}>
            {(['agent', 'node', 'staff'] as const).map((r) => (
              <TouchableOpacity
                key={r}
                style={[styles.roleChip, role === r && styles.roleChipActive]}
                onPress={() => setRole(r)}
                accessibilityRole="button"
                testID={`paired-devices-role-${r}`}
              >
                <Text style={role === r ? styles.roleChipActiveText : styles.roleChipText}>
                  {ROLE_LABEL[r]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/*
            Role picker removed: today every paired entry is a
            interactive coding-agent install, and the legacy `rich` /
            `thin` / `cli` branches aren't wired into mobile. Delegation
            runners have a different privilege boundary and should get a
            separate setup surface rather than a picker that can silently
            mint the wrong authority here.
          */}

          <Pressable
            testID="paired-devices-generate"
            style={[styles.primaryButton, generating && styles.primaryButtonDisabled]}
            disabled={generating}
            onPress={handleGenerate}
            accessibilityRole="button"
          >
            {generating ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>Generate Setup Code</Text>
            )}
          </Pressable>
        </Section>

        {liveCode !== null && (
          <Section title="SETUP CODE">
            <Text style={styles.help}>
              Paste this one string into <Text style={styles.mono}>dina configure</Text> on the
              agent host — it carries the relay address, this node's identity, and the pairing code,
              so there's nothing else to type.
            </Text>
            <Text
              testID="paired-devices-setup-code"
              selectable
              style={styles.setupCode}
            >
              {liveCode.setupCode}
            </Text>
            <Pressable
              testID="paired-devices-share-setup"
              onPress={handleShareSetup}
              style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Share setup code"
            >
              <Text style={styles.copyButtonText}>
                {shareOutcomeLabel(shareOutcome, 'Share Setup Code')}
              </Text>
            </Pressable>
            <Text style={styles.codeMeta}>
              Pairing <Text style={styles.mono}>{liveCode.deviceName}</Text> as{' '}
              <Text style={styles.mono}>
                {ROLE_LABEL[liveCode.role].toLowerCase()}
              </Text>
            </Text>
            <Text style={[styles.codeMeta, secondsRemaining < 60 && styles.codeExpiring]}>
              Expires in {formatDuration(secondsRemaining)}
            </Text>
          </Section>
        )}
      </KeyboardAwareScrollView>
      <PresenceSheet {...presenceSheet} />
    </>
  );
}

/** Each agent's current supervision, from Core's policy list. */
function supervisionByAgent(list: AgentSupervisionPolicies): Record<string, SupervisionState> {
  const out: Record<string, SupervisionState> = {};
  for (const policy of list.stale_policies) {
    // An earlier owner chose it; full supervision applies until the owner
    // confirms a level again, and that change must name this version.
    out[policy.agent_did] = {
      profile: 'full_supervision',
      version: policy.policy_version,
      stale: true,
    };
  }
  for (const policy of list.policies) {
    out[policy.agent_did] = {
      profile: policy.revoked_at === null ? policy.profile : 'full_supervision',
      version: policy.policy_version,
      stale: false,
    };
  }
  return out;
}

function SupervisionPicker(props: {
  device: DeviceRow;
  state: SupervisionState | undefined;
  onChoose: (profile: AgentSupervisionProfile) => void;
}): React.ReactElement {
  const current = props.state?.profile ?? 'full_supervision';
  const chosen = SUPERVISION.find((s) => s.profile === current) ?? SUPERVISION[2];
  return (
    <View testID={`paired-devices-supervision-${props.device.deviceId}`}>
      <Text style={styles.label}>Supervision</Text>
      <View style={styles.roleRow}>
        {SUPERVISION.map((option) => (
          <TouchableOpacity
            key={option.profile}
            style={[styles.roleChip, current === option.profile && styles.roleChipActive]}
            onPress={() => {
              if (option.profile !== current || props.state?.stale === true)
                props.onChoose(option.profile);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: current === option.profile }}
            testID={`paired-devices-supervision-${props.device.deviceId}-${option.profile}`}
          >
            <Text
              style={current === option.profile ? styles.roleChipActiveText : styles.roleChipText}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {props.state?.stale === true && (
        <Text style={styles.brainHelp}>
          This Home Node’s identity changed. Full supervision is active until you choose a level
          again.
        </Text>
      )}
      <Text style={styles.brainHelp}>{chosen?.description}</Text>
    </View>
  );
}

function errorKeyOrMessage(err: unknown): string {
  return err instanceof OwnerSetupHttpError
    ? err.errorKey
    : err instanceof Error
      ? err.message
      : 'error';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.card}>{props.children}</View>
    </View>
  );
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  roleRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 4 },
  roleChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#8886',
  },
  roleChipActive: { backgroundColor: '#4a90d922', borderColor: '#4a90d9' },
  roleChipText: { fontSize: 13, color: '#888' },
  roleChipActiveText: { fontSize: 13, color: '#4a90d9', fontWeight: '600' },
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    ...textStyles.label,
    color: colors.textSecondary,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    marginLeft: spacing.sm,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadows.sm,
  },
  help: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  label: {
    ...textStyles.bodySmallStrong,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    ...textStyles.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: {
    ...textStyles.bodyStrong,
    color: colors.white,
  },
  copyButton: {
    alignSelf: 'center',
    marginTop: spacing.xs,
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  copyButtonPressed: { opacity: 0.7 },
  copyButtonText: textStyles.buttonSmall,
  setupCode: {
    ...textStyles.monoSmall,
    color: colors.textPrimary,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  codeMeta: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  codeExpiring: { color: colors.error },
  empty: {
    ...textStyles.body,
    color: colors.textSecondary,
    fontStyle: 'italic',
    textAlign: 'center',
    padding: spacing.md,
  },
  deviceRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  deviceRowMain: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  deviceName: textStyles.bodyStrong,
  deviceMeta: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  deviceDID: {
    ...textStyles.monoSmall,
    color: colors.textSecondary,
  },
  refreshButton: { alignSelf: 'flex-end', padding: spacing.sm },
  refreshText: {
    ...textStyles.bodySmall,
    color: colors.accent,
  },
  revokeButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.error,
  },
  revokeButtonPressed: { opacity: 0.6 },
  revokeText: {
    ...textStyles.caption,
    color: colors.error,
  },
  brainButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 7,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgPrimary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  brainButtonActive: {
    borderColor: colors.accent,
  },
  brainButtonPressed: { opacity: 0.6 },
  brainButtonText: {
    ...textStyles.caption,
    color: colors.textPrimary,
  },
  brainHelp: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  mono: textStyles.monoSmall,
});
