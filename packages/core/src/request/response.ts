import type { ApiResponse } from "../types.js";

/**
 * Read the response body once and try to parse it as JSON. Falls back to
 * plain text for non-JSON payloads and empty bodies.
 */
export async function parseResponse<T = unknown>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  let data: unknown = text;

  if (text) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
  }

  return {
    data: data as T,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
}

/**
 * Attach a timeout that flags the tracker then aborts it, so the caller can
 * tell TimeoutError apart from a user cancellation.
 */
export function armTimeout(
  tracker: { timeout(): void },
  ms: number,
): { clear(): void; fired(): boolean } {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    tracker.timeout();
  }, ms);
  return {
    clear: () => clearTimeout(timer),
    fired: () => fired,
  };
}