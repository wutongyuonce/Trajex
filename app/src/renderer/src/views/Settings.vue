<!-- Copyright (C) 2026 wutongyuonce and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { isZh, locale, setLocale, t } from '../i18n.js';

defineOptions({ name: 'Settings' });

const THEME_KEY = 'trajex:theme';
const currentTheme = ref(
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
);

function selectTheme(nextTheme) {
  currentTheme.value = nextTheme;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = nextTheme;
  }
  try {
    localStorage.setItem(THEME_KEY, nextTheme);
  } catch {}
}

const sources = ref([]);
const dbPath = ref('');
const autoRefresh = ref(true);
const memoryCount = ref(0);
const rebuilding = ref(false);
const rebuildError = ref('');
const settingsRecovery = ref('');
const saveError = ref('');
const version = ref('');

// 历史保留、快照与多端同步（ADR-0014）。
const autoSnapshot = ref(true);
const snapshotKeep = ref(3);
const syncDir = ref('');
const deviceName = ref('');
const retention = ref({ missingSources: 0, partialSessions: 0, missingSessions: 0, snapshots: [], peers: [] });
const purgeAge = ref(0);
const confirmingPurge = ref(false);
const confirmingRestore = ref('');
const retentionBusy = ref('');
const retentionError = ref('');
const retentionNotice = ref('');
const KEEP_OPTIONS = [1, 2, 3, 5, 7, 10, 20];
const ageOptions = computed(() => [
  { value: 0, label: t('settings.ageAny') },
  { value: 7, label: t('settings.age7') },
  { value: 30, label: t('settings.age30') },
  { value: 90, label: t('settings.age90') },
]);

onMounted(async () => {
  await loadSettings();
  await loadRetention();
});

async function loadSettings() {
  if (!window.trajex?.getSettings) return;
  const s = await window.trajex.getSettings();
  sources.value = s.sources || [];
  dbPath.value = s.dbPath || '';
  autoRefresh.value = s.autoRefresh !== false;
  memoryCount.value = s.memoryCount || 0;
  settingsRecovery.value = s.settingsRecovery || '';
  version.value = s.version || '';
  autoSnapshot.value = s.autoSnapshot !== false;
  snapshotKeep.value = s.snapshotKeep || 3;
  syncDir.value = s.syncDir || '';
  deviceName.value = s.deviceName || '';
}

async function loadRetention() {
  if (!window.trajex?.getRetentionSummary) return;
  try {
    const summary = await window.trajex.getRetentionSummary(purgeAge.value);
    if (summary?.ok !== false) retention.value = summary;
  } catch (error) {
    retentionError.value = error instanceof Error ? error.message : String(error);
  }
}

/** 长时间的维护操作：同一时间只允许一个，完成后刷新概览。 */
async function runRetention(label, work, notice) {
  if (retentionBusy.value) return;
  retentionBusy.value = label;
  retentionError.value = '';
  retentionNotice.value = '';
  try {
    const result = await work();
    retentionNotice.value = notice(result);
  } catch (error) {
    retentionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    retentionBusy.value = '';
    confirmingPurge.value = false;
    confirmingRestore.value = '';
    await Promise.all([loadSettings(), loadRetention()]);
  }
}

function purgeMissing() {
  return runRetention('purge', () => window.trajex.purgeMissingHistory(purgeAge.value), (r) => (
    r.sources
      ? (isZh.value
        ? `已清理 ${r.sessions} 个会话与 ${r.sources} 个缺失来源（已先自动保存快照）。`
        : `Removed ${r.sessions} sessions and ${r.sources} missing sources. A snapshot was kept first.`)
      : (isZh.value ? '没有需要清理的缺失来源。' : 'Nothing to remove.')
  ));
}

function takeSnapshot() {
  return runRetention('snapshot', () => window.trajex.takeSnapshot(), r => (
    isZh.value ? `已保存快照 ${r.snapshot.name}。` : `Snapshot ${r.snapshot.name} saved.`
  ));
}

