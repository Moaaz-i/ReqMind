import type { ParamValue } from "../types.js";

/**
 * Resolve a request URL against an optional base URL.
 */
export function resolveURL(baseURL: string | undefined, url: string): string {
  if (!baseURL) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const base = baseURL.replace(/\/+$/, "");
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}`;
}

function formatValue(value: ParamValue | ParamValue[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.map(String).join(",") : String(value);
}

/**
 * Merge existing query params with a params object.
 */
export function buildQuery(url: string, params?: Record<string, ParamValue | ParamValue[]>): string {
  const [path = "", existing = ""] = url.split("?");
  const search = new URLSearchParams(existing);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const formatted = formatValue(value);
      if (formatted === undefined) {
        search.delete(key);
      } else {
        search.set(key, formatted);
      }
    }
  }

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Canonical form of a URL used for fingerprints and cache keys.
 * Sorts query params by key so `?b=1&a=2` and `?a=2&b=1` match.
 */
export function canonicalizeURL(url: string): string {
  const [path = "", query = ""] = url.split("?");
  if (!query) return path.replace(/\/+$/, "") || "/";

  const entries = [...new URLSearchParams(query).entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const sorted = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return sorted ? `${path.replace(/\/+$/, "") || "/"}?${sorted}` : path.replace(/\/+$/, "") || "/";
}

/**
 * Resource path of a raw request URL: strips protocol + origin + query
 * (`https://api.example.com/users?page=1` → `/users`).
 */
export function urlPath(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const withoutOrigin = withoutQuery.replace(/^https?:\/\/[^/]+/, "");
  const trimmed = withoutOrigin.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}