<script setup>
import { computed, watch, ref, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  state,
  getSessionSummary,
  FOLDER_SVG,
  resetListState,
  setView,
  setProject,
  clearSelection,
  setQuery,
  setProjectSearch,
  toggleSort,
  toggleIncludeMessageBodies
} from './store.js';
import { formatProjectLabel } from './utils.js';
import { buildSidebarProjects } from './sidebar-projects.mjs';
import { resolveGlobalShortcut } from './keyboard-shortcuts.mjs';
import { sourceLabel } from './source-catalog.mjs';
import trajexIcon from './assets/trajex-icon.svg';

const router = useRouter();
const route = useRoute();
let searchTimer = null;
const THEME_KEY = 'trajex:theme';
const theme = ref('dark');

function applyTheme(nextTheme) {
  theme.value = nextTheme;
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem(THEME_KEY, nextTheme);
}

function toggleTheme() {
  applyTheme(theme.value === 'dark' ? 'light' : 'dark');
}

const routeSession = computed(() => {
  return getSessionSummary(route.params.id);
});

// --- Sidebar data ---

const activeCount = computed(() => state.memories.filter(m => !m.archived).length);
const archivedCount = computed(() => state.memories.filter(m => m.archived).length);
const totalMemoryCount = computed(() => state.memories.length);
const sessionCount = computed(() => state.sessions.length);

const currentRouteType = computed(() => {
  const name = route.name;
  if (name === 'SessionList' || name === 'SessionDetail' || name === 'SubagentDetail') return 'sessions';
  if (name === 'Activity') return 'activity';
  if (name === 'Settings') return 'settings';
  return 'memory';
});

const sidebarProjectsForCurrentScope = (search = state.projectSearch) => buildSidebarProjects({
  routeType: currentRouteType.value,
  sessions: state.sessions,
  memories: state.memories,
  projects: state.projects,
  view: state.view,
  search,
  formatProjectLabel,
});

const sidebarProjects = computed(() => sidebarProjectsForCurrentScope());

const NOISE_PROJECT_RE = /^(od-conn-test|[0-9a-f]{6,})/i;
const normalProjects = computed(() => sidebarProjects.value.filter(p => p.count > 1 || !NOISE_PROJECT_RE.test(p.label)));
const noiseProjects = computed(() => sidebarProjects.value.filter(p => p.count <= 1 && NOISE_PROJECT_RE.test(p.label)));
const showNoiseProjects = ref(false);

const totalProjectCount = computed(() => {
  return sidebarProjectsForCurrentScope('').length;
});

// --- Toolbar visibility ---

const showToolbar = computed(() => {
  const r = route.name;
  return r === 'SessionList' || r === 'MemoryList';
});

const showSearchMsgsToggle = computed(() => {
  return route.name === 'SessionList';
});

// --- Window title ---

const windowTitle = computed(() => {
  const appName = 'Trajex';
  let scopeText = '';
  if (route.name === 'Activity') {
    scopeText = 'Activity';
  } else if (route.name === 'Settings') {
    scopeText = 'Settings';
  } else if (route.name?.startsWith('Session')) {
    if (route.name === 'SessionDetail' || route.name === 'SubagentDetail') {
      const s = routeSession.value;
      scopeText = s ? `Sessions · ${s.title}` : 'Sessions';
    } else {
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Sessions${proj}`;
    }
  } else {
    if (route.name === 'MemoryDetail') {
      const m = state.memories.find(x => x.id === route.params.id);
      scopeText = m ? `Memory · ${m.path.split('/').pop()}` : 'Memory';
    } else {
      const viewLabel = state.view === 'archived' ? 'Archived' : 'Active';
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Memory · ${viewLabel}${proj}`;
    }
  }
  return { appName, scopeText };
});

watch(() => windowTitle.value.scopeText, (scopeText) => {
  document.title = `${windowTitle.value.appName} — ${scopeText}`;
}, { immediate: true });

// --- Navigation helpers ---

function handleSidebarRoute(routeName) {
  clearTimeout(searchTimer);
  resetListState();
  if (routeName === 'sessions') {
    router.push('/sessions');
  } else if (routeName === 'activity') {
    router.push('/activity');
  } else {
    router.push('/memory');
  }
}

function handleSidebarView(view) {
  setView(view);
  router.push('/memory');
}

function handleClearProject() {
  setProject('all');
}

