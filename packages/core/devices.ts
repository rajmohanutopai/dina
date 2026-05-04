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
  touchDevice,
} from './src/devices/registry';
export type { AuthType, DeviceRole, PairedDevice } from './src/devices/registry';
export { generatePairingCode } from './src/pairing/ceremony';
export type { PairingCode } from './src/pairing/ceremony';
