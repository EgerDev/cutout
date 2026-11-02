export const APP_NAME = "Cutout";
/** The home page's title: what people search for, not only the name. */
export const APP_TITLE = "Cutout · Remove image backgrounds on your device";
/**
 * Who runs this copy and how to reach them privately (build-time VITE_SITE_OPERATOR and
 * VITE_SITE_CONTACT). Anyone can host Cutout: a self-hosted copy must not name the
 * author as its operator, so both default to empty.
 */
export const SITE_OPERATOR = import.meta.env.VITE_SITE_OPERATOR?.trim() ?? "";
export const SITE_CONTACT = import.meta.env.VITE_SITE_CONTACT?.trim() ?? "";
export const APP_DESCRIPTION =
  "Drop a photo. The background is gone. Your photo stays on this device.";
