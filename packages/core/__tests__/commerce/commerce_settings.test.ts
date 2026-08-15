/**
 * WS-7.2 / WS-7.3 — buyer and supplier settings (§18.2, §18.3, §19).
 *
 * Settings are POLICY, and policy is an input to refusals. The tests are
 * therefore about what the node does with a setting, not about whether a form
 * round-trips: a fan-out ceiling that only a phone knows is a ceiling that
 * stops applying when the server acts.
 */

import { validateMoney } from '@dina/commerce-protocol';

import {
  effectiveFanoutCeiling,
  quoteAdmissibility,
  validateBuyerSettings,
  validateSupplierSettings,
  type BuyerSettings,
  type SupplierSettings,
} from '../../src/commerce/commerce_settings';
import { MAX_QUOTE_FANOUT } from '../../src/commerce/quote_fanout';

function buyer(overrides: Partial<BuyerSettings> = {}): BuyerSettings {
  return {
    actingIdentityDid: 'did:plc:sancho',
    locations: [],
    preferredSuppliers: [],
    blockedSuppliers: [],
    allowedCategoryIds: [],
    quoteFanoutCeiling: 5,
    approvalPolicySummary: 'Every order over ₹10,000 needs your approval.',
    currency: 'INR',
    preferredUnitCodes: ['each'],
    publishReviews: false,
    ...overrides,
  };
}

function supplier(overrides: Partial<SupplierSettings> = {}): SupplierSettings {
  return {
    actingBusinessDid: 'did:plc:chairmaker99',
    catalogSource: { kind: 'inline', lastHealthyAtIso: '2026-08-08T09:00:00.000Z' },
    publicRegions: [],
    publishIndicativePrice: true,
    quoteAccess: 'anyone',
    responsePolicy: { submit_order: 'review' },
    customerPricingSource: null,
    // `auto`, because `review` is REFUSED until the §15.2b approval card and
    // owner decision route exist. This is the base every other test in the
    // file builds on, so it has to be a configuration a real owner could
    // actually save.
    orderAcceptance: 'auto',
    listingState: 'live',
    connectors: [],
    ...overrides,
  };
}

describe('the fields that gate whether this business sells at all', () => {
  /**
   * These three decide whether the node answers quotes and accepts orders, and
   * NONE of them was validated. Only `responsePolicy` was — with a comment
   * saying "fail closed on an unknown policy rather than defaulting to auto",
   * applied to the least consequential of the four.
   *
   * The failure was OPEN in every case, because each reader compares against
   * the exact permissive spelling and falls through to permissive on anything
   * else. An owner who typed "Paused" kept selling.
   */
  it.each([
    ['listingState', 'Paused', 'unknown_listing_state'],
    ['listingState', 'closed', 'unknown_listing_state'],
    ['quoteAccess', 'noone', 'unknown_quote_access'],
    ['quoteAccess', 'Anyone', 'unknown_quote_access'],
    ['orderAcceptance', 'Auto', 'unknown_order_acceptance'],
  ])('refuses %s = %p rather than reading it as permissive', (field, value, refusal) => {
    const verdict = validateSupplierSettings(supplier({ [field]: value } as never));
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.findings.map((f) => f.refusal)).toContain(refusal);
  });

  it.each([
    ['listingState', 'Paused'],
    ['quoteAccess', 'noone'],
  ])('refuses the write, so the row never reaches a reader: %s = %p', (field, value) => {
    // SCOPE, stated precisely, because the first version of this test claimed
    // more than it drove. It said "no caller reaches the permissive answer
    // with it" while only calling the validator — and the claim was false:
    // `refuseProbing` guarded its listing gate on `configured.ok` and fell
    // THROUGH to answering when a row failed to validate, so widening the
    // validator turned a dishonoured pause into a dishonoured pause plus a
    // node that resumed quoting.
    //
    // What this test proves is the write refusal and nothing more. The
    // read-path half is proved where it lives, by driving the ingress entry
    // point: see "an unreadable listing policy closes quoting" in
    // `__tests__/plugins/provider_ingress.test.ts`.
    const verdict = validateSupplierSettings(supplier({ [field]: value } as never));
    expect(verdict.ok).toBe(false);
  });

  it('ACCEPTS order review, now that the §15.2b lane exists', () => {
    // This asserted the opposite while the lane was missing, and the refusal
    // was right at the time: `review` had one reachable outcome, rejection at
    // the decision deadline without asking anyone. The card
    // (`commerce_pending_decisions`) and the owner route
    // (`POST /v1/commerce/orders/decide`) now exist, so the policy does what
    // its name says and the refusal is gone.
    expect(validateSupplierSettings(supplier({ orderAcceptance: 'review' }))).toEqual({ ok: true });
  });

  it('accepts every legal value of all three', () => {
    for (const listingState of ['live', 'paused', 'withdrawn'] as const) {
      for (const quoteAccess of ['anyone', 'known_only', 'nobody'] as const) {
        expect(validateSupplierSettings(supplier({ listingState, quoteAccess }))).toEqual({
          ok: true,
        });
      }
    }
  });
});

