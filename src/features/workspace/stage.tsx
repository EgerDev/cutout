import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from "react";
import { readClient } from "@/lib/device";
import { CUTOUT_EXPORT_TYPE, setCutoutExportDrag } from "@/lib/files";
import {
  attachStageGpu,
  gpuStageSupported,
  probeCheckerFlip,
  stageTabVisible,
  type StageGpu,
  type StageBackend,
} from "@/lib/stage-gpu";
import { cn } from "@/lib/utils";
import { liveBitmap, retainPreview } from "@/lib/editor/resources";

export function Stage({
  sourceUrl,
  preview,
  resultUrl,
  resultBitmap = null,
  width = 0,
  height = 0,
  comparing,
  peeking,
  children,
  masking,
  exportFile,
}: {
  sourceUrl?: string;
  preview?: ImageBitmap | null;
  resultUrl?: string | null;
  /** Live preview bitmap; takes precedence over resultUrl when present. */
  resultBitmap?: ImageBitmap | null;
  width?: number;
  height?: number;
  comparing: boolean;
  peeking: boolean;
  /** Overlays drawn inside the image frame, in its coordinates. */
  children?: React.ReactNode;
  masking?: boolean;
  exportFile?: File | null;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<StageGpu | null>(null);
  // A backend change remounts the canvas with its refs, sizing and listeners.
  const [backend, setBackend] = useState<StageBackend>("webgpu");
  const nextBackend = useCallback(() => {
    setBackend((current) => (current === "webgpu" ? "webgl2" : "2d"));
  }, []);
  const wipe = useRef(50);
  const dragging = useRef(false);
  const gpuOnRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [gpuOn, setGpuOn] = useState(false);
  const [invertChecker, setInvertChecker] = useState(false);
  const resultImage = useDecodedImage(resultUrl);
  const sourceImage = useDecodedImage(sourceUrl);

  useLayoutEffect(() => {
    const releaseSource = retainPreview(preview);
    const releaseResult = retainPreview(resultBitmap);
    return () => {
      releaseSource();
      releaseResult();
    };
  }, [preview, resultBitmap]);

  useEffect(() => {
    if (!resultImage) {
      setInvertChecker(false);
      return;
    }
    let live = true;
    void probeCheckerFlip(resultImage).then((flip) => {
      if (live) setInvertChecker(flip);
    });
    return () => {
      live = false;
    };
  }, [resultImage]);

  useEffect(() => {
    if (preview || resultUrl || resultBitmap) {
      setReady(true);
      return;
    }
    if (!sourceUrl) {
      setReady(false);
      return;
    }
    let live = true;
    const image = new Image();
    image.src = sourceUrl;
    image
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [preview, sourceUrl, resultUrl, resultBitmap]);

  const paintGpu = useCallback(() => {
    const gpu = gpuRef.current;
    if (!gpu) return false;
    if (!stageTabVisible()) return true;
    const showResult = Boolean(resultUrl || resultBitmap) && !peeking;
    const split = comparing && showResult && !masking;
    const result = liveBitmap(resultBitmap) ?? resultImage ?? liveBitmap(preview) ?? null;
    const source = sourceImage ?? liveBitmap(preview) ?? null;
    if ((!result && !source) || width <= 0 || height <= 0) {
      if (gpuOnRef.current) {
        gpuOnRef.current = false;
        setGpuOn(false);
      }
      return false;
    }
    const ok = gpu.paint({
      result,
      source,
      comparing: split,
      peeking,
      masking: Boolean(masking && (resultUrl || resultBitmap)),
      wipe: wipe.current / 100,
      invertChecker,
    });
    if (!ok) nextBackend();
    if (ok !== gpuOnRef.current) {
      gpuOnRef.current = ok;
      setGpuOn(ok);
    }
    return ok;
  }, [
    nextBackend,
    comparing,
    height,
    invertChecker,
    masking,
    peeking,
    preview,
    resultBitmap,
    resultImage,
    resultUrl,
    sourceImage,
    width,
  ]);

  const paintRef = useRef(paintGpu);

  const scheduleRef = useRef<() => void>(() => {});
  const requestPaint = useCallback(() => scheduleRef.current(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gpuStageSupported()) return;
    let dead = false;
    let raf = 0;
    const schedule = () => {
      if (dead || raf || !stageTabVisible() || !gpuRef.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!dead && stageTabVisible()) paintRef.current();
      });
    };
    scheduleRef.current = schedule;
    void attachStageGpu(canvas, schedule, backend)
      .then((gpu) => {
        if (dead) {
          gpu?.destroy();
          return;
        }
        gpuRef.current = gpu;
        if (gpu) schedule();
        else nextBackend();
      })
      .catch(() => {
        if (!dead) nextBackend();
      });
    const onVis = () => {
      if (stageTabVisible()) schedule();
      else {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const theme = matchMedia("(prefers-color-scheme: dark)");
    theme.addEventListener("change", schedule);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("resize", schedule);
    canvas.addEventListener("contextlost", schedule);
    canvas.addEventListener("contextrestored", schedule);
    canvas.addEventListener("webglcontextlost", schedule);
    canvas.addEventListener("webglcontextrestored", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      dead = true;
      scheduleRef.current = () => {};
      cancelAnimationFrame(raf);
      theme.removeEventListener("change", schedule);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", schedule);
      canvas.removeEventListener("contextlost", schedule);
      canvas.removeEventListener("contextrestored", schedule);
      canvas.removeEventListener("webglcontextlost", schedule);
      canvas.removeEventListener("webglcontextrestored", schedule);
      ro.disconnect();
      gpuRef.current?.destroy();
      gpuRef.current = null;
    };
  }, [backend, nextBackend]);

  useLayoutEffect(() => {
    paintRef.current = paintGpu;
    requestPaint();
  }, [paintGpu, requestPaint]);

  const setWipe = useCallback(
    (value: number) => {
      const next = Math.min(100, Math.max(0, value));
      if (next === wipe.current) return;
      wipe.current = next;
      const node = frame.current;
      if (node) {
        node.style.setProperty("--wipe", `${next}%`);
        if (node.getAttribute("role") === "slider") {
          node.setAttribute("aria-valuenow", String(Math.round(next)));
          node.setAttribute("aria-valuetext", wipeText(next));
        }
      }
      requestPaint();
    },
    [requestPaint],
  );

  const fromClientX = useCallback((clientX: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box?.width) return wipe.current;
    return ((clientX - box.left) / box.width) * 100;
  }, []);

  useLayoutEffect(() => {
    setWipe(50);
  }, [sourceUrl, setWipe]);

  useEffect(() => {
    if (!comparing) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.target !== frame.current && event.target !== document.body) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setWipe(wipe.current - (event.shiftKey ? 8 : 3));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setWipe(wipe.current + (event.shiftKey ? 8 : 3));
      }
      if (event.key === "Home") {
        event.preventDefault();
        setWipe(0);
      }
      if (event.key === "End") {
        event.preventDefault();
        setWipe(100);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparing, setWipe]);

  useEffect(() => () => setCutoutExportDrag(false), []);

  const showResult = Boolean(resultUrl || resultBitmap) && !peeking;
  const split = comparing && showResult && !masking;
  const client = readClient();
  const canDrag =
    Boolean(exportFile) && showResult && !split && !peeking && !client.ios && !client.android;
  const ar = width > 0 && height > 0 ? width / height : 0;
  const cssFill = ar ? { ["--stage-ar" as string]: String(ar) } : {};

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !split) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    event.currentTarget.setAttribute("data-dragging", "true");
    setWipe(fromClientX(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) setWipe(fromClientX(event.clientX));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    dragging.current = false;
    event.currentTarget.removeAttribute("data-dragging");
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrag || !exportFile) {
      event.preventDefault();
      return;
    }
    const transfer = event.dataTransfer;
    if (!transfer) {
      event.preventDefault();
      return;
    }
    transfer.effectAllowed = "copy";
    try {
      transfer.setData(CUTOUT_EXPORT_TYPE, exportFile.name);
      if (!transfer.items.add(exportFile)) throw new Error("add");
      setCutoutExportDrag(true);
    } catch {
      setCutoutExportDrag(false);
      event.preventDefault();
    }
  };

  const onDragEnd = () => setCutoutExportDrag(false);

  return (
    <div className="stage-slot">
      <div
        ref={frame}
        role={split ? "slider" : undefined}
        tabIndex={split ? 0 : undefined}
        aria-label={split ? "Compare original and result" : undefined}
        aria-orientation={split ? "horizontal" : undefined}
        aria-valuemin={split ? 0 : undefined}
        aria-valuemax={split ? 100 : undefined}
        aria-valuenow={split ? Math.round(wipe.current) : undefined}
        aria-valuetext={split ? wipeText(wipe.current) : undefined}
        data-peeking={peeking ? "true" : undefined}
        data-masking={masking ? "true" : undefined}
        data-gpu={gpuOn ? (gpuRef.current?.kind ?? "true") : undefined}
        data-checker={invertChecker ? "flip" : undefined}
        className={cn(
          "stage-media relative overflow-hidden shadow-[var(--shadow-float)]",
          ready && "is-ready",
          ar && "has-ar",
          !gpuOn && showResult && "checker",
          split && "cursor-ew-resize touch-none select-none",
          canDrag && "cursor-grab",
        )}
        style={cssFill}
        draggable={canDrag}
        title={canDrag ? "Drag the cutout to another window" : undefined}
        onDragStart={canDrag ? onDragStart : undefined}
        onDragEnd={onDragEnd}
        onPointerDown={split ? onPointerDown : undefined}
        onPointerMove={split ? onPointerMove : undefined}
        onPointerUp={split ? onPointerUp : undefined}
        onPointerCancel={split ? onPointerUp : undefined}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.classList.add("is-settled");
        }}
      >
        <canvas
          key={backend}
          ref={canvasRef}
          className={cn(
            "stage-photo pointer-events-none absolute inset-0 z-0 size-full",
            gpuOn ? "opacity-100" : "opacity-0",
          )}
          aria-hidden
        />
        {gpuOn ? null : resultBitmap ? (
          <PreviewCanvas
            bitmap={resultBitmap}
            className={cn(
              "stage-photo absolute inset-0 z-0 size-full object-contain",
              showResult ? "opacity-100" : "opacity-0",
            )}
          />
        ) : resultUrl ? (
          <img
            src={resultUrl}
            alt=""
            draggable={false}
            decoding="async"
            className={cn(
              "stage-photo absolute inset-0 z-0 size-full object-contain transition-opacity duration-[var(--motion-medium)] ease-[var(--ease-out)]",
              showResult ? "opacity-100" : "opacity-0",
            )}
          />
        ) : null}
        {gpuOn ? null : split && sourceUrl ? (
          <img
            src={sourceUrl}
            alt=""
            draggable={false}
            decoding="async"
            className="stage-photo stage-compare-source pointer-events-none absolute inset-0 z-10 size-full object-contain"
          />
        ) : gpuOn ? null : preview ? (
          <PreviewCanvas
            bitmap={preview}
            className={cn(
              "stage-photo z-10 object-contain transition-opacity duration-[var(--motion-medium)] ease-[var(--ease-out)]",
              ar ? "absolute inset-0 size-full" : "relative max-h-full max-w-full",
              showResult ? "opacity-0" : "opacity-100",
            )}
          />
        ) : sourceUrl ? (
          <img
            src={sourceUrl}
            alt=""
            draggable={false}
            decoding="async"
            fetchPriority="high"
            className={cn(
              "stage-photo z-10 object-contain transition-opacity duration-[var(--motion-medium)] ease-[var(--ease-out)]",
              ar ? "absolute inset-0 size-full" : "relative max-h-full max-w-full",
              showResult ? "opacity-0" : "opacity-100",
            )}
          />
        ) : null}
        {gpuOn ? null : masking && resultUrl ? (
          <>
            <div className="stage-mask-backdrop pointer-events-none absolute inset-0 z-20" />
            <div
              className="stage-mask-fill pointer-events-none absolute inset-0 z-20"
              style={{ ["--mask" as string]: `url("${resultUrl}")` }}
            />
          </>
        ) : null}
        {children}
        {split ? (
          <>
            <div className="stage-wipe-line pointer-events-none absolute inset-y-0 z-30 w-px -translate-x-1/2 bg-accent" />
            <div
              className="stage-wipe-handle pointer-events-none absolute top-1/2 z-30 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-float shadow-[var(--shadow-float)]"
              aria-hidden
            >
              <span className="block h-5 w-px bg-accent" />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** What the compare slider's value means, for screen readers. */
function wipeText(value: number) {
  return `${Math.round(value)}% original, ${100 - Math.round(value)}% result`;
}

function useDecodedImage(url?: string | null) {
  const [decoded, setDecoded] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!url) {
      setDecoded(null);
      return;
    }
    const el = new Image();
    el.decoding = "async";
    el.src = url;
    let live = true;
    const done = () => {
      if (live && el.naturalWidth > 0) setDecoded({ url, image: el });
    };
    void el.decode().then(done, done);
    if (el.complete) done();
    return () => {
      live = false;
    };
  }, [url]);
  return decoded && decoded.url === url ? decoded.image : null;
}

function PreviewCanvas({ bitmap, className }: { bitmap: ImageBitmap; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas) paintBitmap(canvas, bitmap);
  }, [bitmap]);
  return <canvas ref={ref} className={className} />;
}

function paintBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap) {
  // Suspense can replay this effect with a retired bitmap from its hidden subtree.
  if (!liveBitmap(bitmap)) return;
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
}
