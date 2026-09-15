export {
  deviceCount,
  getByPublicKey,
  getDevice,
  getDeviceByDID,
  isDeviceActive,
  listActiveDevices,
  listDevices,
  registerDevice,
  resetDeviceRegistry,
  revokeDevice,
  revokeDeviceByDidDurable,
  revokeDeviceDurable,
  revokePluginDeviceForTeardown,
  subscribeToDeviceRegistry,
  touchDevice,
} from './src/devices/registry';
export type {
  AuthType,
  DeviceRole,
  PairedDevice,
  DeviceRevokeResult,
} from './src/devices/registry';
export { generatePairingCode, getPairingIntent, isCodeValid } from './src/pairing/ceremony';
export type { PairingCode } from './src/pairing/ceremony';
