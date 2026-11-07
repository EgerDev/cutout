function boundary(alpha, width, height) {
  const result = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const foreground = alpha[index] >= 128;
      const differs =
        (x > 0 && alpha[index - 1] >= 128 !== foreground) ||
        (x + 1 < width && alpha[index + 1] >= 128 !== foreground) ||
        (y > 0 && alpha[index - width] >= 128 !== foreground) ||
        (y + 1 < height && alpha[index + width] >= 128 !== foreground);
      if (differs) result[index] = 1;
    }
  }
  return result;
}

function boundaryScore(predicted, truth, width, height) {
  const left = boundary(predicted, width, height);
  const right = boundary(truth, width, height);
  let matched = 0;
  let predictedCount = 0;
  let truthCount = 0;
  for (let index = 0; index < left.length; index += 1) {
    predictedCount += left[index];
    truthCount += right[index];
    matched += left[index] && right[index] ? 1 : 0;
  }
  if (predictedCount === 0 && truthCount === 0) return 1;
  if (matched === 0) return 0;
  const precision = matched / predictedCount;
  const recall = matched / truthCount;
  return (2 * precision * recall) / (precision + recall);
}

export function alphaMetrics(predicted, truth, width, height) {
  const pixels = width * height;
  if (predicted.length !== pixels || truth.length !== pixels)
    throw new Error(`Alpha pixel count must equal ${pixels}`);
  let absolute = 0;
  let squared = 0;
  let gradient = 0;
  let gradientEdges = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const difference = (predicted[index] - truth[index]) / 255;
      absolute += Math.abs(difference);
      squared += difference * difference;
      if (x + 1 < width) {
        gradient += Math.abs(
          (predicted[index + 1] - predicted[index] - truth[index + 1] + truth[index]) / 255,
        );
        gradientEdges += 1;
      }
      if (y + 1 < height) {
        gradient += Math.abs(
          (predicted[index + width] - predicted[index] - truth[index + width] + truth[index]) / 255,
        );
        gradientEdges += 1;
      }
    }
  }
  return {
    mae: absolute / pixels,
    mse: squared / pixels,
    gradientMae: gradientEdges ? gradient / gradientEdges : 0,
    boundaryF1: boundaryScore(predicted, truth, width, height),
  };
}