function handleSidebarProject(slug) {
  setProject(slug);
  if (currentRouteType.value === 'sessions') router.push('/sessions');
  else router.push('/memory');
}

function handleProjectSearch(e) {
  setProjectSearch(e.target.value);
}

// --- Search ---

const searchInputRef = ref(null);
function handleSearch(e) {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setQuery(value);
  }, 200);
}

function handleToggleSort() {
  toggleSort();
}

function handleToggleSearchMsgs() {
  toggleIncludeMessageBodies();
}

function handleGlobalKeydown(event) {
  const tagName = event.target?.tagName;
  const command = resolveGlobalShortcut(event, {
    isTextInput: tagName === 'INPUT' || tagName === 'TEXTAREA' || event.target?.isContentEditable,
    isListRoute: showToolbar.value,
    hasSelection: state.selection.size > 0,
    hasQuery: Boolean(state.query),
  });
  if (!command) return;

  event.preventDefault();
  if (command === 'open-sessions') handleSidebarRoute('sessions');
  else if (command === 'open-active-memories') handleSidebarView('active');
  else if (command === 'open-archived-memories') handleSidebarView('archived');
  else if (command === 'focus-search') {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  } else if (command === 'blur-input') event.target?.blur?.();
  else if (command === 'toggle-sort') handleToggleSort();
  else if (command === 'clear-selection') clearSelection();
  else if (command === 'clear-query') {
    clearTimeout(searchTimer);
    setQuery('');
  }
}

