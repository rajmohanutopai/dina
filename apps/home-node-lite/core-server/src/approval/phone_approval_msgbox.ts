import {
  buildRPCRequest,
  deriveDIDKey,
  getPublicKey,
  multibaseToPublicKey,
  publicKeyToMultibase,
  sealDecrypt,
  sealRPCRequest,
  sign,
  signRequest,
  verifyResponseSignature,
} from '@dina/core';
import { DIDResolver } from '@dina/core/runtime';
import { pickEd25519VerificationMethod } from '@dina/home-node';
import { makeNodeWebSocketFactory } from '@dina/net-node';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { CoreRPCResponse, WSFactory, WSLike } from '@dina/core';
import type { PhoneApprovalClient, PhoneApprovalResponse } from './phone_approval_sync';

const REQUEST_TIMEOUT_MS = 15_000;

export interface PhoneApprovalMsgBoxOptions {
  msgboxURL: string;
  phoneDID: string;
  privateKey: Uint8Array;
  wsFactory?: WSFactory;
  resolver?: DIDResolver;
  timeoutMs?: number;
}

export interface PhoneSetupCode {
  msgboxURL: string;
  phoneDID: string;
  code: string;
  deviceName: string;
}

/**
 * A small one-request-per-socket RPC client. It intentionally does not reuse
 * Core's process-global MsgBox singleton: the approval bridge has its own
 * paired did:key and must not replace the Home Node's root socket identity.
 */
export class PhoneApprovalMsgBoxClient implements PhoneApprovalClient {
  readonly did: string;
  readonly publicKey: Uint8Array;
  private readonly wsFactory: WSFactory;
  private readonly resolver: DIDResolver;
  private readonly timeoutMs: number;
  private phonePublicKey: Uint8Array | null = null;

