/**
 * WebSocket message buffer — per-device message queue with TTL.
 *
 * When a paired device is disconnected, messages are buffered.
 * On reconnect, the buffer is flushed (delivered in order).
 *
 * Constraints:
 *   - Max 50 messages per device
 *   - 5-minute TTL per message (expired messages are purged)
 *   - Oldest messages evicted when buffer is full
 *
 * Source: ARCHITECTURE.md Task 10.7
 */

const MAX_MESSAGES_PER_DEVICE = 50;
const MESSAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface BufferedMessage {
  id: string;
  deviceId: string;
  type: string;
  payload: unknown;
  bufferedAt: number;
  expiresAt: number;
}

/** Per-device message buffers. */
const buffers = new Map<string, BufferedMessage[]>();

let messageCounter = 0;

/**
 * Buffer a message for a disconnected device.
 *
 * If the buffer is full (50 messages), the oldest message is evicted.
 * Returns the buffered message.
 */
export function bufferMessage(
  deviceId: string,
  type: string,
  payload: unknown,
  now?: number,
): BufferedMessage {
  const currentTime = now ?? Date.now();

  let buffer = buffers.get(deviceId);
  if (!buffer) {
    buffer = [];
    buffers.set(deviceId, buffer);
  }

  // Evict oldest if at capacity
  if (buffer.length >= MAX_MESSAGES_PER_DEVICE) {
    buffer.shift();
  }

  const msg: BufferedMessage = {
    id: `wm-${++messageCounter}`,
    deviceId,
    type,
    payload,
    bufferedAt: currentTime,
    expiresAt: currentTime + MESSAGE_TTL_MS,
  };

  buffer.push(msg);
  return msg;
}

/**
 * Flush the buffer for a device (on reconnect).
 *
 * Returns all non-expired messages in order (oldest first).
 * Clears the buffer after flushing.
 */
export function flushBuffer(deviceId: string, now?: number): BufferedMessage[] {
  const buffer = buffers.get(deviceId);
  if (!buffer || buffer.length === 0) return [];

  const currentTime = now ?? Date.now();
  const valid = buffer.filter((m) => m.expiresAt > currentTime);

  buffers.delete(deviceId);
  return valid;
}

/**
 * Get the count of buffered messages for a device.
 */
export function bufferCount(deviceId: string): number {
  return buffers.get(deviceId)?.length ?? 0;
}

/**
 * Get total buffered messages across all devices.
 */
export function totalBuffered(): number {
  let total = 0;
  for (const buffer of buffers.values()) {
    total += buffer.length;
  }
  return total;
}

/**
 * Purge expired messages across all device buffers.
 * Returns count of purged messages.
 */
export function purgeExpired(now?: number): number {
  const currentTime = now ?? Date.now();
  let purged = 0;

  for (const [deviceId, buffer] of buffers.entries()) {
    const before = buffer.length;
    const valid = buffer.filter((m) => m.expiresAt > currentTime);
    purged += before - valid.length;

    if (valid.length === 0) {
      buffers.delete(deviceId);
    } else {
      buffers.set(deviceId, valid);
    }
  }

  return purged;
}

/**
 * Peek at buffered messages for a device without flushing.
 */
export function peekBuffer(deviceId: string): BufferedMessage[] {
  return [...(buffers.get(deviceId) ?? [])];
}

/** Reset all buffers (for testing). */
export function resetMessageBuffers(): void {
  buffers.clear();
  messageCounter = 0;
}
