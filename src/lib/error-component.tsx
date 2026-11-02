import type { ReactNode } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { TriangleAlert } from "lucide-react";

const FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

/** Not found and crash pages: the workbench's own paper, ink and accent, with a way out. */
export function StatusPage({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  /** Kept for callers; the page takes its colours from the theme. */
  tone?: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <main className="status-page">
      <Icon className="size-8 text-muted" strokeWidth={1.75} aria-hidden="true" />
      <h1 className="text-[22px] font-semibold tracking-[-0.015em]">{title}</h1>
      <p className="max-w-md text-[15px] break-words text-muted">{body}</p>
      {action ? (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </main>
  );
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <StatusPage
      icon={TriangleAlert}
      title="Something went wrong"
      body={errorMessage(error)}
      action={
        <>
          <button
            type="button"
            className="status-action is-primary"
            onClick={() => location.reload()}
          >
            Reload the page
          </button>
          <a className="status-action" href="/">
            Back to Cutout
          </a>
        </>
      }
    />
  );
}
