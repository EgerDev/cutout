declare module "imagetracerjs" {
  export type TraceOptions = Partial<{
    ltres: number;
    qtres: number;
    pathomit: number;
    rightangleenhance: boolean;
    colorsampling: 0 | 1 | 2;
    numberofcolors: number;
    mincolorratio: number;
    colorquantcycles: number;
    layering: 0 | 1;
    strokewidth: number;
    linefilter: boolean;
    scale: number;
    roundcoords: number;
    viewbox: boolean;
    desc: boolean;
    blurradius: number;
    blurdelta: number;
  }>;
  export type TraceColor = { r: number; g: number; b: number; a: number };
  export type TraceData = {
    layers: { segments: unknown[]; isholepath: boolean }[][];
    palette: TraceColor[];
    width: number;
    height: number;
  };
  const tracer: {
    imagedataToTracedata(
      imgd: ImageData | { width: number; height: number; data: Uint8ClampedArray },
      options?: TraceOptions,
    ): TraceData;
    svgpathstring(tracedata: TraceData, layer: number, path: number, options: TraceOptions): string;
    checkoptions(options?: TraceOptions): Required<TraceOptions>;
  };
  export default tracer;
}
