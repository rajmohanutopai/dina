/**
 * T. ONDC and open networks (docs/REAL_LIFE_SCENARIOS_2.md). Every story
 * needs an ONDC (Beckn) buyer adapter, which is not built (ROADMAP 3.4); they
 * stand as its acceptance tests.
 */

import { notHere } from './part2_util';

import type { Scenario } from '../scenario';

const WHY = 'needs an ONDC (Beckn) buyer adapter and the ONDC staging network, not built (ROADMAP 3.4)';

export const areaT: Scenario[] = [
  notHere('T1', 'Grocery order from the local kirana', WHY),
  notHere('T2', 'Order status and delay', WHY),
  notHere('T3', 'Cancel within policy', WHY),
  notHere('T4', 'Return and refund with a grievance', WHY),
  notHere('T5', 'Food delivery with an allergy', WHY),
  notHere('T6', 'A cab on ONDC mobility', WHY),
  notHere('T7', 'A home service on ONDC', WHY),
  notHere('T8', 'Compare ONDC and a known shop', WHY),
  notHere('T9', 'The seller is a Dina', WHY),
  notHere('T10', 'Privacy on an open network', WHY),
];
