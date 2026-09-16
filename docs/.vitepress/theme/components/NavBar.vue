<script setup lang="ts">
import { computed } from "vue";
import { useData, useRoute, withBase } from "vitepress";

const { site, theme } = useData();
const route = useRoute();

const activeSection = computed(() => {
  const path = route.path;
  if (path === withBase("/") || path.startsWith(withBase("/getting-started")) || path.startsWith(withBase("/request-intelligence")) || path.startsWith(withBase("/retries-and-backoff")) || path.startsWith(withBase("/cancellation-and-timeouts"))) return "Guides";
  if (path.startsWith(withBase("/intelligence")) || path.startsWith(withBase("/cache-invalidation")) || path.startsWith(withBase("/resilience")) || path.startsWith(withBase("/scheduler"))) return "Engines";
  if (path.startsWith(withBase("/api-reference")) || path.startsWith(withBase("/events-and-lifecycle")) || path.startsWith(withBase("/architecture"))) return "Reference";
  return "";
});

const nav = computed(() => theme.value.nav ?? []);
const github = computed(() => theme.value.github ?? "");
</script>

<template>
  <header class="nav">
    <div class="nav-inner">
      <a class="nav-brand" :href="withBase('/')" aria-label="ReqMind home">
        <span class="wordmark">Req<span class="accent">Mind</span></span>
        <span class="tag">{{ site.title }}</span>
      </a>

      <nav class="nav-links" aria-label="Sections">
        <a
          v-for="item in nav"
          :key="item.link"
          :href="withBase(item.link)"
          :class="{ 'is-active': activeSection === item.text }"
        >{{ item.text }}</a>
      </nav>

      <a v-if="github" class="nav-github" :href="github" target="_blank" rel="noopener">GitHub</a>
    </div>
  </header>
</template>