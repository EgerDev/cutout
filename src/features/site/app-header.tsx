import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { APP_NAME } from "@/lib/brand";
import { Mark } from "./site-rail";

const SessionControls = lazy(() =>
  import("@/features/workspace/session-controls").then((m) => ({ default: m.SessionControls })),
);

export function AppHeader({
  onReset,
  idle,
  onChoose,
  onHelp,
}: {
  onReset: () => void;
  idle: boolean;
  onChoose: () => void;
  onHelp: () => void;
}) {
  return (
    <header className="app-header pointer-events-none absolute start-0 end-0 top-0 z-20 flex items-center justify-between">
      <button
        type="button"
        className="pointer-events-auto inline-flex min-h-11 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-fg"
        onClick={() => {
          if (idle || window.confirm("Clear this workspace and start over? Images and edits that you haven’t downloaded will be lost.")) onReset();
        }}
        aria-label={`${APP_NAME} — ${idle ? "new image" : "clear workspace"}`}
      >
        <Mark />
        {APP_NAME}
      </button>
      <nav className="pointer-events-auto flex items-center gap-1" aria-label="Workspace">
        <Suspense fallback={null}>
          <SessionControls />
        </Suspense>
        {!idle ? (
          <Button
            size="sm"
            onClick={onChoose}
            aria-keyshortcuts="Meta+O Control+O"
            aria-label="New image"
          >
            <span className="header-label-full">New image</span>
            <span className="header-label-short">New</span>
          </Button>
        ) : null}
        <Button
          id="shortcut-help-trigger"
          className="header-shortcuts"
          size="sm"
          onClick={onHelp}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="size-4" />
        </Button>
        <Link to="/guide" className={buttonVariants()}>
          Guide
        </Link>
      </nav>
    </header>
  );
}
