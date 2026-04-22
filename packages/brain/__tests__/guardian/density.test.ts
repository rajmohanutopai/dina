/**
 * Density analysis — trust disclosure caveats for LLM responses.
 *
 * Source: brain/src/service/guardian.py — density analysis
 */

import {
  analyzeDensity,
  classifyTier,
  buildDisclosure,
  applyDisclosure,
  computeEntityDensity,
  type DensityTier,
  type DensityAnalysis,
} from '../../src/guardian/density';
import type { AssembledContext } from '../../src/vault_context/assembly';

function makeContext(
  count: number,
  persona: string = 'general',
  score: number = 0.8,
): AssembledContext {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    content_l0: `Item ${i} headline`,
    score,
    persona,
  }));
  return { items, tokenEstimate: count * 50, personas: [persona] };
}

describe('Density Analysis', () => {
  describe('classifyTier', () => {
    it('0 items → zero', () => expect(classifyTier(0)).toBe('zero'));
    it('1 item → single', () => expect(classifyTier(1)).toBe('single'));
    it('2 items → sparse', () => expect(classifyTier(2)).toBe('sparse'));
    it('3 items → sparse', () => expect(classifyTier(3)).toBe('sparse'));
    it('4 items → moderate', () => expect(classifyTier(4)).toBe('moderate'));
    it('9 items → moderate', () => expect(classifyTier(9)).toBe('moderate'));
    it('10 items → dense', () => expect(classifyTier(10)).toBe('dense'));
    it('100 items → dense', () => expect(classifyTier(100)).toBe('dense'));
  });

  describe('buildDisclosure', () => {
    it('zero tier → null (handled by pipeline)', () => {
      expect(buildDisclosure('zero', 0, 0)).toBeNull();
    });

    it('single tier → single-entry caveat', () => {
      const disclosure = buildDisclosure('single', 1, 0.9);
      expect(disclosure).toContain('single entry');
      expect(disclosure).toContain('incomplete');
    });

    it('sparse tier with high scores → limited data caveat', () => {
      const disclosure = buildDisclosure('sparse', 3, 0.8);
      expect(disclosure).toContain('limited data');
      expect(disclosure).toContain('3 items');
    });

    it('sparse tier with low scores → loosely matched caveat', () => {
      const disclosure = buildDisclosure('sparse', 2, 0.3);
      expect(disclosure).toContain('loosely matched');
    });

    it('moderate tier → null (sufficient data)', () => {
      expect(buildDisclosure('moderate', 5, 0.8)).toBeNull();
    });

    it('dense tier → null (sufficient data)', () => {
      expect(buildDisclosure('dense', 15, 0.9)).toBeNull();
    });
  });

  describe('analyzeDensity', () => {
    it('empty context → zero tier', () => {
      const result = analyzeDensity(makeContext(0));
      expect(result.tier).toBe('zero');
      expect(result.itemCount).toBe(0);
      expect(result.disclosure).toBeNull();
    });

    it('single item → single tier with disclosure', () => {
      const result = analyzeDensity(makeContext(1));
      expect(result.tier).toBe('single');
      expect(result.itemCount).toBe(1);
      expect(result.disclosure).not.toBeNull();
      expect(result.disclosure).toContain('single entry');
    });

    it('3 items → sparse tier with disclosure', () => {
      const result = analyzeDensity(makeContext(3));
      expect(result.tier).toBe('sparse');
      expect(result.disclosure).not.toBeNull();
    });

    it('5 items → moderate tier with no disclosure', () => {
      const result = analyzeDensity(makeContext(5));
      expect(result.tier).toBe('moderate');
      expect(result.disclosure).toBeNull();
    });

    it('12 items → dense tier with no disclosure', () => {
      const result = analyzeDensity(makeContext(12));
      expect(result.tier).toBe('dense');
      expect(result.disclosure).toBeNull();
    });

    it('tracks unique personas', () => {
      const context: AssembledContext = {
        items: [
          { id: '1', content_l0: 'Health note', score: 0.9, persona: 'health' },
          { id: '2', content_l0: 'Finance note', score: 0.8, persona: 'financial' },
          { id: '3', content_l0: 'Work note', score: 0.7, persona: 'work' },
          { id: '4', content_l0: 'Another health', score: 0.85, persona: 'health' },
        ],
        tokenEstimate: 200,
        personas: ['health', 'financial', 'work'],
      };
      const result = analyzeDensity(context);
      expect(result.uniquePersonas).toBe(3);
    });

    it('computes average score', () => {
      const result = analyzeDensity(makeContext(4, 'general', 0.6));
      expect(result.averageScore).toBeCloseTo(0.6, 1);
    });

    it('low-confidence sparse data gets "loosely matched" qualifier', () => {
      const result = analyzeDensity(makeContext(2, 'general', 0.3));
      expect(result.tier).toBe('sparse');
      expect(result.disclosure).toContain('loosely matched');
    });

    it('high-confidence sparse data does not get "loosely matched"', () => {
      const result = analyzeDensity(makeContext(3, 'general', 0.9));
      expect(result.tier).toBe('sparse');
      expect(result.disclosure).not.toContain('loosely matched');
      expect(result.disclosure).toContain('limited data');
    });
  });

  describe('applyDisclosure', () => {
    it('appends disclosure when present', () => {
      const density: DensityAnalysis = {
        tier: 'single',
        itemCount: 1,
        uniquePersonas: 1,
        averageScore: 0.8,
        disclosure: 'Note: This is based on a single entry.',
        entities: [],
      };
      const result = applyDisclosure('The meeting is Thursday.', density);
      expect(result).toContain('The meeting is Thursday.');
      expect(result).toContain('Note: This is based on a single entry.');
      expect(result).toContain('\n\n');
    });

    it('returns answer unchanged when no disclosure', () => {
      const density: DensityAnalysis = {
        tier: 'dense',
        itemCount: 15,
        uniquePersonas: 3,
        averageScore: 0.85,
        disclosure: null,
        entities: [],
      };
      const result = applyDisclosure('The meeting is Thursday.', density);
      expect(result).toBe('The meeting is Thursday.');
    });
  });

  describe('per-entity density', () => {
    it('breaks down density by entity names in L0 headlines', () => {
      const context: AssembledContext = {
        items: [
          { id: '1', content_l0: 'Email from Emma about school', score: 0.9, persona: 'general' },
          {
            id: '2',
            content_l0: 'Note about Emma birthday March 15',
            score: 0.8,
            persona: 'general',
          },
          {
            id: '3',
            content_l0: 'Message from Emma regarding dentist',
            score: 0.7,
            persona: 'health',
          },
          {
            id: '4',
            content_l0: 'Report from Sancho on project status',
            score: 0.6,
            persona: 'work',
          },
        ],
        tokenEstimate: 200,
        personas: ['general', 'health', 'work'],
      };

      const result = analyzeDensity(context);
      expect(result.entities.length).toBeGreaterThanOrEqual(2);

      const emma = result.entities.find((e) => e.entity === 'Emma');
      expect(emma).toBeDefined();
      expect(emma!.count).toBe(3);
      expect(emma!.tier).toBe('sparse');

      const sancho = result.entities.find((e) => e.entity === 'Sancho');
      expect(sancho).toBeDefined();
      expect(sancho!.count).toBe(1);
      expect(sancho!.tier).toBe('single');
    });

    it('sorted by count descending (most-referenced first)', () => {
      const context: AssembledContext = {
        items: [
          { id: '1', content_l0: 'Note about Alice at work', score: 0.9, persona: 'general' },
          { id: '2', content_l0: 'Another note about Bob', score: 0.8, persona: 'general' },
          { id: '3', content_l0: 'More about Alice this week', score: 0.7, persona: 'general' },
        ],
        tokenEstimate: 150,
        personas: ['general'],
      };

      const result = analyzeDensity(context);
      if (result.entities.length >= 2) {
        expect(result.entities[0].count).toBeGreaterThanOrEqual(result.entities[1].count);
      }
    });

    it('empty context → empty entities', () => {
      const result = analyzeDensity(makeContext(0));
      expect(result.entities).toEqual([]);
    });

    it('computeEntityDensity works standalone', () => {
      const items = [
        { id: '1', content_l0: 'Meeting with Alice tomorrow', score: 0.9, persona: 'work' },
        { id: '2', content_l0: 'Call Alice about project', score: 0.8, persona: 'work' },
      ];
      const entities = computeEntityDensity(items);
      const alice = entities.find((e) => e.entity === 'Alice');
      expect(alice).toBeDefined();
      expect(alice!.count).toBe(2);
    });
  });
});