  constructor(private readonly options: PhoneApprovalMsgBoxOptions) {
    this.publicKey = getPublicKey(options.privateKey);
    this.did = deriveDIDKey(this.publicKey);
    this.wsFactory = options.wsFactory ?? makeNodeWebSocketFactory();
    this.resolver = options.resolver ?? new DIDResolver();
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async pair(code: string, deviceName = 'Dina laptop approvals'): Promise<void> {
    const response = await this.request('POST', '/v1/pair/complete', {
      code,
      public_key_multibase: publicKeyToMultibase(this.publicKey),
      device_name: deviceName,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`phone pairing failed (${response.status})`);
    }
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PhoneApprovalResponse> {
    const phonePublicKey = await this.resolvePhonePublicKey();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyString);
    const headers = signRequest(method, path, '', bodyBytes, this.options.privateKey, this.did);
    const request = buildRPCRequest(method, path, '', bodyString, headers, this.did);
    const sealed = sealRPCRequest(request, phonePublicKey);
    const outer = {
      type: 'rpc',
      id: request.request_id,
      from_did: this.did,
      to_did: this.options.phoneDID,
      direction: 'request',
      expires_at: Math.floor(Date.now() / 1000) + 60,
      ...(path.startsWith('/v1/pair/') ? { subtype: 'pair' } : {}),
      ciphertext: Buffer.from(sealed).toString('base64'),
    };

    const socket = this.wsFactory(this.options.msgboxURL);
    const frames = new FrameQueue(socket);
    try {
      await frames.waitOpen(this.timeoutMs);
      const challenge = await frames.nextJSON(this.timeoutMs);
      if (
        challenge.type !== 'auth_challenge' ||
        typeof challenge.nonce !== 'string' ||
        typeof challenge.ts !== 'number'
      ) {
        throw new Error('unexpected MsgBox authentication challenge');
      }
      const canonical = `AUTH_RELAY\n${challenge.nonce}\n${challenge.ts}`;
      socket.send(
        JSON.stringify({
          type: 'auth_response',
          did: this.did,
          sig: bytesToHex(sign(this.options.privateKey, new TextEncoder().encode(canonical))),
          pub: bytesToHex(this.publicKey),
        }),
      );
      const auth = await frames.nextJSON(this.timeoutMs);
      if (auth.type !== 'auth_success') throw new Error('MsgBox authentication rejected');

      socket.send(new TextEncoder().encode(JSON.stringify(outer)));
      while (true) {
        const frame = await frames.nextJSON(this.timeoutMs);
        if (
          frame.type !== 'rpc' ||
          frame.direction !== 'response' ||
          frame.id !== request.request_id
        ) {
          continue;
        }
        if (frame.from_did !== this.options.phoneDID || frame.to_did !== this.did) {
          throw new Error('MsgBox response identity binding failed');
        }
        if (typeof frame.ciphertext !== 'string') {
          throw new Error('MsgBox response is missing ciphertext');
        }
        const plaintext = sealDecrypt(
          new Uint8Array(Buffer.from(frame.ciphertext, 'base64')),
          this.publicKey,
          this.options.privateKey,
        );
        const inner = JSON.parse(new TextDecoder().decode(plaintext)) as CoreRPCResponse;
        if (
          inner.request_id !== request.request_id ||
          inner.from !== this.options.phoneDID ||
          !verifyResponseSignature(inner, phonePublicKey)
        ) {
          throw new Error('phone response signature or request binding failed');
        }
        let parsed: unknown = inner.body;
        try {
          parsed = inner.body === '' ? {} : JSON.parse(inner.body);
        } catch {
          // Preserve a non-JSON error body as text.
        }
        return { status: inner.status, body: parsed };
      }
    } finally {
      socket.close();
    }
  }

  private async resolvePhonePublicKey(): Promise<Uint8Array> {
    if (this.phonePublicKey !== null) return this.phonePublicKey;
    const resolved = await this.resolver.resolve(this.options.phoneDID);
    const vm = pickEd25519VerificationMethod(resolved.document.verificationMethod);
    if (vm === null || typeof vm.publicKeyMultibase !== 'string') {
      throw new Error('phone DID has no usable Ed25519 verification key');
    }
    this.phonePublicKey = multibaseToPublicKey(vm.publicKeyMultibase);
    return this.phonePublicKey;
  }
}

export function parsePhoneSetupCode(raw: string): PhoneSetupCode {
  if (!raw.startsWith('dina1:')) throw new Error('phone setup code must start with dina1:');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw.slice('dina1:'.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('phone setup code is malformed');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('phone setup code payload must be an object');
  }
  const value = decoded as Record<string, unknown>;
  if (
    value.v !== 1 ||
    typeof value.msgbox_url !== 'string' ||
    !value.msgbox_url.startsWith('wss://') ||
    typeof value.homenode_did !== 'string' ||
    !value.homenode_did.startsWith('did:') ||
    typeof value.code !== 'string' ||
    value.code === ''
  ) {
    throw new Error('phone setup code has invalid fields');
  }
  return {
    msgboxURL: value.msgbox_url,
    phoneDID: value.homenode_did,
    code: value.code,
    deviceName:
      typeof value.device_name === 'string' && value.device_name.trim() !== ''
        ? value.device_name
        : 'Dina laptop approvals',
  };
}

class FrameQueue {
  private readonly frames: string[] = [];
  private readonly waiters: Array<(value: string) => void> = [];
  private openResolve: (() => void) | null = null;
  private openReject: ((error: Error) => void) | null = null;
  private readonly openPromise: Promise<void>;

  constructor(socket: WSLike) {
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
    socket.onopen = () => this.openResolve?.();
    socket.onerror = () => this.openReject?.(new Error('MsgBox socket error'));
    socket.onclose = (event) =>
      this.openReject?.(
        new Error(`MsgBox socket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`),
      );
    socket.onmessage = (event) => {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(event.data);
      else this.frames.push(event.data);
    };
  }

  waitOpen(timeoutMs: number): Promise<void> {
    return withTimeout(this.openPromise, timeoutMs, 'MsgBox open');
  }

  async nextJSON(timeoutMs: number): Promise<Record<string, unknown>> {
    const raw =
      this.frames.shift() ??
      (await withTimeout(
        new Promise<string>((resolve) => this.waiters.push(resolve)),
        timeoutMs,
        'MsgBox frame',
      ));
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('MsgBox frame is not an object');
    }
    return value as Record<string, unknown>;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
