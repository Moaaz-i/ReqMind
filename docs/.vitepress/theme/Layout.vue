<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";
import NavBar from "./components/NavBar.vue";
import SideBar from "./components/SideBar.vue";
import Home from "./components/Home.vue";
import FootBar from "./components/FootBar.vue";

const { page, frontmatter } = useData();

const isHome = computed(() => frontmatter.value.layout === "home");

const contentKey = computed(() => page.value.relativePath.replace(/\.md$/, ""));
</script>

<template>
  <div class="app">
    <NavBar />

    <main class="app-main">
      <Home v-if="isHome" />
      <div v-else class="app-canvas">
        <SideBar />
        <article class="page">
          <div class="page-inner">
            <div class="content" :key="contentKey">
              <Content />
            </div>
          </div>
        </article>
      </div>
    </main>

    <FootBar />
  </div>
</template>