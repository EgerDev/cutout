import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FORMAT_LINE } from "@/lib/files";
import { cn } from "@/lib/utils";

export function IdleScreen({
  onChoose,
  onCamera,
  onSample,
  onModels,
  receding,
  sampleLoading,
  ready = true,
}: {
  onChoose: () => void;
  onCamera?: () => void;
  onSample: () => void;
  onModels?: () => void;
  receding?: boolean;
  sampleLoading?: boolean;
  ready?: boolean;
}) {
  return (
    <div
      className={cn(
        "idle-shell flex min-h-dvh flex-col transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)]",
        receding && "opacity-40",
      )}
    >
      <div className="idle-stack">
        <h1 className="idle-headline font-sans text-[clamp(2.5rem,7vw,4.25rem)] font-semibold leading-[1.04] tracking-[-0.025em] text-fg">
          <span className="idle-line">Remove the </span>
          <span className="idle-line">background.</span>
        </h1>
        <div className="idle-actions">
          <div className="idle-choose">
            <Button
              variant="primary"
              size="pill"
              className="h-12 px-7 text-[15px] shadow-[var(--shadow-float)] disabled:opacity-100"
              disabled={!ready}
              aria-busy={!ready}
              onClick={onChoose}
            >
              Choose files
            </Button>
            {onCamera ? (
              <Button
                variant="ghost"
                size="pill"
                className="h-12 text-[15px] disabled:opacity-100"
                disabled={!ready}
                onClick={onCamera}
              >
                <Camera className="size-4" aria-hidden="true" />
                Take photo
              </Button>
            ) : (
              <p className="idle-drop">or drop images anywhere</p>
            )}
          </div>
          <p className="idle-meta">{FORMAT_LINE} · up to 15 images</p>
          <p className="idle-meta idle-keys">
            <kbd className="keycap">⌘ V</kbd> or <kbd className="keycap">Ctrl V</kbd> pastes an
            image
          </p>
        </div>
        <div className="idle-more">
          <button
            type="button"
            className="idle-sample idle-link"
            onClick={onSample}
            disabled={!ready || sampleLoading}
            aria-busy={sampleLoading}
          >
            <img
              src="/sample-thumb.webp"
              alt=""
              width={32}
              height={32}
              className="idle-sample-thumb"
            />
            {sampleLoading ? "Loading sample…" : "Try a sample"}
          </button>
          {onModels ? (
            <button type="button" className="idle-link" onClick={onModels} disabled={!ready}>
              On-device models · download ahead
            </button>
          ) : null}
        </div>
        <p className="idle-note">
          Photos stay on this device. The first cut downloads a 90–192 MB model once.
        </p>
      </div>
    </div>
  );
}
