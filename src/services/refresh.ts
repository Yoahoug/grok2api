/**
 * Token Refresh Service for Cloudflare Workers
 *
 * Provides batch token refresh functionality:
 * - Check rate limits from Grok API
 * - Update token quotas in database
 * - Support both Basic and Super tokens
 */

import type { Env } from "../env";
import { getDynamicHeaders } from "../grok/headers";
import { toRateLimitModel } from "../grok/models";
import type { GrokSettings } from "../settings";
import { BatchTask, runBatch } from "../batch";
import { recordTokenFailure, applyCooldown, type TokenType } from "../repo/tokens";

const RATE_LIMIT_API = "https://grok.com/rest/rate-limits";

export interface TokenRefreshResult {
  success: boolean;
  remaining_queries?: number;
  heavy_remaining_queries?: number;
  error?: string;
  status?: number;
}

/**
 * Check rate limits for a token
 */
async function checkRateLimits(
  cookie: string,
  settings: GrokSettings,
  model: string,
): Promise<{ remaining: number; heavy_remaining: number } | null> {
  const rateModel = toRateLimitModel(model);
  const headers = getDynamicHeaders(settings, "/rest/rate-limits");
  headers.Cookie = cookie;
  const body = JSON.stringify({ requestKind: "DEFAULT", modelName: rateModel });

  try {
    const resp = await fetch(RATE_LIMIT_API, { method: "POST", headers, body });
    if (!resp.ok) return null;

    const data = (await resp.json()) as any;

    // Parse response structure
    // Expected: { remaining: number, heavyRemaining: number, ... }
    const remaining = typeof data?.remaining === "number" ? data.remaining : -1;
    const heavy_remaining = typeof data?.heavyRemaining === "number" ? data.heavyRemaining : -1;

    return { remaining, heavy_remaining };
  } catch {
    return null;
  }
}

/**
 * Refresh a single token
 */
export async function refreshToken(
  db: Env["DB"],
  token: string,
  tokenType: TokenType,
  settings: GrokSettings,
): Promise<TokenRefreshResult> {
  try {
    const cookie = `sso-rw=${token};sso=${token}`;

    // Check rate limits for appropriate model
    const model = tokenType === "ssoSuper" ? "grok-4-heavy" : "grok-3";
    const limits = await checkRateLimits(cookie, settings, model);

    if (!limits) {
      await recordTokenFailure(db, token, 500, "Rate limit check failed");
      return {
        success: false,
        error: "Rate limit check failed",
        status: 500,
      };
    }

    // Update token in database
    const updateResult = await db.prepare(
      `UPDATE tokens
       SET remaining_queries = ?,
           heavy_remaining_queries = ?,
           failed_count = 0,
           cooldown_until = NULL,
           last_failure_time = NULL,
           last_failure_reason = NULL
       WHERE token = ?`,
    ).bind(limits.remaining, limits.heavy_remaining, token).run();

    if (!updateResult.meta.changes) {
      return {
        success: false,
        error: "Token not found in database",
        status: 404,
      };
    }

    // Check if token is exhausted
    if (limits.remaining === 0 || (tokenType === "ssoSuper" && limits.heavy_remaining === 0)) {
      await applyCooldown(db, token, 429);
    }

    return {
      success: true,
      remaining_queries: limits.remaining,
      heavy_remaining_queries: limits.heavy_remaining,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordTokenFailure(db, token, 500, `Refresh error: ${msg}`);
    return {
      success: false,
      error: msg,
      status: 500,
    };
  }
}

/**
 * Batch refresh tokens
 */
export async function batchRefreshTokens(
  db: Env["DB"],
  tokens: Array<{ token: string; token_type: TokenType }>,
  settings: GrokSettings,
  options: {
    batchSize?: number;
    task?: BatchTask;
    shouldCancel?: () => boolean;
  } = {},
): Promise<Map<string, TokenRefreshResult>> {
  const results = await runBatch(
    tokens,
    async (item) => refreshToken(db, item.token, item.token_type, settings),
    {
      batchSize: options.batchSize ?? 10,
      task: options.task,
      shouldCancel: options.shouldCancel,
    },
  );

  const mapped = new Map<string, TokenRefreshResult>();
  for (const [item, result] of results.entries()) {
    if (result.ok && result.data) {
      mapped.set(item.token, result.data);
    } else {
      mapped.set(item.token, {
        success: false,
        error: result.error ?? "Unknown error",
        status: 500,
      });
    }
  }

  return mapped;
}
