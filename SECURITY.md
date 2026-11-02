# Security policy

## Supported versions

Security fixes go into the latest `main` branch and the site deployed from it. Older
releases and tags are not patched; update to the latest release instead.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
**<https://github.com/EgerDev/cutout/security/advisories/new>**

Please do not open a public issue, pull request or discussion for a security problem.

A useful report includes:

- what an attacker can do and what they need (a crafted file, a link, access to the network);
- the steps or a file that reproduces it, and the browser and version you used;
- the commit or release you tested.

We aim to acknowledge a report within 7 days and to keep you informed until it is fixed.
Once a fix is released we publish an advisory and, if you wish, credit you.

## Scope

In scope:

- the web app in this repository: file decoders and parsers, the URL launch parameters
  (`?src=`, `download=`, `name=` and the rest), saved workspaces, metadata stripping, exports;
- the server, headers and deployment files in this repository (`server/`, `deploy/`,
  `Dockerfile`, `compose.yaml`);
- the install-time patch of transformers.js and onnxruntime-web (`scripts/patch-dependencies.mjs`).

Out of scope:

- vulnerabilities in dependencies that Cutout cannot reach; report those upstream (tell us
  if Cutout is affected);
- Hugging Face and other third-party services;
- denial of service by sending large amounts of traffic;
- reports from automated scanners without a demonstrated impact.

## Please don't

- test against the public site in ways that affect other visitors (load testing, flooding);
- access or change data that isn't yours;
- publish details before a fix is available or we have agreed on a date.

Cutout processes images in the visitor's browser and the server stores no user data, so a
local build (`npm run build && npm start`) is the best place to experiment.

## Accepted risks

- **Model integrity has a defined scope.** On HTTPS and localhost, every pinned
  background-removal model file is checked against its SHA-256 before caching,
  parsing or inference, including reads from the browser cache. Unknown revisions,
  files and mismatched bytes are refused (`src/lib/removal-model-specs.ts` and
  `src/lib/removal-model-integrity.ts`). Plain-HTTP LAN origins without WebCrypto
  cannot perform this check. Optional enhancement and depth models are pinned to
  revisions but are outside this removal-integrity wrapper. Hash verification
  establishes byte identity, not that a model or runtime is free of vulnerabilities.
  WebAssembly/WebGPU isolation reduces exposure; it does not make runtime exploits
  impossible. A compromised optional-model host, browser or runtime remains a risk.
- **Pre-release runtime dependencies.** The server is built with Nitro 3, which is still in
  beta, and transformers.js 3.8.1 pins a nightly (`-dev`) build of onnxruntime-web.
  Dependabot tracks both, and we move to stable releases when they are available.
