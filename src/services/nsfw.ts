/**
 * NSFW Management Services for Cloudflare Workers
 *
 * Provides batch NSFW enablement through gRPC-Web APIs:
 * - Accept ToS
 * - Set Birth Date
 * - Enable NSFW Mode
 */

import type { Env } from "../env";
import { GrpcWebClient, type GrpcStatus } from "../utils/grpc";
import { BatchTask, runBatch } from "../batch";
import { recordTokenFailure } from "../repo/tokens";

const ACCEPT_TOS_API = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion";
const SET_BIRTH_API = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetBirthDate";
const NSFW_MGMT_API = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetNsfwMode";

export interface NsfwEnableResult {
  success: boolean;
  http_status: number;
  grpc_status?: number;
  grpc_message?: string;
  error?: string;
}

/**
 * Accept Terms of Service
 */
async function acceptTos(token: string): Promise<GrpcStatus> {
  const headers = GrpcWebClient.buildHeaders(
    token,
    "https://accounts.x.ai",
    "https://accounts.x.ai/accept-tos",
  );

  // Payload: version=1 (protobuf encoded as \x10\x01)
  const payload = GrpcWebClient.encodePayload(new Uint8Array([0x10, 0x01]));

  const response = await fetch(ACCEPT_TOS_API, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Accept ToS failed: ${response.status}`);
  }

  const { trailers } = GrpcWebClient.parseResponse(
    await response.arrayBuffer(),
    response.headers.get("content-type") ?? undefined,
    response.headers,
  );

  return GrpcWebClient.getStatus(trailers);
}

/**
 * Set Birth Date (required for NSFW)
 */
async function setBirthDate(token: string): Promise<GrpcStatus> {
  const headers = GrpcWebClient.buildHeaders(
    token,
    "https://accounts.x.ai",
    "https://accounts.x.ai/accept-tos",
  );

  // Payload: birth_date with year=1990, month=1, day=1
  // Protobuf: field 1 (message) containing year(1)=1990, month(2)=1, day(3)=1
  // \x0a\x0a\x08\xc6\x0f\x10\x01\x18\x01
  const payload = GrpcWebClient.encodePayload(
    new Uint8Array([0x0a, 0x0a, 0x08, 0xc6, 0x0f, 0x10, 0x01, 0x18, 0x01]),
  );

  const response = await fetch(SET_BIRTH_API, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Set birth date failed: ${response.status}`);
  }

  const { trailers } = GrpcWebClient.parseResponse(
    await response.arrayBuffer(),
    response.headers.get("content-type") ?? undefined,
    response.headers,
  );

  return GrpcWebClient.getStatus(trailers);
}

/**
 * Enable NSFW Mode
 */
async function enableNsfwMode(token: string): Promise<GrpcStatus> {
  const headers = GrpcWebClient.buildHeaders(
    token,
    "https://accounts.x.ai",
    "https://accounts.x.ai/accept-tos",
  );

  // Payload: nsfw_mode=true (protobuf encoded as \x08\x01)
  const payload = GrpcWebClient.encodePayload(new Uint8Array([0x08, 0x01]));

  const response = await fetch(NSFW_MGMT_API, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Enable NSFW failed: ${response.status}`);
  }

  const { trailers } = GrpcWebClient.parseResponse(
    await response.arrayBuffer(),
    response.headers.get("content-type") ?? undefined,
    response.headers,
  );

  return GrpcWebClient.getStatus(trailers);
}

/**
 * Enable NSFW for a single token
 */
export async function enableNsfwForToken(
  db: Env["DB"],
  token: string,
): Promise<NsfwEnableResult> {
  try {
    // Step 1: Accept ToS
    try {
      const tosStatus = await acceptTos(token);
      if (!tosStatus.ok) {
        await recordTokenFailure(db, token, tosStatus.httpEquiv, `ToS failed: ${tosStatus.message}`);
        return {
          success: false,
          http_status: tosStatus.httpEquiv,
          grpc_status: tosStatus.code,
          grpc_message: tosStatus.message,
          error: `Accept ToS failed: ${tosStatus.message}`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordTokenFailure(db, token, 500, `ToS error: ${msg}`);
      return {
        success: false,
        http_status: 500,
        error: `Accept ToS error: ${msg}`,
      };
    }

    // Step 2: Set Birth Date
    try {
      const birthStatus = await setBirthDate(token);
      if (!birthStatus.ok) {
        await recordTokenFailure(db, token, birthStatus.httpEquiv, `Birth date failed: ${birthStatus.message}`);
        return {
          success: false,
          http_status: birthStatus.httpEquiv,
          grpc_status: birthStatus.code,
          grpc_message: birthStatus.message,
          error: `Set birth date failed: ${birthStatus.message}`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordTokenFailure(db, token, 500, `Birth date error: ${msg}`);
      return {
        success: false,
        http_status: 500,
        error: `Set birth date error: ${msg}`,
      };
    }

    // Step 3: Enable NSFW
    try {
      const nsfwStatus = await enableNsfwMode(token);
      const success = nsfwStatus.ok;

      if (!success) {
        await recordTokenFailure(db, token, nsfwStatus.httpEquiv, `NSFW failed: ${nsfwStatus.message}`);
      }

      return {
        success,
        http_status: nsfwStatus.httpEquiv,
        grpc_status: nsfwStatus.code,
        grpc_message: nsfwStatus.message || undefined,
        error: success ? undefined : `Enable NSFW failed: ${nsfwStatus.message}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordTokenFailure(db, token, 500, `NSFW error: ${msg}`);
      return {
        success: false,
        http_status: 500,
        error: `Enable NSFW error: ${msg}`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      http_status: 500,
      error: msg,
    };
  }
}

/**
 * Batch enable NSFW for multiple tokens
 */
export async function batchEnableNsfw(
  db: Env["DB"],
  tokens: string[],
  options: {
    batchSize?: number;
    task?: BatchTask;
    shouldCancel?: () => boolean;
  } = {},
): Promise<Map<string, NsfwEnableResult>> {
  const results = await runBatch(
    tokens,
    async (token) => enableNsfwForToken(db, token),
    {
      batchSize: options.batchSize ?? 10,
      task: options.task,
      shouldCancel: options.shouldCancel,
    },
  );

  const mapped = new Map<string, NsfwEnableResult>();
  for (const [token, result] of results.entries()) {
    if (result.ok && result.data) {
      mapped.set(token, result.data);
    } else {
      mapped.set(token, {
        success: false,
        http_status: 500,
        error: result.error ?? "Unknown error",
      });
    }
  }

  return mapped;
}
