
--- 2026-06-18 Activity noise folding phase ---
- Task: fold noise sessions/projects in Activity.vue (monthly + daily lists)
- Noise rules already used: NOISE_PROJECT_RE = /^(od-conn-test|[0-9a-f]{6,})/i in App.vue; SessionList: !s.title means noise
- Activity.vue has 3 group types per block: newWorkspaces / newSessions / continued
- Approach: per-block compute noise split, render normal first then single fold banner toggling all noise in that block
- Default collapsed; banner says 'N hidden — likely test/throwaway runs'

