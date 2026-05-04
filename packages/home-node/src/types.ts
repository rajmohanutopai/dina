import type { HostedDinaEndpoints } from './endpoints';

export type HomeNodeFormFactor = 'mobile' | 'server';
export type HomeNodeRunState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type HomeNodeFeature = 'remember' | 'ask' | 'trust_publish' | 'service_query';

export interface HomeNodeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HomeNodeDependencyStatus {
  state: 'ready' | 'degraded' | 'missing';
  detail?: string;
}

export interface HomeNodeStatus {
  nodeId: string;
  formFactor: HomeNodeFormFactor;
  state: HomeNodeRunState;
  endpoints: HostedDinaEndpoints;
  features: Record<HomeNodeFeature, HomeNodeDependencyStatus>;
  dependencies: Record<string, HomeNodeDependencyStatus>;
}

export interface RememberInput {
  text: string;
  source?: string;
  sourceId?: string;
  requesterDid?: string;
  metadata?: Record<string, unknown>;
}

export interface RememberResult {
  status: 'stored' | 'accepted' | 'pending_approval' | 'failed';
  stagingId?: string;
  message?: string;
  error?: string;
}

export interface AskInput {
  question: string;
  requesterDid: string;
  requestId?: string;
  ttlMs?: number;
}

export interface AskResult {
  status: 'complete' | 'pending' | 'pending_approval' | 'failed';
  requestId: string;
  answer?: { text: string };
  error?: string;
}

export interface TrustPublishInput {
  subjectDid: string;
  category: string;
  rating: number;
  note?: string;
}

export interface TrustPublishResult {
  status: 'queued' | 'published' | 'failed';
  recordUri?: string;
  error?: string;
}

export interface ServiceQueryInput {
  toDid: string;
  capability: string;
  params: Record<string, unknown>;
}

export interface ServiceQueryResult {
  status: 'started' | 'pending_approval' | 'failed';
  taskId?: string;
  error?: string;
}

export interface HomeNodeRuntime extends HomeNodeLifecycle {
  status(): Promise<HomeNodeStatus>;
  remember(input: RememberInput): Promise<RememberResult>;
  ask(input: AskInput): Promise<AskResult>;
  publishTrust(input: TrustPublishInput): Promise<TrustPublishResult>;
  queryService(input: ServiceQueryInput): Promise<ServiceQueryResult>;
}

export interface HomeNodeRuntimeContext {
  nodeId: string;
  formFactor: HomeNodeFormFactor;
  endpoints: HostedDinaEndpoints;
}

export type HomeNodeHandler<I, O> = (
  input: I,
  context: HomeNodeRuntimeContext,
) => Promise<O> | O;

export interface HomeNodeRuntimeHandlers {
  remember?: HomeNodeHandler<RememberInput, RememberResult>;
  ask?: HomeNodeHandler<AskInput, AskResult>;
  publishTrust?: HomeNodeHandler<TrustPublishInput, TrustPublishResult>;
  queryService?: HomeNodeHandler<ServiceQueryInput, ServiceQueryResult>;
}

export interface HomeNodeRuntimeLifecycleHooks {
  start?: (context: HomeNodeRuntimeContext) => Promise<void> | void;
  stop?: (context: HomeNodeRuntimeContext) => Promise<void> | void;
  dependencies?: (context: HomeNodeRuntimeContext) =>
    | Promise<Record<string, HomeNodeDependencyStatus>>
    | Record<string, HomeNodeDependencyStatus>;
}

export interface CreateHomeNodeRuntimeOptions {
  nodeId: string;
  formFactor: HomeNodeFormFactor;
  endpoints: HostedDinaEndpoints;
  handlers?: HomeNodeRuntimeHandlers;
  lifecycle?: HomeNodeRuntimeLifecycleHooks;
}
