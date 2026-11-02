import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { APP_DESCRIPTION, APP_NAME, APP_TITLE } from "@/lib/brand";
import appCss from "../styles.css?url";

/**
 * The public origin (build-time SITE_URL, e.g. https://cutout.example.com), or "".
 * Share cards and search engines need absolute URLs; without SITE_URL they are left
 * out rather than guessed.
 */
const SITE_URL: string = import.meta.env.SITE_URL ?? "";

export const Route = createRootRoute({
  head: ({ matches }) => {
    // Only the root matched: an unknown URL showing the not-found page. The server
    // answers every such URL with this page prerendered at /404.
    const notFound = matches.length < 2;
    const url = SITE_URL && !notFound ? SITE_URL + matches[matches.length - 1].pathname : "";
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
        { title: notFound ? `Page not found · ${APP_NAME}` : APP_TITLE },
        ...(notFound ? [{ name: "robots", content: "noindex" }] : []),
        { name: "description", content: APP_DESCRIPTION },
        { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#f3f1eb" },
        { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#10100e" },
        { name: "color-scheme", content: "light dark" },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-title", content: APP_NAME },
        { name: "apple-mobile-web-app-status-bar-style", content: "black" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: APP_NAME },
        { property: "og:title", content: APP_TITLE },
        { property: "og:description", content: APP_DESCRIPTION },
        ...(url ? [{ property: "og:url", content: url }] : []),
        ...(SITE_URL
          ? [
              { property: "og:image", content: `${SITE_URL}/og.jpg` },
              { property: "og:image:width", content: "1200" },
              { property: "og:image:height", content: "630" },
              { property: "og:image:alt", content: APP_DESCRIPTION },
            ]
          : []),
        { name: "twitter:card", content: "summary_large_image" },
      ],
      links: [
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        { rel: "stylesheet", href: appCss },
        { rel: "manifest", href: "/manifest.webmanifest" },
        { rel: "apple-touch-icon", href: "/icon-180.png" },
        ...(url ? [{ rel: "canonical", href: url }] : []),
      ],
    };
  },
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
