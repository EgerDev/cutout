// zod/mini: the same validators as classic zod at a fraction of its bundle cost. This
// module loads with the resume control on every first visit.
import * as z from "zod/mini";
import { REMOVAL_FAILURE_KEY, clearRemovalFailureRecords } from "../removal-provider.ts";
import type { WorkspaceState } from "../workspace-store.ts";
import { localWorkspaceDeleted, localWorkspaceGeneration } from "./session-events.ts";

const num = (min: number, max: number) => z.number().check(z.gte(min), z.lte(max));
const int = (min: number, max: number) => z.int().check(z.gte(min), z.lte(max));
const pct = num(0, 100),
  dimension = z.nullable(int(1, 4096));
const blob = z.instanceof(Blob);
const hex = z.string().check(z.regex(/^#[0-9a-f]{6}$/i));
const points = z
  .array(z.object({ x: num(0, 1), y: num(0, 1) }))
  .check(z.minLength(1), z.maxLength(4096));
const settingsSchema = z.object({
  exportFormat: z.enum(["png", "webp", "avif", "heic", "jpeg", "bmp"]),
  exportWidth: dimension,
  exportHeight: dimension,
  background: z.discriminatedUnion("type", [
    z.object({ type: z.literal("transparent") }),
    z.object({ type: z.literal("blur") }),
    z.object({
      type: z.literal("gradient"),
      from: hex,
      to: hex,
      angle: num(0, 360),
    }),
    z.object({ type: z.literal("color"), color: hex }),
    z.object({ type: z.literal("image"), url: z.string() }),
  ]),
  customColor: hex,
  backgroundImageUrl: z.nullable(z.string()),
  backgroundBlob: z.nullable(blob),
  blurAmount: z._default(num(2, 80), 28),
  blurDepth: z._default(z.boolean(), false),
  trimPadding: z._default(num(0, 400), 24),
  stripMetadata: z.boolean(),
  feather: num(0, 16),
  choke: num(-10, 10),
  strokes: z
    .array(
      z.object({
        mode: z.enum(["erase", "restore"]),
        size: num(0.002, 0.3),
        points,
        hardness: z.optional(num(0, 100)),
        flow: z.optional(num(1, 100)),
        preserveDetails: z.optional(z.boolean()),
      }),
    )
    .check(z.maxLength(500)),
  hints: z._default(
    z
      .array(
        z.object({
          kind: z.enum(["keep", "remove"]),
          // Clicked pieces use a pixel-sized disc (PICK_SIZE).
          size: num(0.001, 0.3),
          points,
          areas: z.optional(z.array(num(0, 1)).check(z.maxLength(4096))),
        }),
      )
      .check(z.maxLength(80)),
    [],
  ),
  recolors: z._default(
    z
      .array(
        z.object({
          from: hex,
          to: z.nullable(hex),
        }),
      )
      .check(z.maxLength(24)),
    [],
  ),
  recolorTolerance: z._default(num(1, 120), 24),
  preset: z.enum([
    "original",
    "trim",
    "square",
    "portrait",
    "landscape",
    "story",
    "passport",
    "product",
    "profile",
    "asset",
    "amazon",
    "etsy",
    "ebay",
  ]),
  padding: num(0, 40),
  positionX: pct,
  positionY: pct,
  scale: z._default(num(50, 200), 100),
  rotate: z._default(num(-180, 180), 0),
  flipX: z._default(z.boolean(), false),
  shadow: z.boolean(),
  shadowKind: z._default(z.enum(["contact", "cast"]), "contact"),
  shadowOpacity: num(0, 80),
  shadowSoftness: num(1, 30),
  shadowDistance: num(-5, 10),
  shadowAngle: z._default(num(0, 360), 90),
  shadowSpread: z._default(num(0, 40), 8),
  shadowColor: z._default(hex, "#000000"),
  shadowPerspective: z._default(num(0, 80), 35),
  shadowSilhouette: z._default(z.boolean(), true),
  decontaminate: z._default(z.enum(["off", "auto", "manual"]), "off"),
  decontaminateAmount: z._default(num(0, 100), 50),
  decontaminateWidth: z._default(num(1, 24), 4),
  decontaminateColor: z._default(z.nullable(hex), null),
  matchBackground: z._default(z.boolean(), false),
  matchStrength: z._default(num(0, 100), 50),
  quality: num(15, 100),
  targetKB: z.nullable(num(10, 20000)),
});
export const sessionSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  savedAt: z.number(),
  activeIndex: int(0, 14),
  items: z
    .array(
      z.object({
        name: z.string().check(z.maxLength(1024)),
        source: blob,
        result: z.nullable(blob),
        // Queued/error items can retain declared source dimensions before downscaling.
        // This is metadata, not a request to allocate a canvas at that size.
        width: int(0, 0xffff_ffff),
        height: int(0, 0xffff_ffff),
        settings: settingsSchema,
      }),
    )
    .check(z.minLength(1), z.maxLength(15)),
});
export type SavedSession = z.infer<typeof sessionSchema>;
type SessionInputs = Pick<WorkspaceState, "items" | "settings" | "activeId">;
let updatingReferences = false;

