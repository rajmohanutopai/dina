/**
 * Earned room for the goods seller's floors (COMMITMENT_KERNEL §10 "Earned
 * room", §15 step 13). One automatic floor per item, kept in
 * `SupplierSettings.negotiation.items`, with the price card
 * (`negotiation_price_approval`) between it and the item's hard floor. The
 * figure is the unit price the buyer asked for, in the item's own unit: a card
 * is raised only for a line the item's floors approve (`approvedLineFloors`).
 */

import { productRefsEqual, type ProductRef } from '@dina/commerce-protocol';

import { recordLimitCard, type LimitAnswer, type LimitPort } from '../commitment/earned_room';

import { formatMoney } from './money_display';
import { publishedCatalogItems } from './published_catalog';

import type { CommerceRuntime } from './runtime';

export const GOODS_SELLER_KIND = 'goods.seller';

/** One item's limit: its product reference, each part escaped, in a stable order. */
export function goodsLimitKey(product: ProductRef): string {
  return [product.scheme, product.value, product.issuer_did ?? '', product.variant_digest ?? '']
    .map(encodeURIComponent)
    .join('|');
}

function productOf(key: string): ProductRef | null {
  const parts = key.split('|');
  if (parts.length !== 4) return null;
  let scheme: string, value: string, issuer: string, variant: string;
  try {
    [scheme, value, issuer, variant] = parts.map(decodeURIComponent) as [
      string,
      string,
      string,
      string,
    ];
  } catch {
    return null;
  }
  if (scheme === '' || value === '') return null;
  return {
    scheme: scheme as ProductRef['scheme'],
    value,
    ...(issuer !== '' ? { issuer_did: issuer } : {}),
    ...(variant !== '' ? { variant_digest: variant } : {}),
  };
}

/** The seller's floors as the kernel reads and writes them. */
export function goodsLimitPort(
  runtime: Pick<CommerceRuntime, 'settings' | 'catalogPointers' | 'catalogDrafts'>,
): LimitPort {
  const itemOf = (key: string) => {
    const product = productOf(key);
    const read = runtime.settings.readSupplier();
    if (product === null) return null;
    // Stored settings that do not validate are not "no limit": Core cannot see
    // the owner's floors, so nothing is decided on them (runner_bounds.ts).
    if (!read.ok && !read.absent) throw new Error('supplier settings unreadable');
    if (!read.ok) return null;
    const items = read.settings.negotiation?.items ?? [];
    const index = items.findIndex((i) => productRefsEqual(i.product, product));
    const item = items[index];
    return item === undefined ? null : { product, settings: read.settings, index, item };
  };
  return {
    kind: GOODS_SELLER_KIND,
    read(key) {
      const found = itemOf(key);
      if (found === null) return null;
      const hard = BigInt(found.item.floorMinorUnits);
      const auto =
        found.item.autoFloorMinorUnits === undefined
          ? hard
          : BigInt(found.item.autoFloorMinorUnits);
      // The floors, their unit and currency: the item's own, else the
      // published price's that `approvedLineFloors` measures lines against.
      const listed = publishedCatalogItems(runtime).find((i) =>
        productRefsEqual(i.product, found.product),
      );
      const sell = listed?.pack.sell_unit;
      const basis = [
        hard.toString(10),
        auto.toString(10),
        found.item.unitCode ?? '',
        found.settings.tradingCurrency ?? '',
        sell === undefined ? '' : `${sell.value} ${sell.unit_code}`,
        listed?.indicative_price?.currency ?? '',
      ].join('|');
      return { hard, auto, basis };
    },
    writeAuto(key, value) {
      let found: ReturnType<typeof itemOf>;
      try {
        found = itemOf(key);
      } catch {
        return false;
      }
      const negotiation = found?.settings.negotiation;
      if (found === null || negotiation === undefined) return false;
      const items = (negotiation.items ?? []).map((item, i) =>
        i === found.index ? { ...item, autoFloorMinorUnits: value.toString(10) } : item,
      );
      return runtime.settings.writeSupplier({
        ...found.settings,
        negotiation: { ...negotiation, items },
      }).ok;
    },
    describe(key) {
      const product = productOf(key);
      if (product === null) return 'prices';
      let name = product.value;
      try {
        const listed = publishedCatalogItems(runtime).find((i) =>
          productRefsEqual(i.product, product),
        );
        if (listed !== undefined && listed.name.trim() !== '') name = listed.name.trim();
      } catch {
        /* the item's own reference serves */
      }
      return `prices for ${name}`;
    },
    format(key, value) {
      let found: ReturnType<typeof itemOf> = null;
      try {
        found = itemOf(key);
      } catch {
        found = null;
      }
      let currency = found?.settings.tradingCurrency;
      if ((currency === undefined || currency === '') && found !== null) {
        try {
          currency = publishedCatalogItems(runtime).find((i) =>
            productRefsEqual(i.product, found.product),
          )?.indicative_price?.currency;
        } catch {
          currency = undefined;
        }
      }
      if (currency === undefined || currency === '') return value.toString(10);
      try {
        return formatMoney({ currency, minor_units: value.toString(10) });
      } catch {
        return value.toString(10);
      }
    },
  };
}

/**
 * A price card was answered: each line it asked about joins its item's
 * record. Called in the transaction that closes the question.
 */
export function notePriceAnswer(
  task: { id: string },
  lines: readonly { limit_key?: unknown; limit_stamp?: unknown; asked_minor_units?: unknown }[],
  answer: LimitAnswer,
  nowMs: number,
): void {
  for (const line of lines) {
    if (typeof line.limit_key !== 'string' || typeof line.asked_minor_units !== 'string') continue;
    if (typeof line.limit_stamp !== 'string' || !/^\d{1,20}$/.test(line.asked_minor_units))
      continue;
    recordLimitCard(
      {
        kind: GOODS_SELLER_KIND,
        limitKey: line.limit_key,
        cardId: task.id,
        figure: BigInt(line.asked_minor_units),
        stamp: line.limit_stamp,
        answer,
      },
      nowMs,
    );
  }
}
