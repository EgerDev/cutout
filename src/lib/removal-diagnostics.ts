export type RemovalCrop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RemovalDiagnostics = Readonly<{
  foregroundFraction: number;
  uncertainFraction: number;
  components: number;
  crops: readonly RemovalCrop[];
}>;

export type MaskComponent = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  pixels: number;
};

type PixelBounds = MaskComponent;

const FOREGROUND_ALPHA = 24;
const UNCERTAIN_MIN = 8;
const UNCERTAIN_MAX = 247;

export function analyzeRemovalMask(
  alpha: Uint8Array,
  width: number,
  height: number,
  maxCrops: number,
): RemovalDiagnostics {
  const pixels = width * height;
  if (width <= 0 || height <= 0 || alpha.length !== pixels || maxCrops <= 0)
    return { foregroundFraction: 0, uncertainFraction: 0, components: 0, crops: [] };

  let foreground = 0,
    uncertain = 0;
  for (const value of alpha) {
    if (value > FOREGROUND_ALPHA) foreground += 1;
    if (value > UNCERTAIN_MIN && value < UNCERTAIN_MAX) uncertain += 1;
  }

  const minimumComponent = Math.max(4, Math.floor(pixels * 0.0015));
  const components = listComponents(alpha, width, height, minimumComponent);
  const candidates = components
    .map((component) => cropForComponent(component, width, height))
    .filter((crop): crop is RemovalCrop => crop !== null)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, Math.floor(maxCrops))
    .sort((a, b) => a.x - b.x || a.y - b.y);

  return {
    foregroundFraction: foreground / pixels,
    uncertainFraction: uncertain / pixels,
    components: components.length,
    crops: candidates,
  };
}

export function needsSubjectChoice(report: RemovalDiagnostics) {
  return (
    report.components >= 3 ||
    report.uncertainFraction > 0.12 ||
    report.foregroundFraction < 0.04 ||
    report.foregroundFraction > 0.92
  );
}

export function removalNote(
  report: RemovalDiagnostics,
  refinements: number,
): "clean" | "refined" | "choose" {
  if (needsSubjectChoice(report)) return "choose";
  if (refinements > 0) return "refined";
  return "clean";
}

export function listComponents(
  alpha: Uint8Array,
  width: number,
  height: number,
  minPixels = 1,
): MaskComponent[] {
  return connectedComponents(alpha, width, height).filter(
    (component) => component.pixels >= minPixels,
  );
}

export type LabeledComponents = Readonly<{
  components: MaskComponent[];
  /** Per pixel: 1-based index into `components`, 0 for background. */
  labels: Int32Array;
}>;

/**
 * Connected components together with the pixel-to-component map, for callers that
 * must act on a component's own pixels rather than its bounding box: two subjects
 * whose boxes overlap (an L-shape wrapped around a block) share no pixels.
 */
export function labelComponents(
  alpha: Uint8Array,
  width: number,
  height: number,
): LabeledComponents {
  const labels = new Int32Array(alpha.length);
  const components = connectedComponents(alpha, width, height, labels);
  return { components, labels };
}

function connectedComponents(
  alpha: Uint8Array,
  width: number,
  height: number,
  labels?: Int32Array,
): PixelBounds[] {
  const visited = new Uint8Array(alpha.length);
  const queue = new Int32Array(alpha.length);
  const components: PixelBounds[] = [];
  for (let start = 0; start < alpha.length; start += 1) {
    if (visited[start] || alpha[start] <= FOREGROUND_ALPHA) continue;
    const label = components.length + 1;
    let head = 0,
      tail = 1;
    queue[0] = start;
    visited[start] = 1;
    const initialX = start % width,
      initialY = Math.floor(start / width);
    const bounds: PixelBounds = {
      left: initialX,
      top: initialY,
      right: initialX,
      bottom: initialY,
      pixels: 0,
    };
    while (head < tail) {
      const index = queue[head];
      head += 1;
      if (index === undefined) continue;
      if (labels) labels[index] = label;
      const x = index % width,
        y = Math.floor(index / width);
      bounds.left = Math.min(bounds.left, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x);
      bounds.bottom = Math.max(bounds.bottom, y);
      bounds.pixels += 1;
      if (x > 0) tail = enqueue(index - 1, alpha, visited, queue, tail);
      if (x + 1 < width) tail = enqueue(index + 1, alpha, visited, queue, tail);
      if (y > 0) tail = enqueue(index - width, alpha, visited, queue, tail);
      if (y + 1 < height) tail = enqueue(index + width, alpha, visited, queue, tail);
    }
    components.push(bounds);
  }
  return components;
}

function enqueue(
  index: number,
  alpha: Uint8Array,
  visited: Uint8Array,
  queue: Int32Array,
  tail: number,
) {
  if (visited[index] || alpha[index] <= FOREGROUND_ALPHA) return tail;
  visited[index] = 1;
  queue[tail] = index;
  return tail + 1;
}

function cropForComponent(
  component: PixelBounds,
  imageWidth: number,
  imageHeight: number,
): RemovalCrop | null {
  if (imageWidth <= 0 || imageHeight <= 0) return null;
  const componentWidth = component.right - component.left + 1,
    componentHeight = component.bottom - component.top + 1;
  const maxPadX = Math.max(0, Math.min(18, Math.floor((imageWidth * 0.71 - componentWidth) / 2))),
    maxPadY = Math.max(0, Math.min(18, Math.floor((imageHeight * 0.71 - componentHeight) / 2)));
  const minPadX = Math.min(maxPadX, 4),
    minPadY = Math.min(maxPadY, 4);
  const paddingX = Math.max(minPadX, Math.min(maxPadX, Math.ceil(componentWidth * 0.4))),
    paddingY = Math.max(minPadY, Math.min(maxPadY, Math.ceil(componentHeight * 0.4)));
  const left = Math.max(0, component.left - paddingX),
    top = Math.max(0, component.top - paddingY),
    right = Math.min(imageWidth, component.right + paddingX + 1),
    bottom = Math.min(imageHeight, component.bottom + paddingY + 1);
  const width = right - left,
    height = bottom - top,
    cropArea = (width * height) / (imageWidth * imageHeight),
    magnification = Math.min(imageWidth / width, imageHeight / height);
  if (cropArea >= 0.72 || magnification < 1.3) return null;
  return {
    x: left / imageWidth,
    y: top / imageHeight,
    width: width / imageWidth,
    height: height / imageHeight,
  };
}