/** Byte-exact backing changes are not edits and must not schedule another autosave. */
export function updateSessionReferences(update: () => void) {
  updatingReferences = true;
  try {
    update();
  } finally {
    updatingReferences = false;
  }
}

let preserveOpenSession = async (snapshot: SavedSession | null) => snapshot;
let preserving: Promise<unknown> = Promise.resolve();
export function setSessionPreserver(preserve: typeof preserveOpenSession) {
  preserveOpenSession = preserve;
}

/** Serialized with other detachments; a failed read must leave the stored copy intact. */
export function prepareSessionMutation(snapshot: SavedSession | null = null) {
  const operation = preserving.catch(() => undefined).then(() => preserveOpenSession(snapshot));
  preserving = operation;
  return operation;
}

/** Whether anything snapshotSession writes differs. Queue progress, status and previews
 * replace `items` constantly; each of those used to rewrite every Blob to IndexedDB. */
export function sessionInputsChanged(next: SessionInputs, old: SessionInputs) {
  if (updatingReferences) return false;
  if (next.activeId !== old.activeId || next.items.length !== old.items.length) return true;
  if (next.items === old.items && next.settings === old.settings) return false;
  return next.items.some((item, index) => {
    const before = old.items[index];
    return (
      !before ||
      item.id !== before.id ||
      item.name !== before.name ||
      item.source !== before.source ||
      item.resultBlob !== before.resultBlob ||
      item.width !== before.width ||
      item.height !== before.height ||
      next.settings[item.id] !== old.settings[item.id]
    );
  });
}

export function snapshotSession(state: WorkspaceState): SavedSession {
  const items = state.items.map((item) => {
    const s = state.settings[item.id];
    if (!s) throw new Error("Image settings are not ready.");
    return {
      name: item.name,
      source: item.source,
      result: item.resultBlob,
      width: item.width,
      height: item.height,
      settings: {
        ...s,
        strokes: s.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })),
        hints: s.hints.map((hint) => ({ ...hint, points: [...hint.points] })),
        backgroundImageUrl: null,
        background:
          s.background.type === "image" ? { type: "image" as const, url: "" } : s.background,
      },
    };
  });
  const blobs = new Set<Blob>();
  for (const item of items) {
    blobs.add(item.source);
    if (item.result) blobs.add(item.result);
    if (item.settings.backgroundBlob) blobs.add(item.settings.backgroundBlob);
  }
  if ([...blobs].reduce((bytes, blob) => bytes + blob.size, 0) > 250_000_000)
    throw new Error("This workspace exceeds 250 MB. Remove some images before saving.");
  const parsed = sessionSchema.safeParse({
    version: 2,
    savedAt: Date.now(),
    activeIndex: Math.max(
      0,
      state.items.findIndex((i) => i.id === state.activeId),
    ),
    items,
  });
  if (!parsed.success)
    throw new Error(
      "This workspace has adjustments that cannot be saved. Your open images and edits are still available.",
    );
  return parsed.data;
}
const DATABASE = "cutout-workspace";
/** Set once a save succeeds, so a visit that never saved does not create the database. */
export const SAVED_FLAG = "cutout.saved";

export function shouldOpenStore({
  hasSaveFlag,
  autosave,
}: {
  hasSaveFlag: boolean;
  autosave: boolean;
}) {
  return hasSaveFlag || autosave;
}

/** Whether this browser holds a saved workspace worth opening. Saves from builds before the
 *  flag existed are found through indexedDB.databases(), which does not create anything. */
