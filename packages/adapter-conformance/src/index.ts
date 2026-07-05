/**
 * @dina/adapter-conformance — one behavioral contract suite, two runners.
 *
 * Framework-agnostic conformance cases run against BOTH adapter
 * implementations so a silent native-runtime divergence (e.g. op-sqlite's
 * `run()` returning a constant instead of real rows-affected, or
 * react-native-argon2 producing a different KEK than hash-wasm) is caught in a
 * harness instead of on a user's device.
 *
 * - Node/CI runner: a jest test in each `-node` package imports the cases,
 *   builds its adapter, and runs each as an `it()`.
 * - Device runner: an env-gated in-app screen builds the real expo adapters
 *   and renders a Maestro-assertable PASS/FAIL report.
 */

export * from './assert';
export * from './case';
export * from './types';
export * from './storage_cases';
