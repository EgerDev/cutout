import { Link } from "@tanstack/react-router";

export const SITE_LINKS = [
  { to: "/guide", label: "Guide" },
  { to: "/library", label: "Library" },
  { to: "/licenses", label: "Licenses" },
  { to: "/privacy", label: "Privacy" },
  { to: "/terms", label: "Terms" },
] as const;

export function SiteRail() {
  return (
    <footer className="site-rail pointer-events-none absolute start-0 end-0 bottom-0 z-10">
      <nav
        aria-label="Footer"
        className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-1 text-[13px] text-muted"
      >
        {SITE_LINKS.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            activeProps={{ "aria-current": "page", className: "!text-fg" }}
            className="site-rail-link"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}

export function Mark({ className = "size-[22px]" }: { className?: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="1.25"
        y="1.25"
        width="19.5"
        height="19.5"
        rx="6"
        className="stroke-fg"
        strokeWidth="1.5"
      />
      <path
        d="M7 15.5h4.2c2.3 0 3.8-1.35 3.8-3.35 0-1.86-1.28-3.05-3.42-3.05H9.2V6.5"
        className="stroke-fg"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.1" cy="5.9" r="1.15" className="fill-accent" />
    </svg>
  );
}
