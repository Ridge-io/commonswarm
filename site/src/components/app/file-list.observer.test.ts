import assert from "node:assert/strict";
import { test } from "node:test";
import { FILE_CONTENT_WARNING } from "../../lib/commonswarm.js";
import type { DisplayFile } from "../../lib/file-list.js";
import { renderFileListFixtures } from "./file-list.fixture.js";

/* Reached by site/package.json's recursive component observer-test glob. */
const NOW = Date.parse("2026-08-18T18:00:00.000Z");
const HOSTILE_NAME = '<em data-hostile="true">owned</em>.md';

const file = (overrides: Partial<DisplayFile> = {}): DisplayFile => ({
  fileId: "10000000-0000-4000-8000-000000000001",
  name: "review-plan.docx",
  currentVersion: 3,
  sizeBytes: 1_536,
  uploadedByKind: "agent",
  uploadedBy: "20000000-0000-4000-8000-000000000001",
  uploaderName: "Atlas",
  committedAt: "2026-08-18T16:00:00.000Z",
  tombstonedAt: null,
  ...overrides,
});

const scenariosPromise = renderFileListFixtures(
  {
    rows: [
      file(),
      file({
        fileId: "10000000-0000-4000-8000-000000000002",
        name: "old-notes.pdf",
        currentVersion: 1,
        sizeBytes: 24_000,
        uploadedByKind: "user",
        uploadedBy: "30000000-0000-4000-8000-000000000001",
        uploaderName: "Dana Rivera",
        committedAt: "2026-08-10T18:00:00.000Z",
        tombstonedAt: "2026-08-12T12:00:00.000Z",
      }),
      file({
        fileId: "10000000-0000-4000-8000-000000000003",
        name: HOSTILE_NAME,
        currentVersion: 2,
        sizeBytes: 842,
        uploaderName: "Wren",
      }),
    ],
    empty: [],
  },
  FILE_CONTENT_WARNING,
  NOW,
);

test("file rows render name, human size, version, uploader, age, and one warning", async () => {
  const snapshot = (await scenariosPromise).rows!;
  assert.equal(snapshot.rowCount, 3);
  assert.equal(snapshot.downloadButtonCount, 3);
  assert.deepEqual(snapshot.sizes, ["1.5 KB", "24 KB", "842 B"]);
  assert.deepEqual(snapshot.versions, ["v3", "v1", "v2"]);
  assert.deepEqual(snapshot.uploaders, ["Atlas", "Dana Rivera", "Wren"]);
  assert.equal(snapshot.ages[0], "2 hours ago");
  assert.equal(snapshot.warningCount, 1);
  assert.equal(snapshot.warningText, FILE_CONTENT_WARNING);
});

test("tombstoned files stay visible and name their restore deadline", async () => {
  const snapshot = (await scenariosPromise).rows!;
  assert.equal(snapshot.removedNotes.length, 1);
  assert.match(snapshot.removedNotes[0]!, /^Removed · restorable until /);
  assert.match(snapshot.innerHtml, /dashboard__file-row--removed/);
});

test("an empty workspace renders one quiet line without a file list", async () => {
  const snapshot = (await scenariosPromise).empty!;
  assert.equal(snapshot.rowCount, 0);
  assert.equal(snapshot.emptyHidden, false);
  assert.equal(snapshot.emptyText, "No files shared yet.");
  assert.equal(snapshot.warningCount, 0);
});

test("hostile file names land as textContent, never markup", async () => {
  const snapshot = (await scenariosPromise).rows!;
  assert.equal(snapshot.names[2], HOSTILE_NAME);
  assert.equal(snapshot.dangerousElementCount, 0);
  assert.match(snapshot.innerHtml, /&lt;em data-hostile="true"&gt;owned&lt;\/em&gt;\.md/);
});