function restoreSnapshot(name) {
  return runRetention('restore', () => window.trajex.restoreSnapshot(name), r => (
    isZh.value
      ? `已恢复快照 ${r.restored}，当前记忆已保留${r.safety ? `（恢复前索引已备份为 ${r.safety.name}）` : ''}。`
      : `Restored ${r.restored}. Your current memories were kept${r.safety ? `, and the previous index was saved as ${r.safety.name}` : ''}.`
  ));
}

async function toggleAutoSnapshot() {
  autoSnapshot.value = !autoSnapshot.value;
  await saveSetting('autoSnapshot', autoSnapshot.value);
}

async function changeSnapshotKeep(event) {
  snapshotKeep.value = Number(event.target.value);
  await saveSetting('snapshotKeep', snapshotKeep.value);
}

async function changePurgeAge(event) {
  purgeAge.value = Number(event.target.value);
  confirmingPurge.value = false;
  await loadRetention();
}

function fmtBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function fmtSnapshotTime(ms) {
  return new Date(ms).toLocaleString(isZh.value ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function reasonLabel(reason) {
  return t(`settings.reason.${reason}`);
}

function revealSnapshots() {
  window.trajex?.revealSnapshots?.();
}

async function browseSyncDir() {
  if (!window.trajex?.browseFolder) return;
  const chosen = await window.trajex.browseFolder();
  if (chosen) {
    syncDir.value = chosen;
    await saveSetting('syncDir', chosen);
    await syncNow();
  }
}

async function clearSyncDir() {
  syncDir.value = '';
  await saveSetting('syncDir', '');
  await loadRetention();
}

async function saveDeviceName() {
  if (!deviceName.value.trim()) return;
  await saveSetting('deviceName', deviceName.value.trim());
}

function syncNow() {
  return runRetention('sync', () => window.trajex.syncNow(), (r) => (
    isZh.value
      ? `已导出本机 ${r.exportedSessions} 个会话（${r.exportedMemories} 条记忆）；从 ${r.importedPeers} 台设备导入了 ${r.importedSessions} 个会话。`
      : `Exported ${r.exportedSessions} sessions (${r.exportedMemories} memories); imported ${r.importedSessions} sessions from ${r.importedPeers} peer(s).`
  ));
}

function removePeer(peerDeviceId) {
  return runRetention(
    'remove-peer',
    () => window.trajex.removeSyncPeer(peerDeviceId),
    () => (isZh.value ? '已移除该同步设备的导入数据。' : 'Removed synced device data.'),
  );
}

async function browseSourcePath(source) {
  if (!window.trajex?.browseFolder) return;
  const result = await window.trajex.browseFolder();
  if (result) {
    await saveSetting(source.settingKey || `providerRoots.${source.id}`, result);
    await loadSettings();
  }
}

async function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  await saveSetting('autoRefresh', autoRefresh.value);
}

async function saveSetting(key, value) {
  if (!window.trajex?.setSetting) return;
  try {
    const result = await window.trajex.setSetting(key, value);
    settingsRecovery.value = result?.settingsRecovery || '';
    saveError.value = '';
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  }
}

async function rebuildIndex() {
  if (rebuilding.value || !window.trajex?.rebuildIndex) return;
  rebuilding.value = true;
  rebuildError.value = '';
  await nextTick();
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await window.trajex.rebuildIndex();
    await loadSettings();
    await loadRetention();
  } catch (error) {
    rebuildError.value = error instanceof Error ? error.message : String(error);
  } finally {
    rebuilding.value = false;
  }
}

async function revealDb() {
  if (window.trajex?.revealPath) {
    window.trajex.revealPath(dbPath.value);
  }
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return isZh.value ? '刚刚' : 'just now';
  if (min < 60) return isZh.value ? `${min} 分钟前` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return isZh.value ? `${hr} 小时前` : `${hr}h ago`;
  return isZh.value ? `${Math.floor(hr / 24)} 天前` : `${Math.floor(hr / 24)}d ago`;
}
</script>

