<script setup>
defineProps({
  html: { type: String, default: '' },
  open: Boolean,
});

const emit = defineEmits(['toggle']);
</script>

<template>
  <div class="msg-thinking" :class="{ open }">
    <button class="thinking-toggle" @click="emit('toggle')">
      <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
      <span class="thinking-label">Thinking</span>
    </button>
    <div class="thinking-body" v-html="html"></div>
  </div>
</template>
