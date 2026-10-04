/** The A2A gateway's public surface (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1). */

export { bootGateway, ServiceKeyError, type BootedGateway } from './boot';
export { ConfigError, loadConfig, type GatewayConfig } from './config';
export { createCoreLink, isClientAnswer, type CoreLink, type CoreReply } from './core_link';
export { EdgeLimiter } from './edge_limit';
export { ensureServiceKey } from './keygen';
export { AGENT_CARD_PATH, buildGatewayServer, type GatewayServerDeps } from './server';
export { loadServiceKey, type GatewayServiceKey } from './service_key';