<template>
  <div class="settings-wrap">
    <div class="settings-content">

      <!-- Appearance & Language -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>{{ t('settings.appearanceTitle') }}</h2>
          <p>{{ t('settings.appearanceDesc') }}</p>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('settings.language') }}</div>
          <div class="form-control">
            <div class="segmented">
              <button type="button" class="seg-btn" :class="{ active: locale === 'zh' }" @click="setLocale('zh')">中文</button>
              <button type="button" class="seg-btn" :class="{ active: locale === 'en' }" @click="setLocale('en')">English</button>
            </div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('settings.theme') }}</div>
          <div class="form-control">
            <div class="segmented">
              <button type="button" class="seg-btn" :class="{ active: currentTheme === 'dark' }" @click="selectTheme('dark')">
                {{ t('settings.themeDark') }}
              </button>
              <button type="button" class="seg-btn" :class="{ active: currentTheme === 'light' }" @click="selectTheme('light')">
                {{ t('settings.themeLight') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Data Sources -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>{{ t('settings.sourcesTitle') }}</h2>
          <p>{{ t('settings.sourcesDesc') }}</p>
        </div>

        <div v-if="saveError" class="status-row error settings-notice">
          <span class="status-dot error"></span>
          <span>{{ saveError }}</span>
        </div>

        <div v-if="settingsRecovery" class="status-row warn settings-notice">
          <span class="status-dot warn"></span>
          <span>{{ settingsRecovery }}</span>
        </div>

        <div
          v-for="src in sources" :key="src.id"
          class="source-card"
          :class="{ error: src.status === 'error', warn: src.status === 'warn' }"
        >
          <div class="source-card-head">
            <div class="source-card-info">
              <div class="source-card-name">
                {{ src.name }}
                <span class="vendor">by {{ src.vendor }}</span>
              </div>
              <div class="source-card-status">
                <span class="stat-dot" :class="src.status"></span>
                <span class="stat-text" :class="src.status">
                  {{ src.status === 'ok' ? t('settings.statusConnected') : src.statusText }}
                </span>
                <template v-if="src.lastIndexed">
                  <span class="sep">·</span>
                  <span>{{ isZh ? '最近读取' : 'last read' }} <strong>{{ fmtRelative(src.lastIndexed) }}</strong></span>
                </template>
                <template v-if="src.sessionCount">
                  <span class="sep">·</span>
                  <span><strong>{{ src.sessionCount }}</strong> {{ isZh ? '个会话' : 'sessions' }}</span>
                </template>
              </div>
            </div>
          </div>
          <div class="source-card-body">
            <div class="control-bar">
              <input class="path-field" :class="{ error: src.status === 'error' }" type="text" :value="src.path" spellcheck="false" readonly/>
              <div class="control-bar-actions">
                <button class="btn action-btn" @click="browseSourcePath(src)">
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                    <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
                  </svg>
                  {{ t('settings.browse') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Index -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>{{ t('settings.indexTitle') }}</h2>
          <p>{{ t('settings.subtitle') }}</p>
        </div>

        <div class="form-row">
          <div class="form-label">{{ t('settings.database') }}</div>
          <div class="form-control">
            <div class="control-bar">
              <input class="path-field" type="text" :value="dbPath" spellcheck="false" readonly/>
              <div class="control-bar-actions">
                <button class="btn action-btn" @click="revealDb">{{ t('settings.reveal') }}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">{{ t('settings.autoRefresh') }}</div>
          <div class="form-control">
            <label class="toggle-label" @click.prevent="toggleAutoRefresh">
              <span class="toggle-track" :class="{ on: autoRefresh }">
                <span class="toggle-thumb"></span>
              </span>
              <span class="toggle-text">{{ t('settings.autoRefreshDesc') }}</span>
            </label>
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">{{ t('settings.rebuild') }}</div>
          <div class="form-control">
            <div class="control-bar-actions">
              <button class="btn action-btn" :disabled="rebuilding" @click="rebuildIndex">
                {{ rebuilding ? t('settings.rebuildingBtn') : t('settings.rebuildBtn') }}
              </button>
            </div>
            <div class="reset-hint">{{ t('settings.rebuildHint') }}</div>
            <div v-if="rebuildError" class="reset-error">{{ rebuildError }}</div>
          </div>
        </div>
      </section>

      <!-- History, snapshots & sync -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>{{ t('settings.retentionTitle') }}</h2>
          <p>{{ t('settings.retentionDesc') }}</p>
        </div>

        <div v-if="retentionError" class="status-row error settings-notice">
          <span class="status-dot error"></span>
          <span>{{ retentionError }}</span>
        </div>
        <div v-if="retentionNotice" class="status-row ok settings-notice">
          <span class="status-dot ok"></span>
          <span>{{ retentionNotice }}</span>
        </div>

        <div class="form-row">
          <div class="form-label">
            {{ t('settings.keptHistory') }}
            <div class="form-label-hint">{{ t('settings.keptHistoryHint') }}</div>
          </div>
          <div class="form-control">
            <div class="retention-stats">
              {{ t('settings.keptSummary', {
                missing: retention.missingSessions,
                partial: retention.partialSessions,
                sources: retention.missingSources,
              }) }}
            </div>
            <div class="control-bar">
              <select class="select" :value="purgeAge" :disabled="!!retentionBusy" @change="changePurgeAge">
                <option v-for="option in ageOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <div class="control-bar-actions">
                <button v-if="!confirmingPurge" class="btn action-btn" :disabled="!!retentionBusy || !retention.missingSources" @click="confirmingPurge = true">
                  {{ t('settings.purgeBtn', { n: retention.missingSources }) }}
                </button>
                <template v-else>
                  <button class="btn danger" :disabled="!!retentionBusy" @click="purgeMissing">
                    {{ retentionBusy === 'purge' ? t('settings.purging') : t('settings.purgeConfirm') }}
                  </button>
                  <button class="btn subtle" :disabled="!!retentionBusy" @click="confirmingPurge = false">{{ t('settings.cancel') }}</button>
                </template>
              </div>
            </div>
            <div class="reset-hint">{{ t('settings.purgeHint') }}</div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">
            {{ t('settings.snapshots') }}
            <div class="form-label-hint">{{ t('settings.snapshotsHint') }}</div>
          </div>
          <div class="form-control">
            <label class="toggle-label" @click.prevent="toggleAutoSnapshot">
              <span class="toggle-track" :class="{ on: autoSnapshot }"><span class="toggle-thumb"></span></span>
              <span class="toggle-text">{{ t('settings.dailySnapshot') }}</span>
            </label>
            <div class="control-bar">
              <select class="select" :value="snapshotKeep" @change="changeSnapshotKeep">
                <option v-for="n in KEEP_OPTIONS" :key="n" :value="n">{{ t('settings.keepCount', { n }) }}</option>
              </select>
              <div class="control-bar-actions">
                <button class="btn action-btn" :disabled="!!retentionBusy" @click="takeSnapshot">
                  {{ retentionBusy === 'snapshot' ? t('settings.savingSnapshot') : t('settings.snapshotNow') }}
                </button>
                <button class="btn" @click="revealSnapshots">{{ t('settings.showFolder') }}</button>
              </div>
            </div>
            <div v-if="retention.snapshots?.length" class="item-table">
              <div v-for="snap in retention.snapshots" :key="snap.name" class="item-row">
                <span class="item-primary">{{ fmtSnapshotTime(snap.createdAt) }}</span>
                <span class="item-meta">{{ reasonLabel(snap.reason) }} · {{ fmtBytes(snap.bytes) }}</span>
                <div class="item-actions">
                  <template v-if="confirmingRestore === snap.name">
                    <button class="btn danger" :disabled="!!retentionBusy" @click="restoreSnapshot(snap.name)">
                      {{ retentionBusy === 'restore' ? t('settings.restoring') : t('settings.restoreConfirm') }}
                    </button>
                    <button class="btn subtle" :disabled="!!retentionBusy" @click="confirmingRestore = ''">{{ t('settings.cancel') }}</button>
                  </template>
                  <button v-else class="btn subtle" :disabled="!!retentionBusy" @click="confirmingRestore = snap.name">{{ t('settings.restore') }}</button>
                </div>
              </div>
            </div>
            <div v-else class="reset-hint">{{ t('settings.noSnapshots') }}</div>
            <div class="reset-hint">{{ t('settings.snapshotHint') }}</div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">
            {{ t('settings.folderSync') }}
            <div class="form-label-hint">{{ t('settings.folderSyncHint') }}</div>
          </div>
          <div class="form-control">
            <div class="control-bar">
              <input
                type="text"
                class="path-field"
                :value="syncDir"
                :placeholder="t('settings.syncFolderPlaceholder')"
                readonly
              />
              <div class="control-bar-actions">
                <button class="btn action-btn" :disabled="!!retentionBusy" @click="browseSyncDir">{{ t('settings.selectFolder') }}</button>
                <button v-if="syncDir" class="btn subtle" :disabled="!!retentionBusy" @click="clearSyncDir">{{ t('settings.clear') }}</button>
              </div>
            </div>
            <div class="control-bar">
              <input
                v-model="deviceName"
                type="text"
                class="path-field"
                :placeholder="t('settings.deviceNamePlaceholder')"
                @change="saveDeviceName"
              />
              <div class="control-bar-actions">
                <button class="btn action-btn" :disabled="!!retentionBusy || !syncDir" @click="syncNow">
                  {{ retentionBusy === 'sync' ? t('settings.syncing') : t('settings.syncNow') }}
                </button>
              </div>
            </div>
            <div v-if="retention.peers?.length" class="item-table">
              <div v-for="peer in retention.peers" :key="peer.deviceId" class="item-row">
                <span class="item-primary">{{ peer.deviceName }}</span>
                <span class="item-meta">
                  {{ t('settings.peerMeta', { n: peer.sessions }) }}
                  <template v-if="peer.lastSyncedAt"> · {{ t('settings.peerSyncedAt', { time: fmtSnapshotTime(peer.lastSyncedAt) }) }}</template>
                </span>
                <div class="item-actions">
                  <button class="btn subtle" :disabled="!!retentionBusy" @click="removePeer(peer.deviceId)">{{ t('settings.removePeer') }}</button>
                </div>
              </div>
            </div>
            <div class="reset-hint">{{ t('settings.syncExplain') }}</div>
          </div>
        </div>
      </section>

      <!-- About -->
      <section class="settings-section last">
        <div class="settings-section-head">
          <h2>{{ t('settings.aboutTitle') }}</h2>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('settings.version') }}</div>
          <div class="form-control">
            <div class="version-text">Trajex {{ version }}</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('settings.storage') }}</div>
          <div class="form-control">
            <div class="version-text">{{ t('settings.storageDesc') }}</div>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>

