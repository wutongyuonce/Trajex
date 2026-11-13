// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  SessionPatch,
  SessionPatchCursor,
  SessionCatalogueOptions,
  ActivitySessionsOptions,
  SessionsQueryOptions,
  SourceQueryOptions,
  UsageStatsOptions,
  WindowControlAction,
} from '../shared/ipc-types.ts';

contextBridge.exposeInMainWorld('trajex', {
  platform: process.platform,
  getSessions: (opts?: SessionsQueryOptions) => ipcRenderer.invoke('db:getSessions', opts),
  getSessionCatalogue: (opts?: SessionCatalogueOptions) => ipcRenderer.invoke('db:getSessionCatalogue', opts),
  getActivitySessions: (opts: ActivitySessionsOptions) => ipcRenderer.invoke('db:getActivitySessions', opts),
  getSessionMessages: (id: string) => ipcRenderer.invoke('db:getSessionMessages', id),
  getSessionToolCalls: (id: string) => ipcRenderer.invoke('db:getSessionToolCalls', id),
  getSessionToolResults: (id: string) => ipcRenderer.invoke('db:getSessionToolResults', id),
  getSessionPatch: async (id: string, cursor: SessionPatchCursor | string): Promise<SessionPatch | null> => (
    ipcRenderer.invoke('db:getSessionPatch', id, typeof cursor === 'string' ? JSON.parse(cursor) : cursor)
  ),
  getSessionSubagents: (id: string) => ipcRenderer.invoke('db:getSessionSubagents', id),
  getSessionWorkflows: (id: string) => ipcRenderer.invoke('db:getSessionWorkflows', id),
  getSubagentMessages: (agentId: string) => ipcRenderer.invoke('db:getSubagentMessages', agentId),
  getSubagentToolCalls: (agentId: string) => ipcRenderer.invoke('db:getSubagentToolCalls', agentId),
  getSubagentToolResults: (agentId: string) => ipcRenderer.invoke('db:getSubagentToolResults', agentId),
  getSubagentSummaries: (agentId: string) => ipcRenderer.invoke('db:getSubagentSummaries', agentId),
  getSessionSummaries: (id: string) => ipcRenderer.invoke('db:getSessionSummaries', id),
  getMessageFullText: (uuid: string) => ipcRenderer.invoke('db:getMessageFullText', uuid),
  getMemories: () => ipcRenderer.invoke('db:getMemories'),
  readMemoryFile: (path: string) => ipcRenderer.invoke('db:readMemoryFile', path),
  previewLocalMarkdownLink: (href: string) => ipcRenderer.invoke('local-link:preview', href),
  openLocalMarkdownLink: (href: string) => ipcRenderer.invoke('local-link:open', href),
  openWebMarkdownLink: (href: string) => ipcRenderer.invoke('web-link:open', href),
  archiveMemory: (id: string, reason?: string) => ipcRenderer.invoke('db:archiveMemory', id, reason),
  restoreMemory: (id: string) => ipcRenderer.invoke('db:restoreMemory', id),
  getProjects: (opts?: SourceQueryOptions) => ipcRenderer.invoke('db:getProjects', opts),
  getStats: (opts?: SourceQueryOptions) => ipcRenderer.invoke('db:getStats', opts),
  getUsageStats: (opts?: UsageStatsOptions) => ipcRenderer.invoke('db:getUsageStats', opts),
  onWindowState: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('trajex:window-state', listener);
    return () => ipcRenderer.removeListener('trajex:window-state', listener);
  },
  onIndexUpdated: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('trajex:index-updated', listener);
    return () => ipcRenderer.removeListener('trajex:index-updated', listener);
  },
  onSessionUpdated: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('trajex:session-updated', listener);
    return () => ipcRenderer.removeListener('trajex:session-updated', listener);
  },
  windowControl: (action: WindowControlAction) => ipcRenderer.invoke('win:control', action),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  browseFolder: () => ipcRenderer.invoke('settings:browseFolder'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  revealPath: (p: string) => ipcRenderer.invoke('settings:revealPath', p),
  rebuildIndex: () => ipcRenderer.invoke('settings:rebuildIndex'),
});
