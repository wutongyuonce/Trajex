// Vue Router configuration for Trajex.
// Routes map to the main content views; sidebar navigation drives route changes.

import { createRouter, createWebHashHistory } from 'vue-router';

// Lazy-loaded view components (will be created as Vue SFCs later)
const SessionList = () => import('./views/SessionList.vue');
const SessionDetail = () => import('./views/SessionDetail.vue');
const SubagentDetail = () => import('./views/SubagentDetail.vue');
const MemoryList = () => import('./views/MemoryList.vue');
const Activity = () => import('./views/Activity.vue');
const Settings = () => import('./views/Settings.vue');

const routes = [
  {
    path: '/sessions',
    name: 'SessionList',
    component: SessionList
  },
  {
    path: '/sessions/:id',
    name: 'SessionDetail',
    component: SessionDetail,
    props: true
  },
  {
    path: '/sessions/:id/agent/:agentId',
    name: 'SubagentDetail',
    component: SubagentDetail,
    props: true
  },
  {
    path: '/memory',
    name: 'MemoryList',
    component: MemoryList
  },
  {
    path: '/memory/:id',
    name: 'MemoryDetail',
    component: MemoryList,
    props: true
  },
  {
    path: '/activity',
    name: 'Activity',
    component: Activity
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings
  },
  {
    path: '/',
    redirect: '/memory'
  },
  {
    // Catch-all redirect
    path: '/:pathMatch(.*)*',
    redirect: '/memory'
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;
