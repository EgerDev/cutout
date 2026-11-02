# GitHub settings (owner actions)

The workflows and config files in `.github/` are in the repository. The settings below are
not files: the repository owner has to click them, and several (rulesets, secret scanning)
are only available on the current plan once the repository is **public**. Do them right
after changing the visibility, in this order.

## 1. Code security

**Settings → Advanced Security** (called "Code security" on older layouts):

| Setting                             | Value                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Private vulnerability reporting     | **Enable** (SECURITY.md and `security.txt` point here)                                                  |
| Dependency graph                    | Enabled                                                                                                 |
| Dependabot alerts                   | **Enable**                                                                                              |
| Dependabot security updates         | **Enable**                                                                                              |
| Grouped security updates            | Enable                                                                                                  |
| Dependabot version updates          | Already configured by `.github/dependabot.yml` (npm, Docker, Compose, Actions; weekly)                  |
| Code scanning → CodeQL analysis     | Leave **Default setup off**: `.github/workflows/codeql.yml` is the advanced setup, and the two conflict |
| Secret Protection (secret scanning) | **Enable**                                                                                              |
| Push protection                     | **Enable**                                                                                              |

## 2. Actions

**Settings → Actions → General**:

- **Actions permissions:** "Allow EgerDev, and select non-EgerDev, actions and reusable
  workflows", with "Allow actions created by GitHub" checked and these allowed:
  `docker/setup-buildx-action@*, docker/login-action@*, docker/build-push-action@*, ossf/scorecard-action@*`
- **Require actions to be pinned to a full-length commit SHA:** checked. Every workflow
  already pins by SHA; Dependabot keeps the pins current.
- **Approval for running fork pull request workflows:** "Require approval for all external
  contributors".
- **Workflow permissions:** "Read repository contents and packages permissions". Uncheck
  "Allow GitHub Actions to create and approve pull requests". (Jobs that need more ask for
  it explicitly: CodeQL and Scorecard for `security-events`, the release job for
  `contents`/`packages`/`id-token`/`attestations`.)

## 3. Branch ruleset for `main`

**Settings → Rules → Rulesets → New ruleset → New branch ruleset**:

- **Name:** `main`; **Enforcement status:** Active
- **Bypass list:** Repository admin (so a solo maintainer can still merge; remove once
  there is a second maintainer)
- **Target branches:** Include default branch
- **Rules:**
  - Restrict deletions
  - Require linear history
  - Require a pull request before merging: 1 required approval, dismiss stale approvals,
    require review from Code Owners (`.github/CODEOWNERS`), require conversation resolution
  - Require status checks to pass, with "Require branches to be up to date before
    merging". Add these checks (they appear in the picker after the workflows have run
    once on a pull request):
    - `test` (ci)
    - `dev-server suites` (ci)
    - `model mirror build` (ci)
    - `docker stack` (ci)
    - `analyze (javascript-typescript)` (codeql)
    - `review` (dependency-review)
  - Block force pushes

## 4. Tag ruleset for releases

Pushing a `v*.*.*` tag publishes a release (`.github/workflows/release.yml`), so only the
maintainer should be able to create one.

**Settings → Rules → Rulesets → New ruleset → New tag ruleset**:

- **Name:** `release tags`; **Enforcement status:** Active
- **Bypass list:** Repository admin
- **Target tags:** Include by pattern `v*`
- **Rules:** Restrict creations, Restrict updates, Restrict deletions

## 5. Release variable

**Settings → Secrets and variables → Actions → Variables → New repository variable**:

- **Name:** `SITE_URL`; **Value:** the public origin, e.g. `https://cutout.example.com`
  (no trailing path). The release build uses it for canonical and Open Graph URLs and the
  sitemap, in both the `.output` tarball and the image. Without it those are omitted.
- **Optional:** `UPTIME_URL`, your public deployment (e.g. `https://cutout.sh`). It turns on
  `.github/workflows/uptime.yml`, which checks that site every 15 minutes (health check,
  pinned model files, certificate expiry); a failure emails you. `UPTIME_MODEL_HOST` names
  the model mirror that deployment uses, if any.

Released artifacts are also what other people download and self-host. With `SITE_URL`
set, their copies point canonical links and the sitemap at your domain; leave it unset
for neutral releases and build your own deployment with its own `SITE_URL`,
`VITE_MODEL_HOST`, `VITE_SITE_OPERATOR` and `VITE_SITE_CONTACT` (DEPLOYMENT.md). Releases
never carry a model mirror: that would send every self-hoster's visitors to your
bandwidth.

## 6. The published image

After the first release, **your profile → Packages → cutout → Package settings**:

- **Change visibility:** Public (so `docker pull ghcr.io/egerdev/cutout:<version>` works
  without a login)
- Check that the package shows "Connected to EgerDev/cutout" (the image carries the
  `org.opencontainers.image.source` label, which links it).

## 7. Check it

```sh
gh api repos/EgerDev/cutout/rulesets --jq '.[].name'                      # main, release tags
gh api repos/EgerDev/cutout/vulnerability-alerts -i | head -1              # HTTP/2 204
gh api repos/EgerDev/cutout/private-vulnerability-reporting --jq .enabled  # true
gh api repos/EgerDev/cutout --jq .security_and_analysis                    # secret_scanning, push_protection: enabled
gh api repos/EgerDev/cutout/actions/permissions                            # allowed_actions: selected, sha_pinning_required: true
gh api repos/EgerDev/cutout/actions/permissions/workflow                   # default_workflow_permissions: read
```

Then open a test pull request: the checks listed in step 3 must appear as required.

## Cutting a release

1. `CHANGELOG.md`: rename `## [X.Y.Z] - unreleased` to the release date; bump `version` in
   `package.json` (and `npm install --package-lock-only` so the lockfile matches). Merge.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` from the merged `main`.
3. The release workflow reruns CI, then publishes `ghcr.io/egerdev/cutout:X.Y.Z` and
   `:sha-<commit>`, the `.output` tarball, a CycloneDX SBOM, `SHA256SUMS`, provenance
   attestations and the GitHub Release. It fails if the tag and `package.json` disagree or
   the changelog has no section for the version.
4. Verify: `gh attestation verify oci://ghcr.io/egerdev/cutout:X.Y.Z --owner EgerDev`.
5. Deploy and roll back by image tag as described in `DEPLOYMENT.md`.
