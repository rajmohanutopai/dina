/**
 * The ingress move (plan §4.2a; notes "Ingress move, behaviour fixed"): the
 * capability registry reads its own keys only, so a capability named after a
 * built-in object key resolves to nothing, and the ingress neither throws
 * nor runs a function it found on a prototype.
 */

import { FALLBACK_TTL_SECONDS, getCapability, getTTL } from '../../src/service/capabilities/registry';
import { ServiceQueryIngress } from '../../src/service/query_ingress';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, type CreateWorkflowTaskInput } from '../../src/workflow/service';

import type { ServiceConfig } from '@dina/protocol';

// Plan B258 (the keys the probe used beyond the existing `constructor` case)
it.each(['__proto__', 'hasOwnProperty', 'valueOf', 'toString', 'isPrototypeOf'])(
  'a capability named %s resolves to nothing in the registry, and the query runs as its listing says',
  async (name) => {
    expect(getCapability(name)).toBeUndefined();
    expect(getTTL(name)).toBe(FALLBACK_TTL_SECONDS);
    // An own key, as a parsed listing would hold it.
    const capabilities = JSON.parse(`{"${name}":{"mcpServer":"transit","mcpTool":"t","responsePolicy":"auto"}}`) as ServiceConfig['capabilities'];
    const config: ServiceConfig = { isDiscoverable: true, name: 'Odd', capabilities };
    const workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    const created: CreateWorkflowTaskInput[] = [];
    const create = workflow.create.bind(workflow);
    workflow.create = (input) => {
      created.push(input);
      return create(input);
    };
    const ingress = new ServiceQueryIngress({ workflow, readConfig: () => config });
    await expect(
      ingress.admitQuery('did:plc:requester', { query_id: `q-${name}`, capability: name, params: {}, ttl_seconds: 60 }),
    ).resolves.toBeUndefined();
    expect(created.map((c) => c.kind)).toEqual(['delegation']);
    // The lane and the tool are the listing's own, never a value found on a prototype.
    expect(created[0]).toMatchObject({ requestedRunner: 'transit' });
    expect(JSON.parse(created[0]?.payload ?? '{}')).toMatchObject({ capability: name, mcp_tool: 't' });
  },
);