describe('buyer settings', () => {
  it('accepts an ordinary configuration', () => {
    expect(validateBuyerSettings(buyer())).toEqual({ ok: true });
  });

  it('REFUSES a fan-out ceiling above the protocol maximum rather than clamping it', () => {
    // The planner clamps defensively at dispatch time; this runs where the
    // OWNER TYPES the number. Silently turning 50 into 8 leaves them believing
    // something about their node that is not true, and they would only find out
    // when a supplier they expected to hear from never answered.
    const verdict = validateBuyerSettings(buyer({ quoteFanoutCeiling: 50 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.findings[0]).toMatchObject({
      refusal: 'fanout_above_protocol_maximum',
      field: 'quoteFanoutCeiling',
    });
  });

  it('refuses a ceiling below one, which is a pause wearing a number', () => {
    const verdict = validateBuyerSettings(buyer({ quoteFanoutCeiling: 0 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.findings[0]?.refusal).toBe('fanout_below_one');
  });

  it('refuses a supplier that is both preferred and blocked', () => {
    // Not resolved by precedence: either answer is a guess about what the
    // owner meant, and the guess that prefers a blocked supplier sends them
    // business they said they did not want.
    const verdict = validateBuyerSettings(
      buyer({ preferredSuppliers: ['did:plc:x'], blockedSuppliers: ['did:plc:x'] }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.findings[0]?.refusal).toBe('supplier_both_preferred_and_blocked');
  });

  it('refuses an empty acting identity', () => {
    const verdict = validateBuyerSettings(buyer({ actingIdentityDid: '' }));
    expect(verdict.ok).toBe(false);
  });

  it('reports every finding rather than the first', () => {
    // An owner fixing a settings screen one refusal at a time is an owner who
    // gives up on the third round trip.
    const verdict = validateBuyerSettings(
      buyer({
        actingIdentityDid: '',
        quoteFanoutCeiling: 99,
        preferredSuppliers: ['did:plc:x'],
        blockedSuppliers: ['did:plc:x'],
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusals');
    expect(verdict.findings).toHaveLength(3);
  });

  it('takes the LOWER of the owner ceiling and the protocol maximum', () => {
    // Both bounds exist for different reasons — a preference and a limit on
    // what one tap may do to other people's nodes — so neither overrides the
    // other.
    expect(effectiveFanoutCeiling(buyer({ quoteFanoutCeiling: 3 }))).toBe(3);
    expect(effectiveFanoutCeiling(buyer({ quoteFanoutCeiling: 999 }))).toBe(MAX_QUOTE_FANOUT);
  });
});

describe('supplier settings', () => {
  it('accepts an ordinary configuration', () => {
    expect(validateSupplierSettings(supplier())).toEqual({ ok: true });
  });

  it('fails closed on a response policy it does not recognise', () => {
    // An unrecognised value means this build does not know what the owner
    // asked for. Defaulting to `auto` would answer customers automatically on
    // a guess, which is the expensive reading.
    const verdict = validateSupplierSettings(
      supplier({ responsePolicy: { submit_order: 'whenever' as never } }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.findings[0]).toMatchObject({
      refusal: 'unknown_response_policy',
      field: 'responsePolicy.submit_order',
    });
  });

  it.each(['api_key', 'secret', 'token', 'password', 'privateKey'])(
    'refuses a connector entry carrying %s',
    (key) => {
      // §18.3 asks for credential STATUS. A settings record is the most-read,
      // most-exported, most-synced object a node has; it is the last place a
      // secret should be able to reach.
      const verdict = validateSupplierSettings(
        supplier({
          connectors: [
            {
              name: 'erp',
              healthy: true,
              credentialValid: true,
              lastCheckedAtIso: null,
              [key]: 'sk-live-0123456789',
            } as never,
          ],
        }),
      );
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('expected a refusal');
      expect(verdict.findings[0]?.refusal).toBe('credential_material_present');
      // The finding names the FIELD and never echoes the value — reporting a
      // leak by repeating it turns one leak into two.
      expect(JSON.stringify(verdict.findings)).not.toContain('sk-live-0123456789');
    },
  );

  it('accepts a connector reporting only health and validity', () => {
    expect(
      validateSupplierSettings(
        supplier({
          connectors: [
            { name: 'erp', healthy: false, credentialValid: false, lastCheckedAtIso: null },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('whether this supplier is quoting right now (§19)', () => {
  it('stops quoting while the listing is paused, for everyone', () => {
    // §19's "plugin paused/revoked" row: a paused listing stops answering
    // while receipts are preserved. A caller that checked `quoteAccess` alone
    // would keep answering through a pause — the difference between a supplier
    // who is closed and one who is ignoring their customers.
    const paused = supplier({ listingState: 'paused', quoteAccess: 'anyone' });
    expect(quoteAdmissibility(paused, 'known')).toMatchObject({ admits: false });
    expect(quoteAdmissibility(paused, 'unknown')).toMatchObject({ admits: false });
  });

  it('distinguishes withdrawn from paused in what it tells the asker', () => {
    expect(quoteAdmissibility(supplier({ listingState: 'withdrawn' }), 'known')).toEqual({
      admits: false,
      reason: 'this listing has been withdrawn',
    });
    expect(quoteAdmissibility(supplier({ listingState: 'paused' }), 'known')).toEqual({
      admits: false,
      reason: 'this listing is paused',
    });
  });

  it('honours known_only without slamming the door on a stranger permanently', () => {
    // A stranger must be able to become a customer (§14.3), so the refusal
    // names the policy rather than pretending the supplier does not exist.
    const known = supplier({ quoteAccess: 'known_only' });
    expect(quoteAdmissibility(known, 'known')).toEqual({ admits: true });
    expect(quoteAdmissibility(known, 'unknown')).toEqual({
      admits: false,
      reason: 'this supplier quotes existing customers only',
    });
  });

  it('admits nobody when the supplier is not quoting at all', () => {
    expect(quoteAdmissibility(supplier({ quoteAccess: 'nobody' }), 'known')).toMatchObject({
      admits: false,
    });
  });

  it('admits an ordinary live listing', () => {
    expect(quoteAdmissibility(supplier(), 'unknown')).toEqual({ admits: true });
  });
});

/**
 * The settings STORE — validated on read as well as write.
 *
 * The row is editable by anything with the database open, and these settings
 * gate refusals. A tampered `quoteAccess: "anyone"` on a paused listing is a
 * supplier answering customers they closed the door on.
 */
describe('the settings store', () => {
  it('refuses to write settings it would refuse to read', async () => {
    const { InMemoryCommerceSettingsRepository } =
      await import('../../src/commerce/settings_store');
    const store = new InMemoryCommerceSettingsRepository();
    const written = store.writeBuyer(buyer({ quoteFanoutCeiling: 99 }));
    expect(written.ok).toBe(false);
    // And nothing was stored: a rejected write must not leave a half-applied
    // policy behind for the next read to believe.
    expect(store.readBuyer()).toEqual({ ok: false, absent: true });
  });

  it('distinguishes "not configured" from "configured and invalid"', async () => {
    const { InMemoryCommerceSettingsRepository } =
      await import('../../src/commerce/settings_store');
    const store = new InMemoryCommerceSettingsRepository();
    // ABSENT is a starting point. INVALID is a fault the owner has to see,
    // because the node is failing closed on their policy.
    expect(store.readBuyer()).toEqual({ ok: false, absent: true });
    expect(store.writeBuyer(buyer())).toEqual({ ok: true });
    const read = store.readBuyer();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected settings');
    expect(read.settings.currency).toBe('INR');
  });

  it('round-trips supplier settings', async () => {
    const { InMemoryCommerceSettingsRepository } =
      await import('../../src/commerce/settings_store');
    const store = new InMemoryCommerceSettingsRepository();
    expect(store.writeSupplier(supplier({ listingState: 'paused' }))).toEqual({ ok: true });
    const read = store.readSupplier();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected settings');
    expect(read.settings.listingState).toBe('paused');
  });
});

describe('connector endpoints are checked where the owner types them (§6.5, WS-9.1)', () => {
  const endpointed = (
    endpoint: NonNullable<SupplierSettings['connectors'][number]['endpoint']>,
  ): SupplierSettings =>
    supplier({
      connectors: [
        {
          name: 'erp.primary',
          healthy: true,
          credentialValid: true,
          lastCheckedAtIso: null,
          endpoint,
        },
      ],
    });

  const good = {
    operation: 'read_catalog',
    url: 'https://erp.example.com/catalog',
    auth: 'bearer' as const,
    json: true,
  };

  it('accepts a well-formed HTTPS endpoint', () => {
    expect(validateSupplierSettings(endpointed(good))).toEqual({ ok: true });
  });

  it('refuses a plaintext endpoint at the settings screen', () => {
    // The fetch policy would refuse it too, which is a connector that looks
    // configured and never works. Refusing here is the difference between a
    // settings error and a silent outage.
    const verdict = validateSupplierSettings(
      endpointed({ ...good, url: 'http://erp.example.com/catalog' }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.findings[0]).toMatchObject({
        refusal: 'endpoint_url_refused',
        field: 'connectors.erp.primary.endpoint.url',
        detail: 'not_https',
      });
    }
  });

  it('refuses a URL carrying credentials', () => {
    const verdict = validateSupplierSettings(
      endpointed({ ...good, url: 'https://user:pass@erp.example.com/catalog' }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.findings[0]?.detail).toBe('credentials_in_url');
  });

  it('refuses header auth with no header name rather than guessing one', () => {
    const verdict = validateSupplierSettings(endpointed({ ...good, auth: 'header' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.findings[0]).toMatchObject({
        refusal: 'endpoint_auth_incomplete',
        field: 'connectors.erp.primary.endpoint.headerName',
      });
    }
  });

  it('accepts header auth once the name is given', () => {
    expect(
      validateSupplierSettings(endpointed({ ...good, auth: 'header', headerName: 'X-Api-Key' })),
    ).toEqual({ ok: true });
  });

  it('refuses an endpoint that serves no named operation', () => {
    const verdict = validateSupplierSettings(endpointed({ ...good, operation: '' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.findings[0]?.refusal).toBe('endpoint_auth_incomplete');
  });

  it('still refuses credential material beside an endpoint', () => {
    const settings = endpointed(good);
    // A connector row that gained a `token` field alongside a legal endpoint.
    (settings.connectors[0] as unknown as Record<string, unknown>).token = 'sk-live-anything';
    const verdict = validateSupplierSettings(settings);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.findings.map((finding) => finding.refusal)).toContain(
        'credential_material_present',
      );
    }
  });

  it('a connector with no endpoint is still legal — the CSV upload has none', () => {
    expect(
      validateSupplierSettings(
        supplier({
          connectors: [
            { name: 'local.csv', healthy: true, credentialValid: true, lastCheckedAtIso: null },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });
});

/**
 * The two fields the photo-catalog lane added, and the reason each is
 * OPTIONAL rather than required.
 *
 * A supplier who sells nothing priced needs no currency, and one who has not
 * chosen categories yet is mid-setup, not misconfigured. So absence is legal
 * here and the refusal lands where the value is USED — the assembler, which
 * can say which item it could not build and why. What this layer refuses is a
 * value that is present and unusable, because storing one puts a number into
 * every published price that the wire then rejects.
 */
describe('trading currency', () => {
  it('accepts a supplier with none — an unpriced catalog is a real catalog', () => {
    expect(validateSupplierSettings(supplier())).toEqual({ ok: true });
  });

  it('accepts a valid ISO 4217 code', () => {
    expect(validateSupplierSettings(supplier({ tradingCurrency: 'INR' }))).toEqual({ ok: true });
  });

  it.each(['inr', 'Rupees', 'INRR', 'IN', '', '₹'])('refuses %p', (code) => {
    const verdict = validateSupplierSettings(supplier({ tradingCurrency: code }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.findings.map((f) => f.refusal)).toContain('unknown_trading_currency');
  });

  it('agrees with Money, because both read one rule', () => {
    // The check here and the check `Money` runs are the same function. If they
    // were two regexes, this test would be the only thing noticing when one of
    // them was edited — and it would notice by failing, which is the point.
    for (const code of ['INR', 'USD', 'EUR']) {
      expect(validateSupplierSettings(supplier({ tradingCurrency: code }))).toEqual({ ok: true });
      expect(validateMoney({ currency: code, minor_units: '100' })).toBeNull();
    }
    for (const code of ['inr', 'INRR']) {
      expect(validateSupplierSettings(supplier({ tradingCurrency: code })).ok).toBe(false);
      expect(validateMoney({ currency: code, minor_units: '100' })).not.toBeNull();
    }
  });
});

describe('catalog category ids', () => {
  it('accepts a supplier with none, and a supplier with well-formed ids', () => {
    expect(validateSupplierSettings(supplier())).toEqual({ ok: true });
    expect(
      validateSupplierSettings(supplier({ catalogCategoryIds: ['food.preserves', 'food:pickle-1'] })),
    ).toEqual({ ok: true });
  });

  it('refuses an EMPTY list, which is not the same as an absent one', () => {
    // Absent means "not configured yet". Empty means "configured to nothing",
    // which can never satisfy the non-empty `category_ids` every published
    // item needs — so it is a setting that guarantees a later failure.
    const verdict = validateSupplierSettings(supplier({ catalogCategoryIds: [] }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.findings.map((f) => f.refusal)).toContain('empty_catalog_categories');
  });

  it('refuses free text that cannot be an id — the category read off a price list', () => {
    // This is the exact value the extraction vocabulary yields: a human-facing
    // category with a space and an ampersand. `validateId` permits only
    // [A-Za-z0-9._:-], so it cannot become a published category id, and the
    // seller has to choose one instead.
    const verdict = validateSupplierSettings(
      supplier({ catalogCategoryIds: ['Pickles & Preserves'] }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.findings.map((f) => f.refusal)).toContain('malformed_catalog_category');
  });

  it('names WHICH entry is malformed, not just that one is', () => {
    const verdict = validateSupplierSettings(
      supplier({ catalogCategoryIds: ['food.ok', 'bad value', 'also.ok'] }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.findings.map((f) => f.field)).toContain('catalogCategoryIds[1]');
  });
});
