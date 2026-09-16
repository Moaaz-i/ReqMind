<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";

const { theme } = useData();

interface GuideItem {
  title: string;
  text: string;
  link: string;
}

interface GuideSection {
  section: string;
  items: GuideItem[];
}

const sections = computed<GuideSection[]>(() => theme.value.guides ?? []);
const github = computed(() => theme.value.github ?? "");

/** The classic "layers" used throughout the docs — printed as a stack. */
const stack = [
  { id: "01", name: "Transport", desc: "fetch, signals, timeouts, parsing — the raw edge." },
  { id: "02", name: "Scheduler", desc: "when requests may run: priority, concurrency, rate limits, groups." },
  { id: "03", name: "Resilience", desc: "per-endpoint circuit breaking — fail fast, isolate, recover." },
  { id: "04", name: "Intelligence", desc: "observe latency, decide, adapt: timeouts and SWR." },
  { id: "05", name: "Cache & Dedup", desc: "one flight, one copy, shared by every caller." },
];
</script>

<template>
  <div class="home hero">
    <div class="home-inner">
      <p class="home-eyebrow">Request Intelligence Engine · v{{ theme.version?.replace(/^v/, "") }}</p>
      <h1 class="home-heading">Fetch,<br />made <em>thoughtful</em>.</h1>
      <p class="home-lede">
        ReqMind wraps <code>fetch</code> in a deterministic engine — deduplication, an in-memory cache with
        stale-while-revalidate, smart retries, circuit breaking, and an opt-in request scheduler. One tiny,
        zero-dependency, framework-agnostic client.
      </p>

      <div class="home-actions">
        <a class="btn btn-primary" href="/getting-started">Read the guide</a>
        <a class="btn btn-ghost" :href="github || 'https://github.com/Moaaz-i/ReqMind'" target="_blank" rel="noopener">
          Source on GitHub
        </a>
      </div>

      <div class="home-stack" aria-hidden="true">
        <div v-for="layer in stack" :key="layer.id" class="home-stack-layer">
          <span class="layer-id">{{ layer.id }}</span>
          <span class="layer-name">{{ layer.name }}</span>
          <span class="layer-desc">{{ layer.desc }}</span>
        </div>
      </div>

      <div class="home-sections">
        <section v-for="(group, gi) in sections" :key="gi" class="home-section">
          <h2>{{ group.section }}</h2>
          <ul>
            <li v-for="item in group.items" :key="item.link">
              <a :href="item.link">
                <span class="guide-t">{{ item.title }}</span>
                <span class="guide-d">{{ item.text }}</span>
              </a>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>