import { createAppViewReasoningEvidenceSource } from '../../src/reasoning/appview_evidence_source';

import type { SearchPeerlensParams } from '../../src/appview_client/http';

describe('createAppViewReasoningEvidenceSource', () => {
  test('maps real attestation rows without disclosing the owner DID', async () => {
    const searchTrust = jest.fn(async (_params: SearchPeerlensParams) => ({
      results: [
        {
          uri: 'at://did:plc:reviewer/com.dinakernel.peerlens.attestation/chair',
          authorDid: 'did:plc:reviewer',
          authorHandle: 'reviewer.example',
          text: 'Strong lumbar support.',
          sentiment: 'positive' as const,
          confidence: 'high' as const,
          category: 'product:chair',
          tags: ['ergonomic'],
          recordCreatedAt: '2026-07-01T10:00:00.000Z',
        },
      ],
      totalEstimate: 1,
    }));
    const source = createAppViewReasoningEvidenceSource({
      searchTrust,
      searchCapabilities: async () => [],
      searchServices: async () => [],
    });

    const reviews = await source.searchReviews({
      query: 'chair'.repeat(100),
      limit: 5,
    });

    expect(searchTrust).toHaveBeenCalledWith({
      q: expect.stringMatching(/^chair/),
      sort: 'relevant',
      limit: 5,
    });
    expect(searchTrust.mock.calls[0]?.[0].q).toHaveLength(200);
    expect(reviews).toEqual([
      expect.objectContaining({
        externalId: 'at://did:plc:reviewer/com.dinakernel.peerlens.attestation/chair',
        text: expect.stringContaining('Strong lumbar support.'),
        confidence: 0.75,
        occurredAtMs: Date.parse('2026-07-01T10:00:00.000Z'),
      }),
    ]);
  });

  test('discovers only locally routable official capabilities and deduplicates in Core', async () => {
    const searchServices = jest.fn(async () => [
      {
        did: 'did:plc:salon',
        handle: 'salon.example',
        name: 'Alonso Salon',
        description: 'Appointment booking.',
        capabilities: ['appointment_book'],
        isDiscoverable: true,
        uri: 'at://did:plc:salon/com.dinakernel.service.profile/main',
      },
    ]);
    const source = createAppViewReasoningEvidenceSource({
      searchTrust: async () => ({ results: [], totalEstimate: 0 }),
      searchCapabilities: async () => [
        {
          canonical: 'appointment_book',
          description: 'Book an appointment',
          domain: 'appointments',
        },
        {
          canonical: 'com.example.private_capability',
          description: 'Custom',
          domain: 'custom',
        },
      ],
      searchServices,
    });

    const services = await source.searchServices({
      query: 'book a haircut',
      limit: 5,
    });

    expect(searchServices).toHaveBeenCalledTimes(1);
    expect(searchServices).toHaveBeenCalledWith({
      capability: 'appointment_book',
      limit: 5,
    });
    expect(services).toEqual([
      {
        externalId: 'at://did:plc:salon/com.dinakernel.service.profile/main',
        text: expect.stringContaining('Service: Alonso Salon'),
      },
    ]);
  });

  test('keeps successful service evidence when another capability search fails', async () => {
    const searchServices = jest.fn(async ({ capability }: { capability: string }) => {
      if (capability === 'appointment_book') {
        throw new Error('appointments shard unavailable');
      }
      return [
        {
          did: 'did:plc:bus',
          handle: 'bus.example',
          name: 'Bus 42',
          description: 'Live arrival estimates.',
          capabilities: ['eta_query'],
          isDiscoverable: true,
          uri: 'at://did:plc:bus/com.dinakernel.service.profile/main',
        },
      ];
    });
    const source = createAppViewReasoningEvidenceSource({
      searchTrust: async () => ({ results: [], totalEstimate: 0 }),
      searchCapabilities: async () => [
        {
          canonical: 'appointment_book',
          description: 'Book an appointment',
          domain: 'appointments',
        },
        {
          canonical: 'eta_query',
          description: 'Check an arrival estimate',
          domain: 'transport',
        },
      ],
      searchServices,
    });

    await expect(
      source.searchServices({
        query: 'book or check a bus',
        limit: 5,
      }),
    ).resolves.toEqual([
      {
        externalId: 'at://did:plc:bus/com.dinakernel.service.profile/main',
        text: expect.stringContaining('Service: Bus 42'),
      },
    ]);
  });

  test('reports total service-search failure instead of pretending there were no matches', async () => {
    const source = createAppViewReasoningEvidenceSource({
      searchTrust: async () => ({ results: [], totalEstimate: 0 }),
      searchCapabilities: async () => [
        {
          canonical: 'appointment_book',
          description: 'Book an appointment',
          domain: 'appointments',
        },
      ],
      searchServices: async () => {
        throw new Error('service AppView unavailable');
      },
    });

    await expect(
      source.searchServices({
        query: 'book',
        limit: 5,
      }),
    ).rejects.toThrow('service AppView unavailable');
  });
});
