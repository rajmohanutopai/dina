import { UNIT_VOCABULARY_V1, unitDef, unitsComparable } from '../src/units';

describe('unit vocabulary v1', () => {
  it('is closed and self-consistent', () => {
    const codes = UNIT_VOCABULARY_V1.map((u) => u.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const unit of UNIT_VOCABULARY_V1) {
      expect(unit.scale).toBeGreaterThanOrEqual(0);
      if (unit.baseFactor !== null) expect(unit.baseFactor).toBeGreaterThan(0n);
    }
  });

  it('declares the fixed v1 scales', () => {
    expect(unitDef('each')?.scale).toBe(0);
    expect(unitDef('case')?.scale).toBe(0);
    expect(unitDef('pallet')?.scale).toBe(0);
    expect(unitDef('g')?.scale).toBe(0);
    expect(unitDef('kg')?.scale).toBe(3);
    expect(unitDef('ml')?.scale).toBe(0);
    expect(unitDef('l')?.scale).toBe(3);
  });

  it('declares exact base factors where conversion is legal', () => {
    expect(unitDef('kg')?.baseFactor).toBe(1000n);
    expect(unitDef('g')?.baseFactor).toBe(1n);
    expect(unitDef('l')?.baseFactor).toBe(1000n);
    expect(unitDef('ml')?.baseFactor).toBe(1n);
    expect(unitDef('each')?.baseFactor).toBe(1n);
  });

  it('marks pack-evidence units non-convertible', () => {
    expect(unitDef('case')?.baseFactor).toBeNull();
    expect(unitDef('pallet')?.baseFactor).toBeNull();
  });

  it('does not know units outside the vocabulary', () => {
    for (const code of ['EA', 'litre', 'lb', 'custom:did:plc:x#sack', '']) {
      expect(unitDef(code)).toBeUndefined();
    }
  });
});

describe('unitsComparable', () => {
  const u = (code: string) => {
    const def = unitDef(code);
    if (!def) throw new Error(`missing unit ${code}`);
    return def;
  };

  it('same code is always comparable, including pack units', () => {
    expect(unitsComparable(u('case'), u('case'))).toBe(true);
    expect(unitsComparable(u('pallet'), u('pallet'))).toBe(true);
    expect(unitsComparable(u('kg'), u('kg'))).toBe(true);
  });

  it('same dimension with exact factors is comparable', () => {
    expect(unitsComparable(u('kg'), u('g'))).toBe(true);
    expect(unitsComparable(u('l'), u('ml'))).toBe(true);
  });

  it('pack-evidence units never compare across codes', () => {
    expect(unitsComparable(u('case'), u('each'))).toBe(false);
    expect(unitsComparable(u('pallet'), u('case'))).toBe(false);
  });

  it('cross-dimension is never comparable', () => {
    expect(unitsComparable(u('kg'), u('l'))).toBe(false);
    expect(unitsComparable(u('each'), u('g'))).toBe(false);
  });
});
