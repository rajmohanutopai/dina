/**
 * `export_my_data` — "give me everything you know about me"
 * (REAL_LIFE_FIXES_2 §5). Owner chat only. Core prepares the document and
 * gives Brain only its manifest and an id; the chat card's button fetches it
 * through the owner's own device.
 */

import type { AgentTool } from './tool_registry';
import type { CoreClient } from '@dina/core';

export function createExportTool(opts: { core: Pick<CoreClient, 'ownerExportPrepare'> }): AgentTool {
  return {
    name: 'export_my_data',
    description:
      'Prepare a readable export of everything Dina holds for the user (notes per vault, people, contacts, reminders, topics), when the user asks what Dina knows about them or for their data. A card lets the user save it. Tell the user what is included and name any vault left out (closed or locked) and how to include it.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const out = await opts.core.ownerExportPrepare();
      const excluded = out.manifest.personas.filter((p) => !p.included).map((p) => `${p.persona} (${p.why ?? 'closed'})`);
      return {
        export_id: out.id,
        manifest: out.manifest,
        included: out.manifest.personas.filter((p) => p.included).map((p) => `${p.persona}: ${p.items} notes`),
        not_included: excluded,
      };
    },
  };
}
