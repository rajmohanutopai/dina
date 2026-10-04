/**
 * @dina/a2a — Dina's A2A v1.0 edge contract (docs/A2A_GATEWAY_ARCHITECTURE.md).
 *
 * Zero runtime dependencies; crypto arrives as injected callbacks so the
 * same code runs in Core, the gateway, AppView, and on Hermes.
 */

export * from './constants';
export * from './json';
export * from './strict_json';
export * from './unicode';
export * from './jcs';
export * from './base64url';
export * from './base64';
export * from './types';
export * from './errors';
export * from './jsonrpc';
export * from './ingress_routes';
export * from './delivery';
export * from './rest_binding';
export * from './multikey';
export * from './outbound_url';
export * from './did_auth';
export * from './service_params';
export * from './validate';
export * from './card';
export * from './jws';
export * from './state_map';
export * from './envelope';
export * from './result';
export * from './card_projection';
export * from './dina_card';
export * from './directory_envelope';
export * from './card_record';
export * from './lanes';
export * from './ids';
