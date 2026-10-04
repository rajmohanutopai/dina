/**
 * The reserved workflow lane for outbound A2A dispatch (design §6.3):
 * `a2a:<remote_agent_id>`. Like `plugin:<install_id>` and `dina.local`, it is
 * matched exactly, never taken by a generic claim, and never claimable by an
 * external runner: only the host's in-process A2A runner claims it.
 */

export const A2A_LANE_PREFIX = 'a2a:';

export function a2aLaneFor(remoteAgentId: string): string {
  if (remoteAgentId === '') throw new Error('a2aLaneFor: empty remote agent id');
  return `${A2A_LANE_PREFIX}${remoteAgentId}`;
}

export function isA2ALane(runner: string): boolean {
  return runner.startsWith(A2A_LANE_PREFIX) && runner.length > A2A_LANE_PREFIX.length;
}
