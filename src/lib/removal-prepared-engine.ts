import { REMOVAL_RUNTIME_FINGERPRINT, field as unknownField } from "./removal-provider.ts";
import type { RemovalFailureKind } from "./removal-provider.ts";
import {
  disposeRemovalResource,
  disposeRemovalResources,
  isUnknownCallable,
  parseRemovalTensor,
  removalCleanupFailure,
  removalResourceFailure,
} from "./removal-model-specs.ts";
import type {
  PreparedRemovalEngine,
  RemovalLoadRequest,
  RemovalModelRoute,
  RemovalModelSpec,
} from "./removal-model-specs.ts";

type PrepareEngineOptions = {
  readonly request: RemovalLoadRequest;
  readonly spec: RemovalModelSpec;
  readonly route: RemovalModelRoute;
  readonly processorValue: unknown;
  readonly modelValue: unknown;
  readonly contextLost?: Promise<never>;
  readonly contextFailure?: () => Error | undefined;
};

type OutputFailureKind = Extract<RemovalFailureKind, "gpu-mask" | "model-output">;

export class RemovalModelOutputError extends Error {
  readonly name = "RemovalModelOutputError";
  readonly failureKind: OutputFailureKind;

  constructor(
    request: RemovalLoadRequest,
    message: string,
    options?: { readonly cause?: unknown; readonly failureKind?: OutputFailureKind },
  ) {
    super(message, options);
    this.failureKind = options?.failureKind ?? (request.provider === "webgpu" ? "gpu-mask" : "model-output");
  }
}

export function prepareRemovalEngine(options: PrepareEngineOptions): PreparedRemovalEngine {
  const { request, spec, route, processorValue, modelValue } = options;
  if (
    !isUnknownCallable(processorValue) ||
    !isUnknownCallable(modelValue) ||
    !isUnknownCallable(unknownField(modelValue, "dispose"))
  ) {
    throw new TypeError("Transformers returned a non-callable removal model or processor");
  }
  const remaining = new Set([processorValue, modelValue]);
  let disposing: Promise<void> | undefined;
  const boundary = (run: () => unknown) => {
    const failure = options.contextFailure?.();
    if (failure) throw failure;
    const pending = Promise.resolve(run());
    return options.contextLost ? Promise.race([pending, options.contextLost]) : pending;
  };
  return {
    identity: {
      model: request.model,
      modelId: spec.modelId,
      revision: spec.revision,
      dtype: route.dtype,
      onnxFile: route.onnxFile,
      inputName: spec.inputName,
      inputDims: spec.inputDims,
      outputName: spec.outputName,
      outputDims: spec.outputDims,
      fingerprint: REMOVAL_RUNTIME_FINGERPRINT,
    },
    provider: request.provider,
    outputImageSemantics: spec.semantics,
    async processor(image) {
      const output: unknown = await boundary(() => processorValue(image));
      const candidate = unknownField(output, "pixel_values");
      const tensor = parseRemovalTensor(candidate, spec.inputDims);
      if (!tensor) {
        return rejectReturnedTensor(
          request,
          candidate,
          "Processor returned an invalid input tensor",
          "model-output",
        );
      }
      return { pixel_values: tensor };
    },
    async model(inputs) {
      const output: unknown = await boundary(() => modelValue({ [spec.inputName]: inputs.input_image }));
      const candidate = unknownField(output, spec.outputName);
      const tensor = parseRemovalTensor(candidate, spec.outputDims);
      if (!tensor) {
        // D1 keeps missing output non-persistent. A returned malformed tensor is the
        // distinct GPU-mask defect, confirmed by WASM before recording (C16).
        return rejectReturnedTensor(request, candidate, `Model returned malformed ${spec.outputName}`, candidate == null ? "model-output" : undefined);
      }
      for (let index = 0; index < tensor.data.length; index += 1) {
        if (!Number.isFinite(tensor.data[index])) {
          return rejectReturnedTensor(request, tensor, `Model returned nonfinite ${spec.outputName}`);
        }
      }
      return { output_image: tensor };
    },
    async dispose() {
      if (!remaining.size || options.contextFailure?.()) return;
      disposing ??= (async () => {
        const failures: unknown[] = [];
        for (const resource of remaining) {
          try {
            await disposeRemovalResource(resource);
            remaining.delete(resource);
          } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw removalResourceFailure(failures);
      })().finally(() => { disposing = undefined; });
      await disposing;
    },
  };
}

async function rejectReturnedTensor(
  request: RemovalLoadRequest,
  returned: unknown,
  message: string,
  failureKind?: OutputFailureKind,
): Promise<never> {
  const source = new RemovalModelOutputError(request, message, { failureKind });
  const cleanup = await disposeRemovalResources([returned]);
  if (cleanup.length === 0) throw source;
  throw new RemovalModelOutputError(request, message, {
    failureKind: source.failureKind,
    cause: removalCleanupFailure(source, cleanup),
  });
}
