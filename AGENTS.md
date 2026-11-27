# Agent instructions — Shopping List

## Sources and scope
- Read `docs/shopping-list-design.md` and `docs/shopping-list-poc.md` before implementation. The 40 approved decisions are requirements. The design is version 0.9, subject to POC validation, not evidence that tests passed.
- Current phase: POC only. Implement one explicitly requested milestone at a time. Do not start the full MVP until the owner approves the POC results.
- Workflow update: use Codex Web and its cloud environment with GitHub, not VS Code or Live Server. The current repository is `zoharkolberg/shoping_list`. Use it for POC; dedicated production origin remains a requirement. This supersedes the local-editor and repository naming instructions in the earlier documents.
- Keep documentation and implementation consistent. Flag contradictions, unsupported assumptions and proposed architecture changes for owner approval; do not silently change requirements.

## Architecture
- Static HTML, CSS, vanilla JavaScript ES modules, Hebrew RTL, mobile-first PWA. No backend, central database, framework or required build pipeline. Development-only tooling requires justification.
- GitHub Pages, Google Drive and Sheets (one spreadsheet per list), Google Identity Services token model, Google Picker, IndexedDB and Service Worker/Cache API. Use static JSON catalogs. Separate POC and production Google Cloud projects.
- Local-first: atomically persist local edits and outbox operations before acknowledging local save. Support offline list creation, reopening and duplication. Retain unsynced operations across restarts.
- Poll active lists every 10 seconds and sync after edits; no required closed-app sync. Use field-level updates, three-way comparisons, deferred conflicts, quantity/unit as a logical pair, stable UUIDs and verification of uncertain writes. Do not claim exactly-once writes or perfect conflict detection. Undo deletion window: 5 seconds.

## Security and privacy
- Minimal scopes: drive.file, openid, email. No broader scopes or paid services without approval. Tokens in memory only; no client secrets, personal data, tokens, passwords or test account addresses in commits or logs. Public client IDs and restricted Picker API keys only when configured by owner.
- Bind tokens and local records to the correct account; enforce Google capabilities, explicit-email sharing only, no public-link sharing. Respect copy restrictions; document offline revocation limitations. No analytics or external error reporting.
- Use safe DOM text rendering, validate remote schema and inputs, RAW writes for user text. Cache static app assets only, not API responses or tokens. No independent local encryption in MVP; warn of pending changes before explicit logout data deletion.

## Testing and workflow
- Use synthetic data only. Never access real lists, change Google Cloud settings, share files or publish deployments without explicit approval. Do not claim real API or iPhone tests passed unless actually performed.
- Run relevant automated tests available in the cloud and provide manual steps for OAuth, two-account sharing, iPhone and offline tests. Record PASS/FAIL/BLOCKED and evidence without sensitive data. Prioritize duplicate creation, uncertain writes, row identity and concurrency risks.
- Keep changes small and reviewable. Work on a task branch and propose a pull request for review; do not merge or deploy without approval. Do not overwrite unrelated files or install unnecessary dependencies.
- At task completion report changed files, test commands and actual results, remaining risks/blockers, and next suggested milestone. Explain user-facing guidance in Hebrew.