onMounted(() => {
  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
  window.addEventListener('keydown', handleGlobalKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  clearTimeout(searchTimer);
});

// --- Source health dots ---
const sourceDots = ref([]);
const sourceDetails = ref([]);
async function loadSourceDots() {
  if (!window.trajex?.getSettings) return;
  const s = await window.trajex.getSettings();
  sourceDots.value = (s.sources || []).map(src => ({ id: src.id, status: src.status, color: src.color }));
  sourceDetails.value = s.sources || [];
  state.sources = s.sources || [];
}
loadSourceDots();

// --- Source filter ---
const showSourceFilter = ref(false);
const sourceFilterActive = computed(() => state.sourceFilter !== 'all' && state.sourceFilter !== undefined);
const sourceFilterLabel = computed(() => {
  if (!state.sourceFilter || state.sourceFilter === 'all') return 'All sources';
  return sourceLabel(state.sourceFilter, state.sources);
});
function toggleSourceFilter() { showSourceFilter.value = !showSourceFilter.value; }
function setSourceFilter(id) {
  state.sourceFilter = id;
  showSourceFilter.value = false;
}
</script>

<template>
  <div class="app">
    <div class="titlebar">
      <div class="titlebar-text" id="titlebar-text">
        <span class="app-name">{{ windowTitle.appName }}</span>
        <span class="sep">—</span>
        <span class="scope">{{ windowTitle.scopeText }}</span>
      </div>
    </div>

    <div class="columns">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img :src="trajexIcon" alt="" />
          <span class="name">Trajex</span>
          <button class="theme-toggle" type="button" :aria-label="theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'" :title="theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'" @click="toggleTheme">
            <svg v-if="theme === 'dark'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke-linecap="round"/></svg>
            <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.8 10.1A5.8 5.8 0 0 1 5.9 2.2a5.8 5.8 0 1 0 7.9 7.9Z" stroke-linejoin="round"/></svg>
          </button>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title"><span>Library</span></div>
          <button
            class="sidebar-item"
            :class="{ active: currentRouteType === 'sessions' && state.projectFilter === 'all' }"
            @click="handleSidebarRoute('sessions')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 4h10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z" stroke-linejoin="round"/>
              <path d="M5.5 7h5M5.5 9.5h3" stroke-linecap="round"/>
            </svg>
            <span class="label">Sessions</span>
            <span class="badge">{{ sessionCount }}</span>
          </button>
          <button
            class="sidebar-item"
            :class="{ active: currentRouteType === 'memory' && state.view === 'active' && state.projectFilter === 'all' }"
            @click="handleSidebarView('active')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2.5" y="2.5" width="11" height="11" rx="2"/>
              <path d="M5 8h6M5 5.5h6M5 10.5h4" stroke-linecap="round"/>
            </svg>
            <span class="label">Memory</span>
            <span class="badge">{{ totalMemoryCount }}</span>
          </button>
          <button
            class="sidebar-item sub"
            :class="{ active: currentRouteType === 'memory' && state.view === 'active' && state.projectFilter === 'all' }"
            @click="handleSidebarView('active')"
          >
            <svg class="icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6" cy="6" r="2" fill="currentColor"/>
            </svg>
            <span class="label">Active</span>
            <span class="badge">{{ activeCount }}</span>
          </button>
          <button
            class="sidebar-item sub"
            :class="{ active: currentRouteType === 'memory' && state.view === 'archived' && state.projectFilter === 'all' }"
            @click="handleSidebarView('archived')"
          >
            <svg class="icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6" cy="6" r="2"/>
            </svg>
            <span class="label">Archived</span>
            <span class="badge">{{ archivedCount }}</span>
          </button>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title"><span>Stats</span></div>
          <button
            class="sidebar-item"
            :class="{ active: route.name === 'Activity' }"
            @click="handleSidebarRoute('activity')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="10" width="2.5" height="4"/>
              <rect x="6" y="6" width="2.5" height="8"/>
              <rect x="10" y="3" width="2.5" height="11"/>
            </svg>
            <span class="label">Activity</span>
          </button>
        </div>

        <div class="sidebar-section projects" v-if="currentRouteType === 'sessions' || currentRouteType === 'memory'">
          <div class="sidebar-section-title">
            <span>Projects</span>
            <button v-if="noiseProjects.length" class="filter-toggle" :class="{ active: showNoiseProjects }" @click.stop="showNoiseProjects = !showNoiseProjects">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M2 6h8M2 3h8M2 9h5"/>
              </svg>
              {{ showNoiseProjects ? 'hide noise' : 'show all' }}
            </button>
          </div>
          <div class="sidebar-search" v-if="totalProjectCount >= 6">
            <svg class="sidebar-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="7" cy="7" r="5"/>
              <path d="M11 11l3 3" stroke-linecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Filter projects…"
              autocomplete="off"
              :value="state.projectSearch"
              @input="handleProjectSearch"
            />
          </div>
          <div class="sidebar-list" id="sidebar-projects">
            <button
              v-for="p in normalProjects"
              :key="p.slug"
              class="sidebar-item"
              :class="{ active: state.projectFilter === p.slug }"
              @click="handleSidebarProject(p.slug)"
            >
              <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                <path d="M2 5.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V6.5A1.5 1.5 0 0 0 12.5 5H8.3L7 3.5H3.5A1.5 1.5 0 0 0 2 5z"/>
              </svg>
              <span class="label">{{ p.label }}</span>
              <span class="badge">{{ p.count }}</span>
            </button>

            <!-- Noise projects fold -->
            <button v-if="noiseProjects.length" class="project-fold" :class="{ expanded: showNoiseProjects }" @click="showNoiseProjects = !showNoiseProjects">
              <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 2.5l3 3.5-3 3.5"/></svg>
              <span class="label">{{ noiseProjects.length }} test projects hidden</span>
              <span class="count">{{ noiseProjects.length }}</span>
            </button>
            <template v-if="showNoiseProjects">
              <button
                v-for="p in noiseProjects"
                :key="p.slug"
                class="sidebar-item noise"
                :class="{ active: state.projectFilter === p.slug }"
                @click="handleSidebarProject(p.slug)"
              >
                <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                  <path d="M2 5.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V6.5A1.5 1.5 0 0 0 12.5 5H8.3L7 3.5H3.5A1.5 1.5 0 0 0 2 5z"/>
                </svg>
                <span class="label">{{ p.label }}</span>
                <span class="badge">{{ p.count }}</span>
              </button>
            </template>
          </div>
        </div>

        <div class="sidebar-section sidebar-bottom">
          <button
            class="sidebar-item"
            :class="{ active: route.name === 'Settings' }"
            @click="router.push('/settings')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="3" y1="4" x2="13" y2="4"/>
              <line x1="3" y1="8" x2="13" y2="8"/>
              <line x1="3" y1="12" x2="13" y2="12"/>
              <circle cx="9.5" cy="4" r="1.7" fill="var(--bg)"/>
              <circle cx="5.5" cy="8" r="1.7" fill="var(--bg)"/>
              <circle cx="11" cy="12" r="1.7" fill="var(--bg)"/>
            </svg>
            <span class="label">Settings</span>
          </button>
        </div>
      </aside>

      <main class="main">
        <div class="toolbar">
          <div class="breadcrumb" id="breadcrumb">
            <template v-if="showToolbar">
              <template v-if="state.projectFilter !== 'all'">
                <button class="crumb" @click="handleClearProject">
                  {{ currentRouteType === 'sessions' ? 'Sessions' : 'Memory' }}
                </button>
                <span class="crumb-sep">/</span>
                <span class="crumb terminal">{{ formatProjectLabel(state.projectFilter) }}</span>
              </template>
              <template v-else>
                <span class="crumb terminal">
                  {{ currentRouteType === 'sessions' ? 'Sessions' : 'Memory' }}
                </span>
              </template>
            </template>
            <template v-else>
              <router-link class="crumb" to="/sessions" v-if="route.name === 'SessionDetail' || route.name === 'SubagentDetail'">
                Sessions
              </router-link>
              <template v-if="route.name === 'SubagentDetail'">
                <span class="crumb-sep">/</span>
                <router-link class="crumb" :to="`/sessions/${route.params.id}`">
                  {{ (routeSession?.title || '').slice(0, 30) || route.params.id }}
                </router-link>
              </template>
              <template v-if="route.name === 'SessionDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal">
                  {{ routeSession?.title || route.params.id }}
                </span>
              </template>
              <template v-if="route.name === 'SubagentDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal">{{ route.params.agentId }}</span>
              </template>
              <router-link class="crumb" to="/memory" v-if="route.name === 'MemoryDetail'">
                Memory
              </router-link>
              <template v-if="route.name === 'MemoryDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal filename">
                  {{ (state.memories.find(m => m.id === route.params.id)?.path || '').split('/').pop() }}
                </span>
              </template>
              <span v-if="route.name === 'Activity'" class="crumb terminal">Activity</span>
              <span v-if="route.name === 'Settings'" class="crumb terminal">Settings</span>
            </template>
          </div>
          <div class="toolbar-spacer"></div>

          <!-- Source filter (session list only, multi-source) -->
          <div v-if="showToolbar && route.name === 'SessionList' && sourceDots.length > 1" class="source-filter-wrap">
            <button class="filter-btn" :class="{ active: sourceFilterActive }" @click="toggleSourceFilter">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M2 3h8M3.5 6h5M5 9h2"/>
              </svg>
              <span class="filter-label">{{ sourceFilterLabel }}</span>
            </button>
            <div class="filter-dropdown" :class="{ show: showSourceFilter }">
              <div
                v-for="src in sourceDots" :key="src.id"
                class="fd-row" :class="{ checked: state.sourceFilter === 'all' || state.sourceFilter === src.id }"
                @click.stop="setSourceFilter(src.id)"
              >
                <div class="fd-check">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
                </div>
                <span class="fd-name">{{ sourceLabel(src.id, sourceDetails) }}</span>
              </div>
              <div class="fd-divider"></div>
              <div class="fd-row" :class="{ checked: state.sourceFilter === 'all' }" @click.stop="setSourceFilter('all')">
                <div class="fd-check">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
                </div>
                <span class="fd-name" style="color: var(--accent-2);">All sources</span>
              </div>
            </div>
          </div>

          <div class="toolbar-search" id="search-wrap" v-if="showToolbar">
            <svg class="toolbar-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="7" cy="7" r="5"/>
              <path d="M11 11l3 3" stroke-linecap="round"/>
            </svg>
            <input
              ref="searchInputRef"
              id="search"
              type="text"
              placeholder="Search…"
              autocomplete="off"
              :value="state.query"
              @input="handleSearch"
            />
            <span class="toolbar-search-kbd">/</span>
          </div>
          <button
            v-if="showToolbar"
            class="sort-group"
            :class="{ desc: state.sortDesc, asc: !state.sortDesc }"
            @click="handleToggleSort"
            id="sort-toggle"
            title="Toggle sort (S)"
          >
            <span class="label" id="sort-label">{{ state.sortDesc ? 'newest' : 'oldest' }}</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path class="arrow-up"   d="M5 6l3-3 3 3"/>
              <path class="arrow-down" d="M5 10l3 3 3-3"/>
            </svg>
          </button>
        </div>

        <router-view v-slot="{ Component }">
          <component
            :is="Component"
            :key="route.name === 'SessionDetail' ? `session:${route.params.id}` : undefined"
          />
        </router-view>
      </main>
    </div>
  </div>
</template>
