import { APP_NAME } from "@/lib/brand";

/** A doc page's own title and description; they replace the root route's defaults. */
export function docHead(title: string, description: string) {
  const full = `${title} · ${APP_NAME}`;
  return {
    meta: [
      { title: full },
      { name: "description", content: description },
      { property: "og:title", content: full },
      { property: "og:description", content: description },
    ],
  };
}