<style scoped>
.settings-wrap { flex: 1; overflow-y: auto; min-height: 0; }
.settings-content { max-width: 740px; margin: 0 auto; padding: 36px 32px 80px; }

.settings-section { margin-bottom: 40px; }
.settings-section.last { margin-bottom: 0; }
.settings-section-head {
  margin-bottom: 14px; padding-bottom: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.16);
}
.settings-section-head h2 {
  font-size: 17px; font-weight: 600;
  color: var(--fg); letter-spacing: -0.01em; margin-bottom: 2px;
}
.settings-section-head p {
  font-size: 12.5px; color: var(--muted);
}

/* Source cards */
.source-card {
  padding: 16px; border: 1px solid rgba(255,255,255,0.16); border-radius: 8px;
  background: rgba(0,0,0,0.18); margin-bottom: 10px;
  transition: border-color 0.15s;
}
[data-theme='light'] .settings-section-head { border-color: var(--hairline); }
[data-theme='light'] .source-card { background: #fff; border-color: var(--hairline); }
.source-card:hover { border-color: rgba(255,255,255,0.28); }
[data-theme='light'] .source-card:hover { border-color: var(--hairline-strong); }
.source-card.error { border-color: rgba(248,113,113,0.25); }
.source-card.warn { border-color: rgba(251,191,36,0.20); }
.source-card-head { margin-bottom: 12px; }
.source-card-info { flex: 1; min-width: 0; }
.source-card-name {
  font-size: 13.5px; color: var(--fg); font-weight: 600; letter-spacing: -0.005em;
  display: flex; align-items: baseline; gap: 8px;
}
.source-card-name .vendor { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.source-card-status {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
  margin-top: 3px; display: flex; align-items: center; gap: 8px;
}
.source-card-status .stat-dot { width: 6px; height: 6px; border-radius: 50%; position: relative; }
.source-card-status .stat-dot.ok { background: #34d399; box-shadow: 0 0 5px rgba(52,211,153,0.5); }
.source-card-status .stat-dot.warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251,191,36,0.5); }
.source-card-status .stat-dot.error { background: #f87171; box-shadow: 0 0 5px rgba(248,113,113,0.5); }
.source-card-status .stat-dot.ok::before {
  content: ''; position: absolute; inset: -2.5px; border-radius: 50%;
  border: 1px solid #34d399; opacity: 0.5; animation: src-pulse 1.6s ease-out infinite;
}
@keyframes src-pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.8); opacity: 0; } }
.source-card-status .stat-text { color: var(--fg-2); }
.source-card-status .stat-text.ok { color: #34d399; }
.source-card-status .stat-text.warn { color: #fbbf24; }
.source-card-status .stat-text.error { color: #f87171; }
.source-card-status .sep { color: var(--muted-3); }
.source-card-status strong { color: var(--fg-2); font-weight: 500; }
.source-card-body { display: flex; flex-direction: column; gap: 10px; }

/* Strict 2-column form grid: labels and first control row share a 28px baseline */
.form-row {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 24px;
  padding: 14px 0;
  align-items: start;
}
.form-row + .form-row { border-top: 1px solid rgba(255,255,255,0.12); }
[data-theme='light'] .form-row + .form-row { border-color: var(--hairline); }
.form-label {
  font-size: 13px; color: var(--fg-2); font-weight: 500;
  line-height: 20px; padding-top: 4px;
}
.form-label-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 3px; font-weight: 400; line-height: 1.4;
}
.form-control {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
}

/* Unified [ 1fr field/select ] + [ right-aligned action buttons ] row */
.control-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: 100%;
}
.control-bar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.path-field, .select {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  background: var(--theme-code-bg);
  border: 1px solid rgba(255,255,255,0.22);
  border-radius: 5px;
  font-size: 12px;
  color: var(--fg);
  min-width: 0;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.path-field { font-family: var(--font-mono); }
.path-field::placeholder { color: var(--muted-2); font-family: var(--font-sans); }
.path-field:focus, .select:focus {
  outline: 0;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
[data-theme='light'] .path-field,
[data-theme='light'] .select {
  border-color: var(--hairline-strong);
  background: var(--surface);
}
.path-field.error { border-color: rgba(248,113,113,0.4); }

.btn {
  box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border: 1px solid rgba(255,255,255,0.22); border-radius: 5px;
  background: var(--surface); color: var(--fg-2);
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all 0.12s; white-space: nowrap;
}
.btn.action-btn { min-width: 112px; }
.btn:hover:not(:disabled) { background: var(--surface-strong); color: var(--fg); border-color: var(--hairline-vivid); }
[data-theme='light'] .btn { border-color: var(--hairline-strong); }
.btn:disabled { opacity: 0.42; cursor: default; }
.btn.subtle { background: transparent; border-color: transparent; color: var(--muted); padding: 0 8px; }
.btn.subtle:hover:not(:disabled) { background: var(--surface); color: var(--fg-2); }
.btn.danger { border-color: rgba(248,113,113,0.45); color: #f87171; }
.btn.danger:hover:not(:disabled) { background: rgba(248,113,113,0.10); color: #fca5a5; }
.btn svg { width: 13px; height: 13px; }

/* Segmented toggle for language / theme */
.segmented {
  display: inline-flex;
  align-self: flex-start;
  height: 28px;
  padding: 2px;
  border-radius: 6px;
  background: var(--theme-code-bg);
  border: 1px solid rgba(255,255,255,0.18);
  gap: 2px;
}
[data-theme='light'] .segmented {
  border-color: var(--hairline-strong);
  background: var(--surface);
}
.seg-btn {
  height: 22px;
  padding: 0 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.12s;
}
.seg-btn:hover { color: var(--fg-2); }
.seg-btn.active {
  background: var(--surface-strong);
  color: var(--fg);
  box-shadow: 0 1px 2px rgba(0,0,0,0.18);
}

.status-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: rgba(0,0,0,0.2);
  border: 1px solid var(--hairline); border-radius: 5px;
  font-family: var(--font-mono); font-size: 11.5px; flex-wrap: wrap;
}
.status-row.ok { border-color: rgba(52,211,153,0.25); background: rgba(52,211,153,0.06); }
.status-row.warn { border-color: rgba(251,191,36,0.25); background: rgba(251,191,36,0.06); }
.status-row.error { border-color: rgba(248,113,113,0.25); background: rgba(248,113,113,0.06); }
.settings-notice { margin-bottom: 10px; word-break: break-word; }

.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.status-dot.ok { background: #34d399; }
.status-dot.warn { background: #fbbf24; }
.status-dot.error { background: #f87171; }

.toggle-label {
  min-height: 28px;
  display: inline-flex; align-items: center; gap: 8px;
  cursor: pointer; align-self: flex-start;
}
.toggle-track {
  position: relative; width: 30px; height: 16px; flex-shrink: 0;
  background: var(--surface-strong); border: 1px solid var(--hairline-strong);
  border-radius: 8px; transition: all 0.15s;
}
.toggle-track.on { background: rgba(167,139,250,0.16); border-color: rgba(167,139,250,0.55); }
.toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--muted); transition: all 0.15s;
}
.toggle-track.on .toggle-thumb {
  left: 16px; background: #c4b5fd;
  box-shadow: 0 0 6px rgba(167,139,250,0.5);
}
.toggle-text { font-size: 12.5px; color: var(--fg-2); }

.version-text {
  min-height: 28px; display: flex; align-items: center;
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-2);
}

.reset-hint {
  font-size: 11.5px; color: var(--muted); line-height: 1.5;
}
.reset-error { margin-top: 4px; color: #f87171; font-size: 11.5px; }

.retention-stats {
  min-height: 28px;
  display: flex; align-items: center;
  font-size: 12.5px; color: var(--fg-2);
}

/* Aligned table container for snapshots and synced peers */
.item-table {
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 5px;
  background: var(--theme-code-bg);
  overflow: hidden;
}
[data-theme='light'] .item-table {
  border-color: var(--hairline-strong);
  background: var(--surface);
}
.item-row {
  display: grid;
  grid-template-columns: minmax(145px, auto) minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--fg-2);
}
.item-row + .item-row {
  border-top: 1px solid var(--hairline);
}
.item-primary {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg);
  white-space: nowrap;
}
.item-meta {
  color: var(--muted);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
