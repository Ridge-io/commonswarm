# Production baseline, recorded BEFORE any v0.1.5 mutation

Captured: 2026-08-03T03:34:33Z · Host: `https://commonswarm.com`
Purpose: Stage 9 requires the pre-mutation state recorded so a rollback has a target and the
post-deploy verification has something to diff against.

## Public routes (positive controls) + one negative control

| Route | HTTP |
|---|---|
| `/` | 200 |
| `/start` | 200 |
| `/app` | 200 |
| `/download` | 200 |
| `/invite` | 200 |
| `/privacy` | 200 |
| `/terms` | 200 |
| `/acceptable-use` | 200 |
| `/install.sh` | 200 |
| `/nope-baseline-control` | 404 |
| `/nope.sh` | 404 |

## Version surfaces on /download

```
   2 0.1.0
   4 0.1.4
```

Reading: four occurrences of the shipping version, two of the protocol version.

## /start backend meta — must be non-empty, must contain no service-role marker

```
commonswarm:url meta present: 1
service_role JWT marker (MUST be 0): 0
```

## Release / tag state

```
repo package.json version: 0.1.4
remote v0.1.5 tag count (MUST be 0): 0
latest release: CommonSwarm v0.1.4	Latest	v0.1.4	2026-07-31T04:51:35Z
```

## Not established here

Supabase function versions/hashes and the Vercel deployment id are not captured by these
unauthenticated probes; they must be recorded from the provider consoles/CLI immediately
before Stage 9 mutation, not from source or logs.
