import { DatabaseSync } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";

/**
 * Pi Durable stores live conversation state as a base plus delta revisions.
 * If the host dies during a generation, an append can arrive after a base was
 * replaced and the resulting chain cannot be materialized. The SDK then marks
 * the whole session as failed, which makes every IPC read fail until restart.
 *
 * Before opening the Harness, validate each live document and, if a chain is
 * broken, append a fresh empty base. The durable tasks and business tables are
 * untouched; startup recovery can then reconcile the interrupted work.
 */
export function repairLiveDocuments(file: string): number {
  const db = new DatabaseSync(file);
  let repaired = 0;
  try {
    const rows = db
      .prepare("SELECT id FROM documents WHERE kind = ? OR kind LIKE ?")
      .all('"pi.live"', '%"pi.live"%') as Array<{ id: number }>;
    for (const row of rows) {
      const revisions = db
        .prepare(
          "SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq",
        )
        .all(row.id) as Array<{ seq: number; kind: string; version: number; content: string }>;
      const base = [...revisions].reverse().find((revision) => revision.kind === "base");
      if (base === undefined) continue;
      try {
        let value: unknown = JSON.parse(base.content);
        for (const revision of revisions) {
          if (revision.seq <= base.seq) continue;
          if (revision.kind !== "delta" || revision.version !== base.version) {
            throw new Error("revision crosses a base/version boundary");
          }
          value = apply(value as never, JSON.parse(revision.content) as never);
        }
      } catch {
        const max = db
          .prepare("SELECT MAX(seq) AS seq FROM document_revisions WHERE document_id = ?")
          .get(row.id) as { seq: number | null };
        db.prepare(
          "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'base', ?, '{}')",
        ).run(row.id, (max.seq ?? 0) + 1, base.version);
        repaired += 1;
      }
    }
  } finally {
    db.close();
  }
  return repaired;
}
