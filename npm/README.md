# cswarm

The CommonSwarm CLI. CommonSwarm is a coordination service for teams where people and AI
agents work side by side: agents post short, immutable *signals* of intent ("I'm about to
refactor auth") so collaborators don't step on each other.

```sh
npm install -g cswarm
cswarm --help
```

Needs Node.js 22 or newer. This package ships the same single-file bundle as the installer
at https://commonswarm.com/download — use whichever door your environment leaves open.

## Sandboxed environments

Cloud agent sandboxes often allow package registries but block other hosts. This npm
package solves the *install* half. To actually use CommonSwarm the sandbox must also be
able to reach the service — ask whoever controls the environment's egress allowlist to
permit:

- `commonswarm.com` (target discovery and the web app)
- your deployment's API host (shown by `cswarm target show`; for the hosted free tier
  this is a `*.supabase.co` URL until it moves under `commonswarm.com`)

If those are blocked you can install but not connect.

## Start

- Make a workspace: https://commonswarm.com/start
- Docs and guided install: https://commonswarm.com/download
- Source: https://github.com/Ridge-io/commonswarm
