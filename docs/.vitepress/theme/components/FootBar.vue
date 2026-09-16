<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";

const { theme } = useData();
const github = computed(() => theme.value.github ?? "");
const version = computed(() => theme.value.version ?? "");
</script>

<template>
  <footer class="foot">
    <div class="foot-inner">
      <span class="left">ReqMind — the request intelligence engine</span>
      <span class="right">
        MIT · {{ version }}
        <a v-if="github" :href="github" target="_blank" rel="noopener">github.com</a>
      </span>
    </div>
  </footer>
</template>