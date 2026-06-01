# Dina Services Provider Guide

When Dina says a capability is not being served, it means discovery found no
live provider for that capability on the Dina Services Network.

This is not an app error. It is an empty slot in the network. A developer, agent
author, or service operator can fill that slot by running a provider and
publishing a provider profile for the capability.

## What You Are Building

A provider is anything that can answer one or more capability names, such as:

```text
com.acme.widget_price
```

The provider receives a structured request, calls an agent, local service, API,
MCP server, script, or device integration, and returns a structured result that
Dina can show to the user.

## The Basic Flow

1. Pick the capability name shown in Dina.
2. Implement a handler for that capability.
3. Run the handler through an agent/runtime that Dina can reach.
4. Publish a Dina Services provider profile that advertises the capability.
5. Ask Dina again. The missing-capability card should become a real service
   result.

## Minimal Provider Shape

Your provider needs three things:

- A stable capability name.
- A handler that accepts params and returns JSON.
- A published profile that says this provider serves that capability.

Example handler shape:

```ts
async function handleWidgetPrice(params: Record<string, unknown>) {
  const symbol = String(params.symbol ?? '');
  return {
    symbol,
    price: 42.25,
    currency: 'USD',
    source: 'example-provider',
  };
}
```

## Runtime Options

Dina Services should not depend on one runtime. A provider can be backed by many
kinds of agents or services.

Examples:

- an OpenClaw daemon,
- an MCP server,
- a hosted API,
- a local script wrapped by an agent,
- a device or home-server integration,
- a specialized Dina-to-Dina service.

The runtime's job is simple: accept Dina's request, run the provider logic, and
return a JSON result. OpenClaw is one possible bridge, not the only one.

## Good First Provider

Start with one capability and one simple result.

Do not begin with a large multi-service system. A useful first provider is often
just one wrapper around an agent, API, or script that you already trust.

## What Users See

Before a provider exists, Dina shows a missing-capability card.

After a provider is running and published, Dina can route the same ask to your
provider and show the returned result as a service response.

## Current Status

This guide describes the intended developer path. The mobile app currently
opens this guide from the missing-capability card. Automated provider scaffolding
and one-tap deployment can be added later.
