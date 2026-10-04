/**
 * How every card a Dina node serves says it is reached and called, apart
 * from its identity and skills (design §5.1, §6.6, §7.1): the JSON-RPC and
 * REST interfaces under the node's public origin, the bearer scheme with its
 * description, the scope-less requirement every bearer card carries (the one
 * the reference SDK's signing form drops), and the flags. One source, so the
 * card Core builds and the vectors that check the SDK reads it cannot part.
 */

import { A2A_RPC_PATH } from './constants';
import { A2A_REST_PATH } from './rest_binding';

import type { CardProjectionInput } from './card_projection';

export type DinaCardFrame = Pick<
  CardProjectionInput,
  'interfaceUrl' | 'restInterfaceUrl' | 'securitySchemes' | 'securityRequirements' | 'flags'
>;

/** The frame of a Dina card served under `origin` (scheme, host and port; no path). */
export function dinaCardFrame(origin: string): DinaCardFrame {
  return {
    interfaceUrl: `${origin}${A2A_RPC_PATH}`,
    restInterfaceUrl: `${origin}${A2A_REST_PATH}`,
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          description: 'A client token the node’s owner issues to your agent.',
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    flags: { streaming: true, pushNotifications: true, extendedAgentCard: true },
  };
}
