import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  attachStageGpu,
  CHECKER_CELL,
  CHECKER_CONTRAST_MIN,
  CHECKER_DARK,
  CHECKER_LIGHT,
  checkerNeedsFlip,
  compareReady,
  contrastRatio,
  opaqueMeanLuma,
  relativeLuma,
  gpuTexFit,
  parseCssColor,
  preserveContextOnLost,
  STAGE_ANISO,
  stageTabVisible,
} from "./stage-gpu.ts";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "stage-gpu.ts"), "utf8");

test("GPU present pauses when the tab is hidden", () => {
  assert.equal(stageTabVisible(), true);
  const stage = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../features/workspace/stage.tsx"),
    "utf8",
  );
  assert.match(stage, /stageTabVisible/);
  assert.match(stage, /cancelAnimationFrame\(raf\)/);
});

test("compare atlas sampling is off until original and cutout are both present", () => {
  assert.equal(compareReady(true, {}, {}), true);
  assert.equal(compareReady(true, {}, null), false);
  assert.equal(compareReady(true, "same", "same"), false);
  assert.equal(compareReady(false, {}, {}), false);
});

test("compare atlas maps original to tile 0 and cutout to tile 1", () => {
  assert.match(src, /uv\.x >= u\.wipe/);
  assert.match(src, /clamp\(uv\.x, 0\.001, 0\.999\) \+ tile\) \* 0\.5/);
  assert.match(src, /sampleSubject/);
  assert.match(src, /uploadAtlas/);
  assert.match(src, /glTexAtlas/);
  assert.match(src, /packStageAtlas/);
});

test("parseCssColor reads 6-digit hex", () => {
  assert.deepEqual(parseCssColor("#ffffff"), [1, 1, 1]);
  assert.deepEqual(parseCssColor("#000000"), [0, 0, 0]);
  assert.deepEqual(parseCssColor("not-a-color"), [0.35, 0.34, 0.3]);
});

test("stage backends fall through WebGPU → WebGL2 → canvas 2d", () => {
  assert.match(src, /return attachGl\(canvas\) \?\? attach2d\(canvas\);/);
  assert.equal(src.includes("experimental-webgl"), false);
});

test("compositor enables anisotropic filtering", () => {
  assert.equal(STAGE_ANISO, 4);
  assert.match(src, /maxAnisotropy:\s*STAGE_ANISO/);
  assert.match(src, /EXT_texture_filter_anisotropic/);
  assert.match(src, /TEXTURE_MAX_ANISOTROPY_EXT/);
});

test("GPU textures fit to about twice the canvas, never upscale", () => {
  assert.deepEqual(gpuTexFit(4000, 3000, 800, 600), { width: 1600, height: 1200 });
  assert.deepEqual(gpuTexFit(400, 300, 800, 600), { width: 400, height: 300 });
  assert.match(src, /fitTexSource/);
  assert.match(src, /dim\.w === width && dim\.h === height/);
});

test("GL texture updates use texSubImage2D when size is unchanged", () => {
  const upload = src.slice(src.indexOf("function glTex"), src.indexOf("function bootGl"));
  assert.match(upload, /texSubImage2D/);
  assert.match(upload, /dim\.w !== width \|\| dim\.h !== height/);
  assert.match(upload, /texImage2D/);
});

test("GL paint reuses one program and cached uniform locations", () => {
  const paint = src.slice(src.indexOf("function paintGl"), src.indexOf("function watchGlContext"));
  assert.equal(paint.includes("createProgram"), false);
  assert.equal(paint.includes("getUniformLocation"), false);
  assert.match(paint, /gl\.useProgram\(program\)/);
  assert.match(src, /function bootGl/);
  assert.match(src, /glSessions/);
});

test("compositor paint never readPixels or getImageData", () => {
  const paintGpu = src.slice(
    src.indexOf("const paint = (frame: StageGpuFrame)"),
    src.indexOf("const destroy = () =>"),
  );
  const paintGl = src.slice(
    src.indexOf("function paintGl"),
    src.indexOf("function watchGlContext"),
  );
  for (const paint of [paintGpu, paintGl]) {
    assert.equal(paint.includes("readPixels"), false);
    assert.equal(paint.includes("getImageData"), false);
    assert.equal(paint.includes("mapAsync"), false);
    assert.equal(paint.includes("toDataURL"), false);
  }
  assert.match(src, /preserveDrawingBuffer:\s*false/);
});

