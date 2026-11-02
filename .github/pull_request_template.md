## What and why

<!-- What changes for the user, and why. Link the issue it closes. -->

## Checklist

- [ ] A test fails without this change and passes with it (unit in `src/**/*.test.ts`, or a Playwright suite in `scripts/`)
- [ ] `npm run typecheck`, `npm run lint` and `npm run test:unit` pass
- [ ] The e2e/browser suites touched by this change pass against a server of this branch (`APP_URL=… npm run test:e2e`)
- [ ] Dependencies changed? `package-lock.json` is committed and the third-party notices are regenerated
- [ ] User-visible behaviour changed? README, the guide/privacy pages and `CHANGELOG.md` are updated
- [ ] Commits are signed off (`git commit -s`)
