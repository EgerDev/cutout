#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { edgeCases } from "./generate-known-alpha.mjs";

const generatedCategories = [
  "portrait-hair",
  "pets-fur",
  "plants",
  "products",
  "low-contrast",
  "groups-small-subjects",
  "glass-partial-alpha",
  "logo-scan-illustration",
  "existing-transparency",
  "extreme-aspect-ratio",
];

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileRecord(root, path, includeDimensions) {
  const record = { path, sha256: await digest(join(root, path)) };
  if (!includeDimensions) return record;
  const metadata = await sharp(join(root, path)).metadata();
  return { ...record, width: metadata.width, height: metadata.height };
}

function generatedSplit(index) {
  if (index < 10) return "smoke";
  if (index < 25) return "tune";
  return "heldout";
}

export async function buildCorpusManifest(root) {
  const aimIndex = JSON.parse(await readFile(join(root, "aim500/source-index.json"), "utf8"));
  const fixtures = [];
  for (const source of aimIndex.records) {
    fixtures.push({
      id: `aim500-${source.name.replace("o_", "")}`,
      split: source.split,
      category: source.category,
      evaluation: "real-alpha",
      input: await fileRecord(root, `aim500/input/${source.name}.jpg`, true),
      alpha: await fileRecord(root, `aim500/alpha/${source.name}.png`, true),
      provenance: {
        sourceUrl: aimIndex.datasetFolderUrl,
        sourceId: source.inputSourceId,
        annotationSourceId: source.alphaSourceId,
        license: "MIT (AIM-500 release agreement); underlying image copyrights remain with original owners",
        note: `${aimIndex.categorizationMethod} Local research/evaluation only; do not redistribute as an application fixture`,
      },
    });
  }
  const generatedInputs = (await readdir(join(root, "known-alpha/input"))).sort();
  for (let index = 0; index < generatedInputs.length; index += 1) {
    const name = generatedInputs[index];
    const id = name.slice(0, -extname(name).length);
    // Edge-case fixtures (known-41+) are labelled by the generator's own tables,
    // not by index into the original ten categories.
    const edge = /^known-(\d+)$/.exec(id);
    const category = edge && Number(edge[1]) >= 41
      ? edgeCases[(Number(edge[1]) - 41) % edgeCases.length]
      : generatedCategories[index % generatedCategories.length];
    fixtures.push({
      id,
      split: generatedSplit(index),
      category,
      evaluation: "known-alpha",
      input: await fileRecord(root, `known-alpha/input/${name}`, true),
      alpha: await fileRecord(root, `known-alpha/alpha/${id}.png`, true),
      provenance: {
        sourceUrl: "generated:scripts/benchmark/generate-known-alpha.mjs",
        sourceId: id,
        license: "CC0-1.0",
        note: "Deterministic geometric fixture; ground-truth alpha is construction data, not a photographic annotation",
      },
    });
  }
  // This is the historical corpus copy, not the replacement public sample. Keep its original provenance.
  const excludedFixtures = [{
    id: "current-sample-provenance-blocked",
    split: "smoke",
    category: "current-sample",
    evaluation: "visual-only",
    input: await fileRecord(root, "current/sample.jpg", true),
    provenance: {
      sourceUrl: "repository:public/sample.jpg",
      sourceId: "66528ac22db767382652b575ce3184099da97386",
      license: "UNKNOWN",
      note: "CREDITS.md says provenance is unconfirmed; excluded from quality metrics and release claims",
    },
  }];
  const manifest = {
    schemaVersion: 1,
    heldoutState: "locked",
    datasets: [
      {
        name: aimIndex.dataset,
        officialRepositoryCommit: aimIndex.officialRepositoryCommit,
        folderUrl: aimIndex.datasetFolderUrl,
        licenseAgreementUrl: aimIndex.licenseAgreementUrl,
        licenseAgreementSha256: aimIndex.licenseAgreementSha256,
        citation: aimIndex.citation,
        provenanceLimit: aimIndex.provenanceLimit,
        categorizationMethod: aimIndex.categorizationMethod,
      },
      {
        name: "Cutout deterministic known-alpha fixtures",
        generator: "scripts/benchmark/generate-known-alpha.mjs",
        license: "CC0-1.0",
      },
    ],
    fixtures,
    excludedFixtures,
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCorpusManifest(resolve(process.argv[2] ?? ".omo/benchmarks/cutout-owned-engine/corpus"))
    .then((manifest) => process.stdout.write(`${JSON.stringify({ ok: true, fixtures: manifest.fixtures.length })}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    });
}