test("black-on-dark checker contrast flips the board, light subjects do not", () => {
  assert.equal(CHECKER_CONTRAST_MIN, 3);
  const black = relativeLuma([0, 0, 0]);
  const cream = relativeLuma([0.906, 0.89, 0.847]);
  assert.ok(checkerNeedsFlip(black, true));
  assert.equal(checkerNeedsFlip(cream, true), false);
  assert.ok(contrastRatio(black, relativeLuma([0.247, 0.239, 0.212])) < 3);
  const dark = new Uint8ClampedArray([8, 8, 8, 255, 0, 0, 0, 0]);
  assert.ok(opaqueMeanLuma(dark) < 0.02);
  const pale = new Uint8ClampedArray([240, 236, 228, 255]);
  assert.ok(opaqueMeanLuma(pale) > 0.8);
});

test("checkerboard is baked into the shaders", () => {
  assert.equal(CHECKER_CELL, 16);
  assert.equal(CHECKER_LIGHT.a, "#e7e3d8");
  assert.equal(CHECKER_DARK.b, "#3f3d36");
  assert.match(src, /fn checker\(pos: vec2f\)/);
  assert.match(src, /vec3 checker\(vec2 pos\)/);
  assert.match(src, /u\.checkerA/);
  assert.match(src, /u_checkA/);
  assert.match(src, /checkerTint/);
  assert.match(src, /--color-checker-a/);
});

test("context lost is preserved so restored can rebuild", () => {
  let prevented = false;
  preserveContextOnLost({
    preventDefault() {
      prevented = true;
    },
  } as Event);
  assert.equal(prevented, true);
  assert.match(src, /webglcontextlost/);
  assert.match(src, /webglcontextrestored/);
  assert.match(src, /rebuildGl/);
  assert.match(src, /contextlost/);
  assert.match(src, /contextrestored/);
});

