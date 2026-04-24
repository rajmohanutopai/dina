/**
 * `search_trust_network` tool — deterministic plumbing around the
 * AppView trust xRPCs. Real-AppView integration is a separate concern;
 * this file pins the arg parsing + branch logic + failure envelopes.
 */

import { createSearchTrustNetworkTool } from '../../src/reasoning/trust_tool';
import type { TrustAppViewClient } from '../../src/reasoning/trust_tool';

function stubClient(overrides?: Partial<TrustAppViewClient>): TrustAppViewClient {
  return {
    resolveTrust: jest.fn(async () => ({
      subjectType: 'product',
      trustLevel: 'trusted',
      confidence: 0.9,
      attestationSummary: { total: 10, positive: 8, neutral: 1, negative: 1, averageDimensions: {} },
      flags: [],
      authenticity: null,
      graphContext: null,
      recommendation: 'proceed',
      reasoning: 'Strong peer consensus',
    })),
    searchTrust: jest.fn(async () => ({
      results: [
        {
          uri: 'at://did:plc:alice/com.dina.trust.attestation/1',
          authorDid: 'did:plc:alice',
          sentiment: 'positive' as const,
          confidence: 'high' as const,
        },
      ],
      cursor: undefined,
      totalEstimate: 1,
    })),
    ...overrides,
  };
}

describe('createSearchTrustNetworkTool', () => {
  it('throws when neither subject nor query is provided', async () => {
    const tool = createSearchTrustNetworkTool({ appViewClient: stubClient() });
    await expect(tool.execute({})).rejects.toThrow(/subject.*query/);
  });

  it('routes a subject to resolveTrust and returns the aggregate envelope', async () => {
    const client = stubClient();
    const tool = createSearchTrustNetworkTool({ appViewClient: client });
    const subject = JSON.stringify({ type: 'product', domain: 'amazon.com', productId: 'B0' });
    const raw = await tool.execute({ subject });
    const result = raw as { subject: { trustLevel: string; recommendation: string } };
    expect(result.subject.trustLevel).toBe('trusted');
    expect(result.subject.recommendation).toBe('proceed');
    expect(client.resolveTrust).toHaveBeenCalledWith(
      expect.objectContaining({ subject }),
    );
  });

  it('routes a query to searchTrust and filters pass-through', async () => {
    const client = stubClient();
    const tool = createSearchTrustNetworkTool({ appViewClient: client });
    const raw = await tool.execute({
      query: 'standing desk reviews',
      subjectType: 'product',
      minConfidence: 'high',
      sentiment: 'positive',
      limit: 25,
    });
    const result = raw as { search: { results: unknown[] } };
    expect(result.search.results).toHaveLength(1);
    expect(client.searchTrust).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'standing desk reviews',
        subjectType: 'product',
        minConfidence: 'high',
        sentiment: 'positive',
        limit: 25,
      }),
    );
  });

  it('runs both resolveTrust + searchTrust when both args supplied', async () => {
    const client = stubClient();
    const tool = createSearchTrustNetworkTool({ appViewClient: client });
    const raw = await tool.execute({
      subject: JSON.stringify({ type: 'did', did: 'did:plc:vendor' }),
      query: 'vendor reviews',
    });
    const result = raw as { subject: unknown; search: unknown };
    expect(result.subject).toBeDefined();
    expect(result.search).toBeDefined();
    expect(client.resolveTrust).toHaveBeenCalledTimes(1);
    expect(client.searchTrust).toHaveBeenCalledTimes(1);
  });

  it('forwards requesterDid + context to resolveTrust', async () => {
    const client = stubClient();
    const tool = createSearchTrustNetworkTool({
      appViewClient: client,
      requesterDid: 'did:plc:alonso',
    });
    await tool.execute({
      subject: JSON.stringify({ type: 'did', did: 'did:plc:sancho' }),
      context: 'before-transaction',
      domain: 'amazon.com',
    });
    expect(client.resolveTrust).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterDid: 'did:plc:alonso',
        context: 'before-transaction',
        domain: 'amazon.com',
      }),
    );
  });

  it('surfaces a graceful note when resolveTrust throws', async () => {
    const client = stubClient({
      resolveTrust: jest.fn(async () => {
        throw new Error('appview 503');
      }),
    });
    const tool = createSearchTrustNetworkTool({ appViewClient: client });
    const raw = await tool.execute({ subject: JSON.stringify({ type: 'did', did: 'did:plc:x' }) });
    const result = raw as { subject?: unknown; note?: string };
    expect(result.subject).toBeUndefined();
    expect(result.note).toMatch(/no verified peer data/i);
  });

  it('surfaces a graceful note when searchTrust throws', async () => {
    const client = stubClient({
      searchTrust: jest.fn(async () => {
        throw new Error('appview timeout');
      }),
    });
    const tool = createSearchTrustNetworkTool({ appViewClient: client });
    const raw = await tool.execute({ query: 'anything' });
    const result = raw as { search?: unknown; note?: string };
    expect(result.search).toBeUndefined();
    expect(result.note).toMatch(/no verified peer data/i);
  });

  it('drops invalid enum values instead of forwarding them', async () => {
    const client = stubClient();
    const tool = createSearchTrustNetworkTool({ appViewClient: client });
    await tool.execute({
      query: 'laptops',
      subjectType: 'bogus-type',
      sentiment: 'happy',
      minConfidence: 'maybe',
      context: 'nonsense',
    });
    const call = (client.searchTrust as jest.Mock).mock.calls[0][0];
    expect(call).not.toHaveProperty('subjectType');
    expect(call).not.toHaveProperty('sentiment');
    expect(call).not.toHaveProperty('minConfidence');
  });
});
