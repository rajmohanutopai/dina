/**
 * The wording judge (docs/REAL_LIFE_SCENARIOS.md): one narrow question about one
 * reply, answered by the scenario model through OpenRouter. Used only where the
 * nodes' state cannot tell (an answer's content, a refusal's tone).
 */

import { SCENARIO_MODEL } from './fleet';

export interface Verdict {
  pass: boolean;
  reason: string;
}

const JUDGE_MODEL = process.env.SCENARIO_JUDGE_MODEL ?? SCENARIO_MODEL;

export async function judge(input: { asked: string; reply: string; criterion: string }): Promise<Verdict> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (key === '') throw new Error('judge: OPENROUTER_API_KEY is not set');
  const system =
    'You grade one reply from a personal AI assistant called Dina against ONE criterion. ' +
    'Judge only that criterion, literally and strictly; ignore style unless the criterion is about style. ' +
    'Answer with JSON only: {"pass": true|false, "reason": "<one short sentence>"}.';
  const user = `What the user said:\n${input.asked}\n\nDina's reply:\n${input.reply}\n\nCriterion:\n${input.criterion}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      if (attempt === 2) throw new Error(`judge: OpenRouter ${res.status}`);
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Partial<Verdict>;
      if (typeof parsed.pass === 'boolean') return { pass: parsed.pass, reason: String(parsed.reason ?? '') };
    } catch {
      /* retry */
    }
  }
  throw new Error('judge: no verdict');
}
