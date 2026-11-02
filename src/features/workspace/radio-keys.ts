import type { KeyboardEvent } from "react";

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Arrow keys, Home and End for a role="radiogroup" of role="radio" buttons: one Tab stop
 * (give the checked radio tabIndex 0, the rest -1), selection follows focus as in the
 * ARIA radio group pattern, and left/right follow the reading direction.
 */
export function onRadioKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const step = STEP[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'),
  );
  const index = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (index + (step ?? 0) * (rtl && horizontal ? -1 : 1) + radios.length) % radios.length;
  radios[next]?.focus();
  radios[next]?.click();
}
