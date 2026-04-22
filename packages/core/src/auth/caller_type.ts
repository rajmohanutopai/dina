/**
 * Caller type resolution — map authenticated DID to caller type.
 *
 * After Ed25519 auth middleware validates the request signature,
 * this module determines WHAT the caller is:
 *
 *   service  — Brain process, admin, connector (known service DIDs)
 *   device   — Paired device with role in { rich, thin, cli }
 *   agent    — Paired device with role='agent' OR forwarded agent DID
 *              (X-Agent-DID header, legacy brain-forwarding pattern)
 *   unknown  — Unrecognized DID (auth valid but caller not registered)
 *
 * This determines authorization scope — services get full API access,
 * devices get user-facing endpoints, agents get delegated permissions
 * specifically for the workflow-task claim/heartbeat/complete pull loop.
 *
 * Source: ARCHITECTURE.md Section 2.10
 */

export type CallerType = 'service' | 'device' | 'agent' | 'unknown';

/**
 * Optional callback: given a DID, return the device role or null if the
 * DID isn't in the device registry. Wired by startup to
 * `getDeviceByDID(did)?.role ?? null`. When null, the device-vs-agent
 * distinction collapses to generic 'device' (backward-compatible for
 * tests + pre-agent deployments).
 */
type DeviceRoleResolver = (did: string) => string | null;
let deviceRoleResolver: DeviceRoleResolver | null = null;

export function setDeviceRoleResolver(resolver: DeviceRoleResolver | null): void {
  deviceRoleResolver = resolver;
}

export interface CallerIdentity {
  did: string;
  callerType: CallerType;
  name?: string;
}

/** Registered service DIDs (Brain, admin, connectors). */
const serviceDIDs = new Map<string, string>();

/** Registered device DIDs (paired devices). */
const deviceDIDs = new Map<string, string>();

/**
 * Register a service DID (Brain, admin, connector).
 *
 * Services get full Core API access. Typically registered at startup.
 */
export function registerService(did: string, name: string): void {
  serviceDIDs.set(did, name);
}

/**
 * Register a paired device DID.
 *
 * Devices get user-facing API endpoints. Registered via pairing ceremony.
 */
export function registerDevice(did: string, name: string): void {
  deviceDIDs.set(did, name);
}

/** Unregister a device (revocation). */
export function unregisterDevice(did: string): void {
  deviceDIDs.delete(did);
}

/**
 * Resolve caller type from an authenticated DID.
 *
 * Priority:
 * 1. Check service registry (Brain, connectors)
 * 2. Check device registry (paired devices)
 * 3. Check for X-Agent-DID header (forwarded agent)
 * 4. Unknown
 *
 * @param authenticatedDID — the DID from the validated X-DID header
 * @param agentDID — optional X-Agent-DID header value (agent forwarding)
 */
export function resolveCallerType(authenticatedDID: string, agentDID?: string): CallerIdentity {
  // Service DIDs (Brain, admin, connectors)
  const serviceName = serviceDIDs.get(authenticatedDID);
  if (serviceName !== undefined) {
    // If a service forwards an agent DID, the caller is the agent
    if (agentDID) {
      return { did: agentDID, callerType: 'agent', name: `agent via ${serviceName}` };
    }
    return { did: authenticatedDID, callerType: 'service', name: serviceName };
  }

  // Paired devices — role='agent' resolves to callerType='agent' so the
  // workflow-task pull endpoints can scope-check correctly. Other roles
  // (rich/thin/cli) resolve to the generic 'device' caller type.
  const deviceName = deviceDIDs.get(authenticatedDID);
  if (deviceName !== undefined) {
    const role = deviceRoleResolver?.(authenticatedDID) ?? null;
    if (role === 'agent') {
      return { did: authenticatedDID, callerType: 'agent', name: deviceName };
    }
    return { did: authenticatedDID, callerType: 'device', name: deviceName };
  }

  // Unknown — auth valid but caller not registered
  return { did: authenticatedDID, callerType: 'unknown' };
}

/** Check if a DID is a registered service. */
export function isService(did: string): boolean {
  return serviceDIDs.has(did);
}

/** Check if a DID is a registered device. */
export function isDevice(did: string): boolean {
  return deviceDIDs.has(did);
}

/** List all registered services. */
export function listServices(): Array<{ did: string; name: string }> {
  return [...serviceDIDs.entries()].map(([did, name]) => ({ did, name }));
}

/** List all registered devices. */
export function listDevices(): Array<{ did: string; name: string }> {
  return [...deviceDIDs.entries()].map(([did, name]) => ({ did, name }));
}

/** Reset all registries (for testing). */
export function resetCallerTypeState(): void {
  serviceDIDs.clear();
  deviceDIDs.clear();
  deviceRoleResolver = null;
}