export async function hasSavedWorkspace(): Promise<boolean> {
  try {
    if (localStorage.getItem(SAVED_FLAG)) return true;
    const list = await indexedDB.databases?.();
    return Boolean(list?.some((db) => db.name === DATABASE));
  } catch {
    return false;
  }
}

type KeyStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Workspace settings: the save flag, enhance timings (enhance.ts) and the
 *  owned WebGPU failure record, plus the legacy `bg0:webgpu-failure:` notes that an earlier
 *  engine wrote (their value is the user agent). The anonymous deletion receipt survives
 *  so a delayed save in another tab cannot recreate the deleted workspace. */
export function forgetLocalData(storage: KeyStorage) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (
      key === SAVED_FLAG ||
      key === "cutout.enhance.tileMs" ||
      key === REMOVAL_FAILURE_KEY ||
      key?.startsWith("bg0:webgpu-failure:")
    )
      keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/** "Delete saved workspace": the whole database, not just its record, and the local keys. */
export async function deleteSavedWorkspace(): Promise<void> {
  await pending.catch(() => undefined);
  if (deleting?.blocked) throw new Error("Close other Cutout tabs and try again.");
  await prepareSessionMutation();
  const current = (deleting ??= beginDelete());
  await new Promise<void>((resolve, reject) => {
    void current.done.then(resolve, reject);
    if (current.blocked) reject(new Error("Close other Cutout tabs and try again."));
    else current.onBlocked.push(() => reject(new Error("Close other Cutout tabs and try again.")));
  });
}

async function database(assertCurrent = () => {}): Promise<IDBDatabase> {
  if (deleting?.blocked) throw new Error("Close other Cutout tabs and try again.");
  assertCurrent();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      try {
        assertCurrent();
        request.result.createObjectStore("sessions");
      } catch (error) {
        request.transaction?.abort();
        reject(error);
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Local storage is unavailable."));
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other Cutout tabs and try again."));
    };
    request.onsuccess = () => {
      const db = request.result;
      // IndexedDB cannot cancel an open request after onblocked rejected our caller.
      if (blocked) {
        db.close();
        return;
      }
      try {
        assertCurrent();
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
let pending: Promise<unknown> = Promise.resolve();
// IndexedDB cannot cancel deleteDatabase; a second native delete queues indefinitely behind a blocked one.
type PendingDelete = {
  blocked: boolean;
  done: Promise<void>;
  onBlocked: Array<() => void>;
};
let deleting: PendingDelete | null = null;

function beginDelete(): PendingDelete {
  const state: PendingDelete = {
    blocked: false,
    onBlocked: [],
    done: new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE);
      request.onblocked = () => {
        state.blocked = true;
        for (const notify of state.onBlocked.splice(0)) notify();
      };
      request.onsuccess = () => {
        localWorkspaceDeleted();
        resolve();
      };
      request.onerror = () => reject(request.error ?? new Error("Local storage is unavailable."));
    }),
  };
  void state.done
    .then(
      () => {
        forgetLocalData(localStorage);
        clearRemovalFailureRecords(localStorage);
      },
      () => undefined,
    )
    .finally(() => {
      if (deleting === state) deleting = null;
    });
  return state;
}
export function saveSession(
  snapshot: SavedSession | null,
  generation = localWorkspaceGeneration(),
): Promise<number> {
  const assertCurrent = () => {
    if (generation !== localWorkspaceGeneration())
      throw new Error("The saved workspace was deleted. Enable autosave again to save it.");
  };
  const operation = pending
    .catch(() => undefined)
    .then(async () => {
      assertCurrent();
      snapshot = await prepareSessionMutation(snapshot);
      const db = await database(assertCurrent);
      try {
        assertCurrent();
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("sessions", "readwrite");
          if (snapshot) transaction.objectStore("sessions").put(snapshot, "current");
          else transaction.objectStore("sessions").delete("current");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("Saving was interrupted."));
        });
      } finally {
        db.close();
      }
      assertCurrent();
      if (snapshot) localStorage.setItem(SAVED_FLAG, "1");
      return generation;
    });
  pending = operation;
  return operation;
}
export async function loadSession(): Promise<SavedSession | null> {
  await pending.catch(() => undefined);
  const db = await database();
  try {
    const value: unknown = await new Promise((resolve, reject) => {
      const request = db.transaction("sessions").objectStore("sessions").get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value === undefined) return null;
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        "This saved workspace cannot be restored. Delete it and save a new workspace.",
      );
    return parsed.data;
  } finally {
    db.close();
  }
}
