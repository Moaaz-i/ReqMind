import type { HttpMethod } from "../types.js";
import { canonicalizeURL } from "./url.js";

/**
 * Headers that participate in the request fingerprint — the ones that
 * meaningfully change the server's response for the same URL.
 */
const RELEVANT_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "x-api-key",
  "accept-language",
  "if-none-match",
]);

function stringifyBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export interface FingerprintInput {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Build a stable request fingerprint: METHOD + canonical URL + relevant
 * headers + body. Used as the key for dedup and caching.
 */
export function createFingerprint({ method, url, headers = {}, body }: FingerprintInput): string {
  const relevant = Object.entries(headers)
    .filter(([key]) => RELEVANT_HEADERS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key.toLowerCase()}=${value}`)
    .join("&");

  const headerPart = relevant ? ` [h:${relevant}]` : "";
  return `${method} ${canonicalizeURL(url)}${headerPart}[b:${stringifyBody(body)}]`;
}