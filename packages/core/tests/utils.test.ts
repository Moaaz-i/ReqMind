import { describe, expect, it } from "vitest";
import { buildQuery, canonicalizeURL, resolveURL } from "../src/utils/url.js";
import { computeDelay } from "../src/utils/backoff.js";
import { createFingerprint } from "../src/utils/fingerprint.js";
import { parseRetryAfter } from "../src/utils/status.js";

describe("url", () => {
  it("resolves relative paths against a baseURL", () => {
    expect(resolveURL("https://api.example.com", "/users")).toBe("https://api.example.com/users");
    expect(resolveURL("https://api.example.com/", "users")).toBe("https://api.example.com/users");
    expect(resolveURL("https://api.example.com", "https://other.dev/x")).toBe("https://other.dev/x");
    expect(resolveURL(undefined, "/users")).toBe("/users");
  });

  it("merges query params with existing ones", () => {
    expect(buildQuery("/users?page=1", { sort: "name", page: 3 })).toBe("/users?page=3&sort=name");
    expect(buildQuery("/users", { active: true, role: undefined })).toBe("/users?active=true");
    expect(buildQuery("/users", { ids: [1, 2, 3] })).toBe("/users?ids=1%2C2%2C3");
  });

  it("canonicalizes URLs by sorting query params", () => {
    expect(canonicalizeURL("/users?b=1&a=2")).toBe("/users?a=2&b=1");
    expect(canonicalizeURL("/users?a=2&b=1")).toBe("/users?a=2&b=1");
    expect(canonicalizeURL("/users/")).toBe("/users");
    expect(canonicalizeURL("/users?active=true")).toBe("/users?active=true");
  });
});

describe("backoff", () => {
  it("returns exponential delays without jitter", () => {
    expect(computeDelay({ attempts: 0, baseDelay: 1000, jitter: false })).toBe(1000);
    expect(computeDelay({ attempts: 1, baseDelay: 1000, jitter: false })).toBe(2000);
    expect(computeDelay({ attempts: 2, baseDelay: 1000, jitter: false })).toBe(4000);
  });

  it("supports fixed backoff", () => {
    expect(computeDelay({ attempts: 3, baseDelay: 250, backoff: "fixed", jitter: false })).toBe(1000);
  });

  it("caps delays at maxDelay", () => {
    expect(computeDelay({ attempts: 10, baseDelay: 1000, maxDelay: 5000, jitter: false })).toBe(5000);
  });

  it("applies jitter inside [baseDelay, capped]", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = computeDelay({ attempts: 2, baseDelay: 1000, maxDelay: 5000, jitter: true });
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});

describe("fingerprint", () => {
  it("treats reordered query params as the same request", () => {
    const a = createFingerprint({ method: "GET", url: "/users?b=1&a=2" });
    const b = createFingerprint({ method: "GET", url: "/users?a=2&b=1" });
    expect(a).toBe(b);
  });

  it("keeps requests of different methods apart", () => {
    const get = createFingerprint({ method: "GET", url: "/users" });
    const post = createFingerprint({ method: "POST", url: "/users" });
    expect(get).not.toBe(post);
  });

  it("includes relevant headers and body", () => {
    const base = createFingerprint({ method: "POST", url: "/users", headers: { authorization: "Bearer x" }, body: { name: "a" } });
    const other = createFingerprint({ method: "POST", url: "/users", headers: { authorization: "Bearer y" }, body: { name: "a" } });
    expect(base).not.toBe(other);
  });
});

describe("status utils", () => {
  it("parses Retry-After as seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns -1 when absent", () => {
    expect(parseRetryAfter(null)).toBe(-1);
    expect(parseRetryAfter("garbage")).toBe(-1);
  });
});