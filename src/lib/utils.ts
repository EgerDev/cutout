import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Editable, but a slider isn't typed into: editor shortcuts keep working after one is dragged. */
export function isTypingTarget(target: EventTarget | null) {
  return (
    isEditableTarget(target) && !(target instanceof HTMLInputElement && target.type === "range")
  );
}
export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("[contenteditable]:not([contenteditable='false'])")) return true;
  const role = target.getAttribute("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
