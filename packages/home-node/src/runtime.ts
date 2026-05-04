import type {
  AskInput,
  AskResult,
  CreateHomeNodeRuntimeOptions,
  HomeNodeDependencyStatus,
  HomeNodeFeature,
  HomeNodeRuntime,
  HomeNodeRuntimeContext,
  HomeNodeRunState,
  RememberInput,
  RememberResult,
  ServiceQueryInput,
  ServiceQueryResult,
  TrustPublishInput,
  TrustPublishResult,
} from './types';

export class HomeNodeFeatureUnavailableError extends Error {
  constructor(public readonly feature: HomeNodeFeature) {
    super(`HomeNodeRuntime feature is not wired: ${feature}`);
    this.name = 'HomeNodeFeatureUnavailableError';
  }
}

export function createHomeNodeRuntime(options: CreateHomeNodeRuntimeOptions): HomeNodeRuntime {
  validateOptions(options);
  return new DelegatingHomeNodeRuntime(options);
}

class DelegatingHomeNodeRuntime implements HomeNodeRuntime {
  private state: HomeNodeRunState = 'created';
  private readonly context: HomeNodeRuntimeContext;

  constructor(private readonly options: CreateHomeNodeRuntimeOptions) {
    this.context = {
      nodeId: options.nodeId,
      formFactor: options.formFactor,
      endpoints: { ...options.endpoints },
    };
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    this.state = 'starting';
    try {
      await this.options.lifecycle?.start?.(this.context);
      this.state = 'running';
    } catch (err) {
      this.state = 'failed';
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'created' || this.state === 'stopping') {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopping';
    try {
      await this.options.lifecycle?.stop?.(this.context);
      this.state = 'stopped';
    } catch (err) {
      this.state = 'failed';
      throw err;
    }
  }

  async status() {
    const dependencies = (await this.options.lifecycle?.dependencies?.(this.context)) ?? {};
    return {
      nodeId: this.context.nodeId,
      formFactor: this.context.formFactor,
      state: this.state,
      endpoints: { ...this.context.endpoints },
      features: featureStatus(this.options),
      dependencies,
    };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const handler = this.options.handlers?.remember;
    if (!handler) throw new HomeNodeFeatureUnavailableError('remember');
    return handler(input, this.context);
  }

  async ask(input: AskInput): Promise<AskResult> {
    const handler = this.options.handlers?.ask;
    if (!handler) throw new HomeNodeFeatureUnavailableError('ask');
    return handler(input, this.context);
  }

  async publishTrust(input: TrustPublishInput): Promise<TrustPublishResult> {
    const handler = this.options.handlers?.publishTrust;
    if (!handler) throw new HomeNodeFeatureUnavailableError('trust_publish');
    return handler(input, this.context);
  }

  async queryService(input: ServiceQueryInput): Promise<ServiceQueryResult> {
    const handler = this.options.handlers?.queryService;
    if (!handler) throw new HomeNodeFeatureUnavailableError('service_query');
    return handler(input, this.context);
  }
}

function validateOptions(options: CreateHomeNodeRuntimeOptions): void {
  if (options.nodeId.trim() === '') {
    throw new Error('createHomeNodeRuntime: nodeId is required');
  }
}

function featureStatus(
  options: CreateHomeNodeRuntimeOptions,
): Record<HomeNodeFeature, HomeNodeDependencyStatus> {
  return {
    remember: options.handlers?.remember ? { state: 'ready' } : missing('remember'),
    ask: options.handlers?.ask ? { state: 'ready' } : missing('ask'),
    trust_publish: options.handlers?.publishTrust ? { state: 'ready' } : missing('trust_publish'),
    service_query: options.handlers?.queryService ? { state: 'ready' } : missing('service_query'),
  };
}

function missing(feature: HomeNodeFeature): HomeNodeDependencyStatus {
  return { state: 'missing', detail: `${feature} handler is not wired` };
}
