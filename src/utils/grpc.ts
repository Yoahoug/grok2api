/**
 * gRPC-Web protocol utilities for Cloudflare Workers
 *
 * Provides encoding/decoding for gRPC-Web protocol used by X.AI APIs
 */

export interface GrpcStatus {
  code: number;
  message: string;
  ok: boolean;
  httpEquiv: number;
}

export class GrpcWebClient {
  /**
   * Encode gRPC-Web payload with frame header
   */
  static encodePayload(data: Uint8Array): Uint8Array {
    const length = data.length;
    const frame = new Uint8Array(5 + length);
    frame[0] = 0x00; // uncompressed flag
    // Big-endian 32-bit length
    frame[1] = (length >> 24) & 0xff;
    frame[2] = (length >> 16) & 0xff;
    frame[3] = (length >> 8) & 0xff;
    frame[4] = length & 0xff;
    frame.set(data, 5);
    return frame;
  }

  /**
   * Parse gRPC-Web response
   */
  static parseResponse(
    body: ArrayBuffer,
    contentType?: string,
    headers?: Headers,
  ): { messages: Uint8Array[]; trailers: Map<string, string> } {
    let decoded = new Uint8Array(body);

    // Handle grpc-web-text encoding (base64)
    if (contentType?.toLowerCase().includes("grpc-web-text")) {
      const text = new TextDecoder().decode(decoded);
      const compact = text.replace(/\s/g, "");
      decoded = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    }

    const messages: Uint8Array[] = [];
    const trailers = new Map<string, string>();

    let i = 0;
    const n = decoded.length;

    while (i < n) {
      if (n - i < 5) break;

      const flag = decoded[i];
      const length =
        (((decoded[i + 1] << 24) |
          (decoded[i + 2] << 16) |
          (decoded[i + 3] << 8) |
          decoded[i + 4]) >>> 0);
      i += 5;

      if (n - i < length) break;

      const payload = decoded.slice(i, i + length);
      i += length;

      if (flag & 0x80) {
        // Trailer frame
        const text = new TextDecoder().decode(payload);
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        for (const line of lines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim().toLowerCase();
            const raw = line.slice(colonIdx + 1).trim();
            let value = raw;
            try {
              value = decodeURIComponent(raw);
            } catch {
              // Fall back to original value if percent-encoding is invalid
            }
            trailers.set(key, value);
          }
        }
      } else if (flag & 0x01) {
        throw new Error("gRPC-Web compressed messages not supported");
      } else {
        // Message frame
        messages.push(payload);
      }
    }

    // Check headers for grpc-status/grpc-message
    if (headers) {
      const status = headers.get("grpc-status");
      const message = headers.get("grpc-message");
      if (status && !trailers.has("grpc-status")) {
        trailers.set("grpc-status", status);
      }
      if (message && !trailers.has("grpc-message")) {
        let decodedMessage = message;
        try {
          decodedMessage = decodeURIComponent(message);
        } catch {
          // Fall back to original value if percent-encoding is invalid
        }
        trailers.set("grpc-message", decodedMessage);
      }
    }

    return { messages, trailers };
  }

  /**
   * Extract gRPC status from trailers
   */
  static getStatus(trailers: Map<string, string>): GrpcStatus {
    const codeStr = trailers.get("grpc-status") ?? "-1";
    const message = trailers.get("grpc-message") ?? "";
    const code = parseInt(codeStr, 10) || -1;

    // Map gRPC status codes to HTTP equivalents
    const httpEquivMap: Record<number, number> = {
      0: 200,
      16: 401, // UNAUTHENTICATED
      7: 403, // PERMISSION_DENIED
      8: 429, // RESOURCE_EXHAUSTED
      4: 504, // DEADLINE_EXCEEDED
      14: 503, // UNAVAILABLE
    };

    return {
      code,
      message,
      ok: code === 0 || code === -1,
      httpEquiv: httpEquivMap[code] ?? 502,
    };
  }

  /**
   * Build headers for gRPC-Web request
   */
  static buildHeaders(token: string, origin: string, referer: string): Record<string, string> {
    return {
      "Content-Type": "application/grpc-web+proto",
      Accept: "*/*",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
      Origin: origin,
      Referer: referer,
      Cookie: `sso-rw=${token};sso=${token}`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    };
  }
}
