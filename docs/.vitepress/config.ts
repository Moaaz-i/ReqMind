import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "ReqMind",
  description:
    "A request intelligence engine for the fetch era — dedup, cache, SWR, retries, circuit breaking, and scheduling.",
  cleanUrls: true,
  appearance: false,
  lastUpdated: true,

  markdown: {
    lineNumbers: false,
  },

  themeConfig: {
    nav: [
      { text: "Guides", link: "/getting-started" },
      { text: "Engines", link: "/intelligence" },
      { text: "Reference", link: "/api-reference" },
    ],
    docTitle: "ReqMind",
    docSubtitle: "request intelligence engine",
    github: "https://github.com/Moaaz-i/ReqMind",
    version: "v0.7.0",
    guides: [
      {
        section: "Start",
        items: [
          { title: "Getting started", text: "Install, create a client, first requests", link: "/getting-started" },
          { title: "Request intelligence", text: "Dedup, caching, fingerprints, stale-while-revalidate", link: "/request-intelligence" },
          { title: "Retries & backoff", text: "Retry policy, status table, exponential backoff, jitter", link: "/retries-and-backoff" },
          { title: "Cancellation & timeouts", text: "cancel(), external signals, timeouts, error types", link: "/cancellation-and-timeouts" },
        ],
      },
      {
        section: "Engines",
        items: [
          { title: "Cache invalidation", text: "Mutation invalidation, path / tag / predicate targets", link: "/cache-invalidation" },
          { title: "Intelligence", text: "Observation → Decision → Action, adaptive timeout & SWR", link: "/intelligence" },
          { title: "Resilience", text: "Circuit breakers — per-endpoint failure isolation", link: "/resilience" },
          { title: "Scheduler", text: "Priority lanes, concurrency, rate limits, queue groups", link: "/scheduler" },
        ],
      },
      {
        section: "Reference",
        items: [
          { title: "Events & lifecycle", text: "Every event, payloads, and the tracker state machine", link: "/events-and-lifecycle" },
          { title: "Architecture", text: "Modules, data flow, and internal contracts", link: "/architecture" },
          { title: "API reference", text: "The complete, precise signature reference", link: "/api-reference" },
        ],
      },
    ],
  },
});