# Connection handoff repair — 2026-09-08

Base: f4eb01803054ac9a70610fafa6891215cf8ce491 (v0.1.65). Local, uncommitted patch. No deployment, release, real connection, model, or receive configuration was started.

## Cause and limits

Trace: AgentConnect's mint result and deployment metadata feed dashboardAgentPrompt and dashboardAgentConnection. The latter serializes the versioned envelope with JSON.stringify; credentialArtifact also uses JSON.stringify. AgentConnect displays the source through textContent, writes its private #prompt string through navigator.clipboard.writeText, and downloads its #connection string as an application/json Blob. The fallback selects the pre element's text. None of these source paths escapes underscores or turns URLs into links.

The inline prompt introduced in 3e5046d placed JSON and the installer command in Markdown prose without code fences. This exposes machine input to later rich-text/Markdown conversion. The exact converter that damaged the reported paste is NOT established. No real payload was read and no claim is made that the old CLI leaked it. A synthetic fixture reproduces the reported invalid backslash-underscore escapes and Markdown-wrapped URL.

## Change

The prompt fences the install command and JSON separately. JSON.stringify remains the serializer; credential bytes are not edited. The fence grows if input contains backticks. The copy method remains a plain-text copy of the source string. Instructions say to save only the JSON block contents, without fences, and use the existing “Use a setup file” download if the paste is damaged. That download avoids text conversion.

Setup detects malformed JSON before any authentication. Invalid underscore escapes or pasted fences get a fixed Markdown-damage message. A Markdown-wrapped URL gets a fixed URL-damage message before authentication. Errors show no raw parser excerpt, JSON, or credential value. Existing error codes and JSON envelope are unchanged; setup --check-version still returns {"setup_version":1}.

No importer repair was added: deleting backslashes can change credentials. The rejected file remains unchanged. Valid existing files remain accepted. The former instruction “save the JSON below unchanged” is replaced with block-only extraction and file-download recovery. Wake wording now names Claude Code preview channels and Codex turn checks; no wake feature changed.

## Evidence

- npm run build and npm run check:tests: passed.
- npm test: 869 passed.
- npm run test:p1-cli: 573 passed. The changed agent-onboarding.test.ts is reached by this glob, not the core literal list.
- Site build: passed. npm --prefix site test: 543 passed, one pre-existing skip. First run had one unrelated Chrome layout-test timeout; full rerun passed after other suites stopped.
- scripts/build-release.sh: exit 0. Standalone artifact copied outside the repository and run as CommonJS: 24 focused onboarding/prompt tests passed. Running the extensionless CommonJS bundle via node inside this ESM repository is not the shipped invocation and failed; the external artifact invocation passed.
- Negative control: restoring the two production files from the base makes both the fenced-copy test and Markdown-error test fail. Restoring the patch makes them pass.
- The component's actual copy method runs with an inert DOM/clipboard harness: it copies source text even when display text differs. Extracted copied JSON equals the synthetic source envelope; underscore-bearing token and key bytes are unchanged; the shell block equals `curl -fsSL https://commonswarm.com/install.sh | sh`.
- Local HTTP fixture: generated prompt → JSON extraction → private file → compiled CLI setup → saved profile → feed, with test credentials. Invalid cases use a counting fetcher and prove zero authentication calls. Plain and JSON CLI output omit synthetic secret markers. Rejected files stay byte-identical.

Not established: the original paste's conversion layer, live authentication, actual desktop clipboard/paste behavior, or live host wake. Code fences reduce Markdown damage but cannot force an external editor to preserve text. No browser tabs were opened for manual work; the existing site suite ran its own browser fixtures.

## Delivery and cleanup

A site deployment is needed for users to get the fenced prompt; a new CLI release is needed for the fixed errors. Neither is authorized here. No version bump or commit was made, so exact-SHA landing review remains for the release owner. The local patch was transferred to the main workspace without creating a commit. Only this task's worktree and branch were removed after branch-audit; the three pre-existing lanes were retained.
