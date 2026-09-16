<script setup lang="ts">
import { computed } from "vue";
import { useData, useRoute } from "vitepress";

const { theme } = useData();
const route = useRoute();

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

const order = computed(() => {
  const flat = sections.value.flatMap((s) => s.items.map((i) => i.link));
  const map = new Map<string, number>();
  flat.forEach((link, idx) => map.set(link, idx + 1));
  return map;
});

function isActive(link: string): boolean {
  const target = link.replace(/\/$/, "");
  if (target === "") return route.path === "/";
  return route.path === target || route.path.startsWith(target + "/");
}
</script>

<template>
  <aside class="side" aria-label="Table of contents">
    <div v-for="(section, si) in sections" :key="si" class="side-section">
      <h3 class="side-section-title">{{ section.section }}</h3>
      <a
        v-for="(item, ii) in section.items"
        :key="item.link"
        class="side-item"
        :class="{ 'is-active': isActive(item.link) }"
        :href="item.link"
      >
        <span class="num">{{ String(order.get(item.link) ?? ii + 1).padStart(2, "0") }}</span>
        <span class="t">{{ item.title }}</span>
        <span class="d">{{ item.text }}</span>
      </a>
    </div>
  </aside>
</template>