test("stage textures are uploaded premultiplied and composited with the over operator", () => {
  const src = readFileSync(new URL("./stage-gpu.ts", import.meta.url), "utf8");
  // Linear filtering of a straight-alpha texture blends the zeroed colour of transparent
  // texels into edges: a white edge over a white ground rendered 191 instead of 255.
  assert.equal(
    (src.match(/copyExternalImageToTexture\(/g) ?? []).length,
    (src.match(/premultipliedAlpha: true/g) ?? []).length,
    "every WebGPU upload premultiplies",
  );
  assert.equal(
    (src.match(/UNPACK_PREMULTIPLY_ALPHA_WEBGL, true/g) ?? []).length,
    2,
    "both WebGL upload helpers premultiply",
  );
  assert.doesNotMatch(src, /mix\(ground, src\.rgb, src\.a\)/);
  assert.doesNotMatch(src, /mix\(checker\(gl_FragCoord\.xy\), src\.rgb, src\.a\)/);
  assert.match(src, /ground \* \(1\.0 - src\.a\) \+ src\.rgb/);
  assert.match(src, /checker\(gl_FragCoord\.xy\) \* \(1\.0 - src\.a\) \+ src\.rgb/);
});

type FakeTex = {
  id: number;
  width: number;
  height: number;
  destroyed: boolean;
  destroy: () => void;
  createView: () => unknown;
};

function source(width: number, height: number) {
  return { width, height };
}

function fakeCanvas() {
  const canvas = {
    clientWidth: 320,
    clientHeight: 240,
    width: 320,
    height: 240,
    getContext(type: string) {
      if (type !== "webgpu") return null;
      return {
        configure() {},
        unconfigure() {},
        getCurrentTexture() {
          return { createView() {} };
        },
      };
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

function slotFrame(
  slot: "source" | "result",
  bitmap: { width: number; height: number },
  stable: { width: number; height: number },
) {
  return {
    source: (slot === "source" ? bitmap : stable) as TexImageSource,
    result: slot === "result" ? (bitmap as TexImageSource) : null,
    comparing: false,
    peeking: false,
    masking: false,
    wipe: 0.5,
  };
}

type FakeView = { texture: FakeTex };

let mockRun = 0;

async function withMockGpu<T>(
  run: (api: {
    attach: () => ReturnType<typeof attachStageGpu>;
    textures: FakeTex[];
    copiesIntoDestroyed: FakeTex[];
    viewsOfDestroyed: FakeTex[];
    submitsOfDestroyed: FakeTex[];
    createCount: () => number;
    failNextCreate: () => void;
    failNextCopy: () => void;
    fault: (point: string, nth?: number) => void;
  }) => Promise<T>,
) {
  const textures: FakeTex[] = [];
  const copiesIntoDestroyed: FakeTex[] = [];
  const viewsOfDestroyed: FakeTex[] = [];
  const submitsOfDestroyed: FakeTex[] = [];
  let nextId = 1;
  let createCount = 0;
  let failCreate = 0;
  let failCopy = 0;
  let faultPoint = "";
  let faultNth = 0;
  const hit = (point: string) => {
    if (faultPoint === point && --faultNth === 0) {
      faultPoint = "";
      throw new DOMException(`injected ${point} failure`, "OperationError");
    }
  };

  const device = {
    createShaderModule() {
      return {};
    },
    createRenderPipeline() {
      return { getBindGroupLayout() {} };
    },
    createBindGroup(desc: { entries: { resource: { texture?: FakeTex } }[] }) {
      return {
        views: desc.entries.flatMap((entry) =>
          entry.resource.texture ? [{ texture: entry.resource.texture }] : [],
        ),
      };
    },
    createSampler() {
      return {};
    },
    createTexture(desc: { size: { width: number; height: number } }) {
      hit("create");
      if (failCreate > 0) {
        failCreate -= 1;
        throw new DOMException("injected upload failure", "OperationError");
      }
      createCount += 1;
      const texture: FakeTex = {
        id: nextId,
        width: desc.size.width,
        height: desc.size.height,
        destroyed: false,
        destroy() {
          texture.destroyed = true;
        },
        createView() {
          if (texture.destroyed) viewsOfDestroyed.push(texture);
          return { texture };
        },
      };
      nextId += 1;
      textures.push(texture);
      return texture;
    },
    createBuffer() {
      return { destroy() {} };
    },
    createCommandEncoder() {
      hit("encoder");
      const bound: FakeView[] = [];
      return {
        beginRenderPass() {
          return {
            setPipeline() {},
            setBindGroup(_index: number, group?: { views?: FakeView[] }) {
              if (group?.views) bound.push(...group.views);
            },
            draw() {},
            end() {},
          };
        },
        copyTextureToTexture(src: FakeView, dst: FakeView) {
          hit("texture-copy");
          bound.push(src, dst);
        },
        finish() {
          hit("finish");
          return { bound: bound.slice() };
        },
      };
    },
    queue: {
      writeBuffer() {},
      writeTexture() {},
      copyExternalImageToTexture(_src: unknown, dst: { texture: FakeTex }, _size: unknown) {
        hit("external-copy");
        if (failCopy > 0) {
          failCopy -= 1;
          throw new DOMException("The ImageBitmap is closed", "InvalidStateError");
        }
        if (dst.texture.destroyed) {
          copiesIntoDestroyed.push(dst.texture);
          throw new DOMException("Destroyed texture used in a submit", "OperationError");
        }
      },
      submit(commands: { bound?: FakeView[] }[]) {
        hit("submit");
        let usedDestroyed = false;
        for (const command of commands) {
          for (const view of command.bound ?? []) {
            if (view.texture.destroyed) {
              submitsOfDestroyed.push(view.texture);
              usedDestroyed = true;
            }
          }
        }
        if (usedDestroyed) {
          throw new DOMException("Destroyed texture used in a submit", "OperationError");
        }
      },
    },
    addEventListener() {},
    lost: new Promise(() => {}),
  };

  const previous = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    devicePixelRatio: Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio"),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => device }),
        getPreferredCanvasFormat: () => "bgra8unorm",
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 });

  const restore = (key: "navigator" | "window" | "devicePixelRatio") => {
    const desc = previous[key];
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
  };

  try {
    const module = await import(`./stage-gpu.ts?mock=${++mockRun}`);
    return await run({
      attach: () => module.attachStageGpu(fakeCanvas()),
      textures,
      copiesIntoDestroyed,
      viewsOfDestroyed,
      submitsOfDestroyed,
      createCount: () => createCount,
      failNextCreate: () => {
        failCreate += 1;
      },
      fault: (point, nth = 1) => {
        faultPoint = point;
        faultNth = nth;
      },
      failNextCopy: () => {
        failCopy += 1;
      },
    });
  } finally {
    restore("navigator");
    restore("window");
    restore("devicePixelRatio");
  }
}

test("a failed resize upload cannot leave a destroyed texture eligible for reuse", async () => {
  await withMockGpu(async (gpu) => {
    const slots = ["source", "result"] as const;
    const modes = ["create", "copy"] as const;
    for (const slot of slots) {
      for (const mode of modes) {
        const stage = await gpu.attach();
        assert.equal(stage?.kind, "webgpu");
        const stable = source(12, 8);
        const A = source(32, 24);
        const A2 = source(32, 24);
        const B = source(80, 48);
        const D = source(16, 12);
        const frame = (bitmap: { width: number; height: number }) =>
          slotFrame(slot, bitmap, stable);
        const label = `${slot} ${mode}`;
        const viewsBefore = gpu.viewsOfDestroyed.length;
        const submitsBefore = gpu.submitsOfDestroyed.length;
        const copiesBefore = gpu.copiesIntoDestroyed.length;

        assert.equal(stage!.paint(frame(A)), true);
        const createdAfterFirst = gpu.createCount();
        const assigned = gpu.textures.filter((texture) => texture.width === 32).at(-1);
        assert.ok(assigned && !assigned.destroyed, `${label}: missing live fitted texture`);

        assert.equal(stage!.paint(frame(A2)), true);
        assert.equal(
          gpu.createCount(),
          createdAfterFirst,
          `${label}: same-size paint must reuse the live texture`,
        );
        assert.equal(assigned.destroyed, false);

        assert.equal(stage!.paint(frame(A)), true);
        if (mode === "create") gpu.failNextCreate();
        else gpu.failNextCopy();
        assert.equal(stage!.paint(frame(B)), false);
        assert.equal(
          assigned.destroyed,
          false,
          `${label}: previous texture must stay usable until replacement succeeds`,
        );
        if (mode === "copy") {
          const leaked = gpu.textures.filter(
            (texture) => texture.width === 80 && texture.height === 48 && !texture.destroyed,
          );
          assert.deepEqual(
            leaked,
            [],
            `${label}: failed copy must destroy the texture it just created`,
          );
        }
        if (slot !== "source") {
          const sibling = gpu.textures.filter(
            (texture) => texture.width === 12 && texture.height === 8 && !texture.destroyed,
          );
          assert.ok(sibling.length >= 1, `${label}: successful sibling source must remain owned`);
        }

        const recovered = stage!.paint(frame(A));
        assert.equal(
          gpu.viewsOfDestroyed.length,
          viewsBefore,
          `${label}: identity retry viewed a destroyed texture`,
        );
        assert.equal(
          gpu.submitsOfDestroyed.length,
          submitsBefore,
          `${label}: identity retry submitted a destroyed texture`,
        );
        assert.equal(
          gpu.copiesIntoDestroyed.length,
          copiesBefore,
          `${label}: identity retry copied into a destroyed texture`,
        );
        assert.equal(recovered, true, `${label}: exact previous identity must recover`);
        assert.equal(stage!.paint(frame(D)), true, `${label}: later healthy paint must succeed`);
        assert.equal(gpu.viewsOfDestroyed.length, viewsBefore);
        assert.equal(gpu.submitsOfDestroyed.length, submitsBefore);

        stage!.destroy();
        const remaining = gpu.textures.filter((texture) => !texture.destroyed);
        assert.equal(remaining.length, 1, `${label}: only shared fallback may remain`);
        assert.equal(remaining[0]?.width, 1);
        assert.equal(remaining[0]?.height, 1);
      }
    }
  });
});

test("manual compare atlas failure is transactional at every allocation and submission window", async (t) => {
  const doc = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  });
  t.after(() => {
    if (doc) Object.defineProperty(globalThis, "document", doc);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const faults: [string, number][] = [
    ["create", 1],
    ["create", 2],
    ["create", 3],
    ["external-copy", 1],
    ["external-copy", 2],
    ["encoder", 1],
    ["texture-copy", 1],
    ["texture-copy", 2],
    ["finish", 1],
    ["submit", 1],
  ];
  for (const [point, nth] of faults) {
    await t.test(`${point} ${nth}`, async () => {
      await withMockGpu(async (gpu) => {
        const stage = await gpu.attach();
        assert.equal(stage?.kind, "webgpu");
        const A = source(32, 24),
          B = source(32, 24),
          stable = source(32, 24);
        const frame = (result: typeof A, original = stable) => ({
          ...slotFrame("result", result, original),
          comparing: true,
        });
        assert.equal(stage!.paint(frame(A)), true);
        const previous = gpu.textures.find((texture) => texture.width === 64);
        assert.ok(previous && !previous.destroyed);
        for (let repeat = 0; repeat < 3; repeat++) {
          const before = gpu.textures.length;
          gpu.fault(point, nth);
          assert.equal(stage!.paint(frame(B)), false);
          assert.equal(previous.destroyed, false, "previous atlas must remain assigned and live");
          assert.deepEqual(
            gpu.textures.slice(before).filter((tex) => !tex.destroyed),
            [],
            "failed candidates and scratch textures are released",
          );
          assert.equal(stage!.paint(frame(A)), true, "exact previous identity retry");
        }
        assert.equal(
          stage!.paint(frame(source(16, 12), source(16, 12))),
          true,
          "later healthy atlas",
        );
        assert.deepEqual(gpu.viewsOfDestroyed, []);
        assert.deepEqual(gpu.submitsOfDestroyed, []);
        assert.deepEqual(gpu.copiesIntoDestroyed, []);
        stage!.destroy();
        assert.equal(
          gpu.textures.filter((texture) => !texture.destroyed).length,
          1,
          "only shared placeholder remains",
        );
        const dispose = await gpu.attach();
        assert.equal(dispose!.paint(frame(A)), true);
        for (let repeat = 0; repeat < 3; repeat++) {
          gpu.fault(point, nth);
          assert.equal(dispose!.paint(frame(B)), false);
        }
        dispose!.destroy();
        assert.equal(
          gpu.textures.filter((texture) => !texture.destroyed).length,
          1,
          "immediate destroy after repeated failures releases all owned textures",
        );
      });
    });
  }
});

test("an atlas failure keeps a successful sibling source upload owned", async (t) => {
  const doc = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  });
  t.after(() => {
    if (doc) Object.defineProperty(globalThis, "document", doc);
    else Reflect.deleteProperty(globalThis, "document");
  });
  await withMockGpu(async (gpu) => {
    const stage = await gpu.attach();
    const A = source(32, 24),
      O = source(32, 24),
      B = source(80, 48),
      N = source(80, 48);
    const frame = (result: typeof A, original: typeof O) => ({
      ...slotFrame("result", result, original),
      comparing: true,
    });
    assert.equal(stage!.paint(frame(A, O)), true);
    gpu.fault("create", 3); // Source replacement succeeds; the second atlas scratch allocation fails.
    assert.equal(stage!.paint(frame(B, N)), false);
    const siblings = gpu.textures.filter((tex) => tex.width === 80 && !tex.destroyed);
    assert.equal(siblings.length, 1);
    assert.equal(stage!.paint(frame(A, O)), true);
    assert.equal(stage!.paint(frame(source(16, 12), source(16, 12))), true);
    assert.deepEqual(gpu.viewsOfDestroyed, []);
    assert.deepEqual(gpu.submitsOfDestroyed, []);
    assert.deepEqual(gpu.copiesIntoDestroyed, []);
    stage!.destroy();
    assert.equal(gpu.textures.filter((tex) => !tex.destroyed).length, 1);
  });
});
