<script setup lang="ts">
import { computed } from "vue";
import { useData, useRoute } from "vitepress";

const { site, theme } = useData();
const route = useRoute();

const activeSection = computed(() => {
  const path = route.path.replace(/\/$/, "") || "/";
  if (path === "/" || path.startsWith("/getting-started") || path.startsWith("/request-intelligence") || path.startsWith("/retries-and-backoff") || path.startsWith("/cancellation-and-timeouts")) return "Guides";
  if (path.startsWith("/intelligence") || path.startsWith("/cache-invalidation") || path.startsWith("/resilience") || path.startsWith("/scheduler")) return "Engines";
  if (path.startsWith("/api-reference") || path.startsWith("/events-and-lifecycle") || path.startsWith("/architecture")) return "Reference";
  return "";
});

const nav = computed(() => theme.value.nav ?? []);
const github = computed(() => theme.value.github ?? "");
</script>

<template>
  <header class="nav">
    <div class="nav-inner">
      <a class="nav-brand" href="/" aria-label="ReqMind home">
        <span class="wordmark">Req<span class="accent">Mind</span></span>
        <span class="tag">{{ site.title }}</span>
      </a>

      <nav class="nav-links" aria-label="Sections">
        <a
          v-for="item in nav"
          :key="item.link"
          :href="item.link"
          :class="{ 'is-active': activeSection === item.text }"
        >{{ item.text }}</a>
      </nav>

      <a v-if="github" class="nav-github" :href="github" target="_blank" rel="noopener">GitHub</a>
    </div>
  </header>
</template>