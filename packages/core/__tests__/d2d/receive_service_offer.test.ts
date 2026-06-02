/**
 * service.offer ingress tests (protocol v1.1) — a provider sharing a
 * known_only listing directly with a contact over D2D. The receive pipeline
 * accepts it ONLY from an established contact, validates the body, and persists
 * it as contact metadata (contact_service_offers) via the global offer repo —
 * it is NEVER staged to the vault.
 */

import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetStagingState } from '../../src/staging/service';
import { resetAuditState } from '../../src/audit/service';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { clearReplayCache } from '../../src/transport/adversarial';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  setServiceOfferRepository,
  type ServiceOffer,
  type ServiceOfferRepository,
} from '../../src/contacts/service_offers_repository';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const recipientPriv = new Uint8Array(32).fill(0x42);
const recipientPub = getPublicKey(recipientPriv);

const PROVIDER_DID = 'did:plc:dentist';

const offerBody = {
  grant_id: 'offer-1',
  capability: 'appointment_status',
  service_name: 'Dr Carl (private)',
  service_uri: 'at://did:plc:dentist/com.dinakernel.service.profile/appts',
  schema_hash: 'sha256:canonical',
  params_schema: { type: 'object' },
  default_ttl_seconds: 120,
};

function buildSealed(body: unknown, overrides?: Partial<DinaMessage>) {
  const msg: DinaMessage = {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'service.offer',
    from: PROVIDER_DID,
    to: 'did:plc:recipient',
    created_time: Date.now(),
    body: JSON.stringify(body),
    ...overrides,
  };
  return sealMessage(msg, senderPriv, recipientPub);
}

/** In-memory ServiceOfferRepository capturing upserts. */
function stubRepo(): { repo: ServiceOfferRepository; stored: ServiceOffer[] } {
  const stored: ServiceOffer[] = [];
  const repo: ServiceOfferRepository = {
    upsert: (o) => {
      stored.push(o);
    },
    listByProviderDid: (did) => stored.filter((o) => o.providerDid === did),
    findByProviderDidAndCapability: (did, cap) =>
      stored.filter((o) => o.providerDid === did && o.capability === cap),
    listAll: () => stored,
    get: (id) => stored.find((o) => o.grantId === id) ?? null,
    remove: () => false,
  };
  return { repo, stored };
}

beforeEach(() => {
  clearGatesState();
  resetStagingState();
  resetAuditState();
  resetQuarantineState();
  clearReplayCache();
  setServiceOfferRepository(null);
});

afterAll(() => {
  setServiceOfferRepository(null);
});

describe('receive_pipeline — service.offer ingress', () => {
  it('accepts + persists an offer from an established contact', () => {
    const { repo, stored } = stubRepo();
    setServiceOfferRepository(repo);
    const result = receiveD2D(buildSealed(offerBody), recipientPub, recipientPriv, [senderPub], 'verified');

    expect(result.action).toBe('bypassed');
    expect(result.messageType).toBe('service.offer');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      grantId: 'offer-1',
      providerDid: PROVIDER_DID, // keyed by the sender DID
      capability: 'appointment_status',
      serviceUri: offerBody.service_uri,
      schemaHash: 'sha256:canonical',
    });
    expect(stored[0].paramsSchema).toEqual({ type: 'object' });
  });

  it('REJECTS an offer from a non-contact (known_only is contacts-only)', () => {
    const { repo, stored } = stubRepo();
    setServiceOfferRepository(repo);
    const result = receiveD2D(buildSealed(offerBody), recipientPub, recipientPriv, [senderPub], 'unknown');

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/not a known contact/);
    expect(stored).toHaveLength(0);
  });

  it('DROPS an offer with an invalid body', () => {
    const { repo, stored } = stubRepo();
    setServiceOfferRepository(repo);
    // missing service_uri (required)
    const bad = { grant_id: 'x', capability: 'eta_query', service_name: 'X' };
    const result = receiveD2D(buildSealed(bad), recipientPub, recipientPriv, [senderPub], 'verified');

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/service\.offer invalid/);
    expect(stored).toHaveLength(0);
  });

  it('DROPS when no offer store is wired (forward-compat: node ignores offers)', () => {
    setServiceOfferRepository(null);
    const result = receiveD2D(buildSealed(offerBody), recipientPub, recipientPriv, [senderPub], 'verified');
    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/offer store not wired/);
  });

  it("DROPS an offer whose service_uri belongs to a DIFFERENT did than the sender", () => {
    // A (bad/misconfigured) provider must not push an offer pointing at someone
    // else's listing into our trusted contact-service surface. The service_uri
    // authority must equal the sender DID.
    const { repo, stored } = stubRepo();
    setServiceOfferRepository(repo);
    const spoofed = {
      ...offerBody,
      service_uri: 'at://did:plc:someoneelse/com.dinakernel.service.profile/x',
    };
    const result = receiveD2D(buildSealed(spoofed), recipientPub, recipientPriv, [senderPub], 'verified');
    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/service_uri authority/);
    expect(stored).toHaveLength(0);
  });
});
