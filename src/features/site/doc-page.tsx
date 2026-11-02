import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Mark, SITE_LINKS, SiteRail } from "./site-rail";
import { APP_NAME } from "@/lib/brand";

/**
 * Guide, Library, Privacy, Terms and Licenses: a reading layout. One column at a
 * comfortable measure, sections separated by space and a hairline, no cards.
 */
export function DocPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Kept for callers; pages no longer show a label above their title. */
  badge?: string;
  children: ReactNode;
}) {
  return (
    <main className="doc-page">
      <header className="doc-header">
        <Link to="/" className="doc-brand">
          <Mark className="size-5 shrink-0" />
          <span>{APP_NAME}</span>
        </Link>
        <nav aria-label="Documentation sections" className="doc-nav">
          {SITE_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              activeProps={{ "aria-current": "page" }}
              className="doc-nav-link"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </header>

      <article className="doc-article">
        <Link to="/" className="doc-back">
          <ArrowLeft aria-hidden="true" className="size-4 rtl:-scale-x-100" />
          Back to {APP_NAME}
        </Link>
        <h1 className="doc-title">{title}</h1>
        {subtitle ? <p className="doc-lede">{subtitle}</p> : null}
        <div className="doc-body">{children}</div>
      </article>

      <SiteRail />
    </main>
  );
}

export function DocSection({
  title,
  badge,
  children,
}: {
  title: string;
  /** Kept for callers; decorative section icons are no longer shown. */
  icon?: ReactNode;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className="doc-section">
      <div className="doc-section-head">
        <h2 className="doc-section-title">{title}</h2>
        {badge ? <span className="doc-section-note">{badge}</span> : null}
      </div>
      <div className="doc-section-body">{children}</div>
    </section>
  );
}
