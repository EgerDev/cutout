/** Processing budget for full-size canvases; its own module so the decode worker can read it
 *  without loading the app's file and editor code. */
export const PROCESS_PIXEL_BUDGET = 96_000_000;
export const PROCESS_SIDE_LIMIT = 16384;
