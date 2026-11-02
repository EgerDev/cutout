import {
  boundFuture,
  cycleInspect,
  defaults,
  framingPatch,
  recordHistory,
  presetPatch,
  type EditSettings,
  type SettingsMap,
  type HistoryEntry,
  type InspectMode,
  type Preset,
  type RemovalMode,
} from "./model.ts";
import type { WorkspaceState } from "../workspace-store.ts";
export type EditorState = {
  settings: SettingsMap;
  past: readonly HistoryEntry[];
  future: readonly SettingsMap[];
  selectedIds: readonly string[];
  excludedIds: readonly string[];
  inspectMode: InspectMode;
  showGuides: boolean;
  /** Outline specks, holes and soft edges on the stage. */
  showCheckAreas: boolean;
  removalMode: RemovalMode;
  /** Item id being enhanced, or null. */
  enhancing: string | null;
  previewUrl: string | null;
  /** Live preview as a bitmap: no PNG encode/decode per slider tick. */
  previewBitmap: ImageBitmap | null;
  previewWidth: number;
  previewHeight: number;
  previewBusy: boolean;
  /** Edits the active image, or `id`: a dialog passes the image it opened on. */
  changeEdit: (patch: Partial<EditSettings>, group?: string, id?: string) => void;
  setPreset: (preset: Preset) => void;
  /** Apply a preset to every selected image, sized from each image's own dimensions. */
  applyPresetSelected: (preset: Preset) => void;
  matchFraming: () => void;
  setInspectMode: (mode: InspectMode) => void;
  cycleInspectMode: () => void;
  setShowGuides: (value: boolean) => void;
  setShowCheckAreas: (value: boolean) => void;
  /** Undo `steps` entries at once (the history panel's "back to here"). */
  jumpBack: (steps: number) => void;
  setRemovalMode: (mode: RemovalMode) => void;
  toggleExcluded: (id: string) => void;
  undo: () => void;
  redo: () => void;
  toggleSelected: (id: string) => void;
  selectAll: () => void;
  applySelected: () => void;
  removeItem: (id: string) => void;
  retryItem: (id: string) => void;
};
export type Get = () => WorkspaceState;
export type Set = (
  partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
) => void;
export function activeSettings(state: Pick<WorkspaceState, "settings" | "activeId">): EditSettings {
  return state.settings[state.activeId ?? ""] ?? defaults;
}
export const editorDefaults = {
  settings: {},
  past: [],
  future: [],
  selectedIds: [],
  excludedIds: [],
  inspectMode: "composite" as const,
  showGuides: false,
  showCheckAreas: false,
  removalMode: "auto" as const,
  enhancing: null,
  previewUrl: null,
  previewBitmap: null,
  previewWidth: 0,
  previewHeight: 0,
  previewBusy: false,
};
export function editorActions(
  get: Get,
  set: Set,
): Pick<
  EditorState,
  | "changeEdit"
  | "setPreset"
  | "applyPresetSelected"
  | "matchFraming"
  | "setInspectMode"
  | "cycleInspectMode"
  | "setShowGuides"
  | "setShowCheckAreas"
  | "jumpBack"
  | "setRemovalMode"
  | "toggleExcluded"
  | "undo"
  | "redo"
  | "toggleSelected"
  | "selectAll"
  | "applySelected"
> {
  function commit(settings: SettingsMap, key: string, coalesce = true) {
    const state = get();
    set({
      settings,
      past: recordHistory(state.past, state.settings, key, Date.now(), coalesce),
      future: [],
    });
  }
  return {
    changeEdit: (patch, group, id) => {
      const state = get();
      const target = id ?? state.activeId;
      if (!target || !state.items.some((item) => item.id === target)) return;
      const old = state.settings[target] ?? defaults;
      if (Object.entries(patch).every(([key, value]) => Reflect.get(old, key) === value)) return;
      commit(
        { ...state.settings, [target]: { ...old, ...patch } },
        `${target}:${group ?? Object.keys(patch).join(",")}`,
        Boolean(group),
      );
    },
    setPreset: (preset) => {
      const state = get();
      const item = state.items.find((entry) => entry.id === state.activeId);
      state.changeEdit(presetPatch(preset, item && item.width ? item : undefined));
    },
    applyPresetSelected: (preset) => {
      const state = get(),
        settings = { ...state.settings };
      for (const id of state.selectedIds) {
        const item = state.items.find((entry) => entry.id === id);
        settings[id] = {
          ...(settings[id] ?? defaults),
          ...presetPatch(preset, item && item.width ? item : undefined),
        };
      }
      commit(settings, "preset-batch", false);
    },
    matchFraming: () => {
      const state = get(),
        source = framingPatch(activeSettings(state)),
        settings = { ...state.settings };
      for (const id of state.selectedIds) {
        if (id === state.activeId) continue;
        settings[id] = { ...(settings[id] ?? defaults), ...source };
      }
      commit(settings, "framing", false);
    },
    setInspectMode: (inspectMode) => set({ inspectMode }),
    cycleInspectMode: () => set({ inspectMode: cycleInspect(get().inspectMode) }),
    setShowGuides: (showGuides) => set({ showGuides }),
    setShowCheckAreas: (showCheckAreas) => set({ showCheckAreas }),
    jumpBack: (steps) => {
      const s = get();
      const count = Math.min(steps, s.past.length);
      if (count <= 0) return;
      const target = s.past[s.past.length - count];
      if (!target) return;
      // Everything undone becomes redo-able, nearest state first (as undo() builds it).
      const undone = [
        ...s.past.slice(s.past.length - count + 1).map((entry) => entry.settings),
        s.settings,
      ];
      set({
        settings: target.settings,
        past: s.past.slice(0, s.past.length - count),
        future: boundFuture([...undone, ...s.future]),
      });
    },
    setRemovalMode: (removalMode) => set({ removalMode }),
    toggleExcluded: (id) => {
      if (!get().items.some((item) => item.id === id)) return;
      set({
        excludedIds: get().excludedIds.includes(id)
          ? get().excludedIds.filter((key) => key !== id)
          : [...get().excludedIds, id],
      });
    },
    undo: () => {
      const s = get(),
        last = s.past.at(-1);
      if (!last) return;
      set({
        settings: last.settings,
        past: s.past.slice(0, -1),
        future: boundFuture([s.settings, ...s.future]),
      });
    },
    redo: () => {
      const s = get(),
        next = s.future[0];
      if (!next) return;
      set({
        settings: next,
        past: recordHistory(s.past, s.settings, "redo", Date.now(), false),
        future: s.future.slice(1),
      });
    },
    toggleSelected: (id) => {
      if (!get().items.some((i) => i.id === id)) return;
      set({
        selectedIds: get().selectedIds.includes(id)
          ? get().selectedIds.filter((i) => i !== id)
          : [...get().selectedIds, id],
      });
    },
    selectAll: () =>
      set({
        selectedIds:
          get().selectedIds.length === get().items.length ? [] : get().items.map((i) => i.id),
      }),
    applySelected: () => {
      const state = get(),
        source = activeSettings(state),
        settings = { ...state.settings };
      for (const id of state.selectedIds) {
        if (id === state.activeId) continue;
        const target = settings[id] ?? defaults;
        settings[id] = { ...source, strokes: target.strokes, hints: target.hints };
      }
      commit(settings, "batch", false);
    },
  };
}
