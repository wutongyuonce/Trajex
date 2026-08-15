<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- Copyright (C) 2026 wutongyuonce and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, reactive, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { loadSubagentDetail, loadFullText } from '../data.js';
import { reconcileTimelineItems } from '../session-timeline-items.mjs';
import { createSessionDisclosureState } from '../session-disclosures.mjs';
import SessionTimelineRow from '../components/SessionTimelineRow.vue';

defineOptions({ name: 'SubagentDetail' });
const props = defineProps({ id: String, agentId: String });
const router = useRouter();
const route = useRoute();

const messages = ref([]);
const summaries = ref([]);
const timelineItems = ref([]);
const expandedMessageText = reactive(new Map());
const fullTextLoading = reactive(new Set());
const disclosures = createSessionDisclosureState();
const loading = ref(false);
let revision = 0;

onMounted(async () => { await load(revision, props.agentId); });
watch(() => props.agentId, async (n, o) => {
  if (!n || n === o) return;
  revision += 1;
  messages.value = [];
  summaries.value = [];
  timelineItems.value = [];
  expandedMessageText.clear();
  disclosures.restore([]);
  await load(revision, n);
});

async function load(requestRevision, agentId) {
  if (!agentId) return;
  loading.value = true;
  try {
    const detail = await loadSubagentDetail(agentId);
    if (revision !== requestRevision || props.agentId !== agentId) return;
    messages.value = detail.messages;
    summaries.value = detail.summaries;
    timelineItems.value = reconcileTimelineItems([], detail.messages, detail.summaries);
  } finally {
    if (revision === requestRevision && props.agentId === agentId) loading.value = false;
  }
}

async function handleLoadFull(uuid) {
  const requestRevision = revision;
  const agentId = props.agentId;
  const full = await loadFullText(uuid);
  if (!full || revision !== requestRevision || props.agentId !== agentId) return;
  if (!messages.value.some(message => message.uuid === uuid)) return;
  expandedMessageText.set(uuid, full);
}

async function handleLoadFullText(uuid) {
  if (fullTextLoading.has(uuid)) return;
  fullTextLoading.add(uuid);
  try {
    await handleLoadFull(uuid);
  } finally {
    fullTextLoading.delete(uuid);
  }
}

function navigateToSubagent(agentId) {
  router.push({
    name: 'SubagentDetail',
    params: { id: props.id || route.params.id, agentId },
  });
}
</script>

<template>
  <div class="session-detail-wrap" ref="wrapRef">
    <div class="detail-wide">
      <div class="session-header">
        <div class="session-eyebrow">
          <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Subagent</span>
        </div>
        <div class="session-title">{{ agentId }}</div>
        <div class="session-meta-inline">
          <span>{{ messages.length }} messages</span>
        </div>
      </div>

      <div v-if="loading" class="empty">Loading…</div>

      <div v-if="!loading" class="timeline">
        <SessionTimelineRow
          v-for="item in timelineItems"
          :key="item.key"
          :item="item"
          :disclosures="disclosures"
          :expanded-message-text="expandedMessageText"
          :full-text-loading="fullTextLoading"
          @load-full-text="handleLoadFullText"
          @navigate-subagent="navigateToSubagent"
        />
      </div>
    </div>
  </div>
</template>
