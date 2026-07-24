#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [round, swarmName, human1, human2, root] = process.argv.slice(2);
if (!round || !swarmName || !human1 || !human2 || !root) {
  throw new Error("collect-remote requires round, swarm, both names, and root");
}

const db = new DatabaseSync(join(homedir(), ".swarm", "swarm.db"), {
  readOnly: true,
});
const messages = db.prepare(`
  SELECT m.id, m.from_agent, m.to_agent, m.body, m.created_at
  FROM messages m
  JOIN swarms s ON s.id = m.swarm_id
  WHERE s.name = ?
    AND (
      (m.from_agent = ? AND m.to_agent = ?)
      OR
      (m.from_agent = ? AND m.to_agent = ?)
    )
  ORDER BY m.id
`).all(swarmName, human1, human2, human2, human1);
db.close();

const cwd = join(root, "human2", `r${round}`);
const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : null;
const readJsonl = (path) => {
  const raw = read(path);
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
};

process.stdout.write(JSON.stringify({
  messages,
  feedback: read(join(cwd, "FEEDBACK.md")),
  journal: read(join(cwd, "JOURNAL.md")),
  result: read(join(cwd, "RESULT.md")),
  isolationVoid: read(join(cwd, "ISOLATION_VOID.md")),
  commands: readJsonl(join(root, "logs", `r${round}`, "human2.jsonl")),
  isolationEvents: readJsonl(
    join(root, "logs", `r${round}`, "isolation-events.jsonl"),
  ).filter((event) => event.role === "human2"),
}));
