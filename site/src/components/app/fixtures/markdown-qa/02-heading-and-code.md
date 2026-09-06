The release ritual starts with a clean build of the site, because Astro does not remove stale output and the observers read the shipped stylesheet off the built page.

## Run the gate

The command below builds the site, runs the observer in real Chrome, and prints the tail of the run so the screenshot count can be read back.

```bash
npm --prefix site run build && node --import tsx --test site/src/components/app/markdown-wordwrap-qa.observer.test.ts 2>&1 | tail -n 4 | cat
```

When it is green, the RESULTS table is the deliverable and every row in it was measured, not typed.
