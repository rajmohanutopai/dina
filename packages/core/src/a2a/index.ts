/**
 * Core's A2A modules (docs/A2A_GATEWAY_ARCHITECTURE.md §4.2). The wire
 * contract itself lives in `@dina/a2a`.
 */

export * from './action_registry';
export * from './card_keys';
export * from './clients';
export * from './credentials';
export * from './delivery';
export * from './digest';
export * from './dispatch';
export * from './did_binding';
export * from './did_replay';
export * from './dispatch_binding';
export * from './entities';
export * from './guard_jobs';
export * from './operation_end';
export * from './host_transport';
export * from './ids';
export * from './inbound';
export * from './inbound_children';
export * from './inbound_turns';
export * from './inbound_card';
export * from './inbound_review_card';
export * from './inbound_resolve';
export * from './inbound_view';
export * from './ingress_common';
export * from './ingress_outcome';
export * from './normalize';
export * from './runtime';
export * from './permits';
export * from './directory_evidence';
export * from './publication';
export * from './proposal';
export * from './push_configs';
export * from './provenance';
export * from './provenance_text';
export * from './receipts';
export * from './release_log';
export * from './remote_agents';
export * from './result_ingest';
export * from './runner_bindings';
export * from './skill_bindings';
export * from './store';
