import type { DatabaseSync } from 'node:sqlite';
import type {
  Artifact,
  ArtifactKind,
  ArtifactRef,
  ArtifactVersion,
} from '@sap-superagent/protocol';
import { asBoolean, asNullableString, asNumber, asString } from './rows.js';

interface ArtifactRow {
  id: string;
  demand_id: string;
  kind: string;
  stage_key: string | null;
  stage_run_id: string | null;
  state: string;
  current_version: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactVersionRow {
  artifact_id: string;
  version: number;
  content_ref: string;
  content_type: string;
  checksum: string;
  summary: string | null;
  author_type: string;
  author_id: string;
  stale: number;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: asString(row.id),
    demandId: asString(row.demand_id),
    kind: asString(row.kind) as ArtifactKind,
    stageKey: asNullableString(row.stage_key),
    stageRunId: asNullableString(row.stage_run_id),
    state: asString(row.state) as Artifact['state'],
    currentVersion: asNumber(row.current_version),
    title: asNullableString(row.title),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToArtifactVersion(row: ArtifactVersionRow): ArtifactVersion {
  return {
    artifactId: asString(row.artifact_id),
    version: asNumber(row.version),
    contentRef: asString(row.content_ref),
    contentType: asString(row.content_type),
    checksum: asString(row.checksum),
    summary: asNullableString(row.summary),
    authorType: asString(row.author_type) as ArtifactVersion['authorType'],
    authorId: asString(row.author_id),
    stale: asBoolean(row.stale),
    createdAt: asString(row.created_at),
  };
}

export function insertArtifact(db: DatabaseSync, artifact: Artifact): void {
  db.prepare(
    `INSERT INTO artifacts (id, demand_id, kind, stage_key, stage_run_id, state, current_version, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifact.id,
    artifact.demandId,
    artifact.kind,
    artifact.stageKey,
    artifact.stageRunId,
    artifact.state,
    artifact.currentVersion,
    artifact.title,
    artifact.createdAt,
    artifact.updatedAt,
  );
}

export function updateArtifactState(
  db: DatabaseSync,
  id: string,
  state: Artifact['state'],
  updatedAt: string,
): void {
  db.prepare('UPDATE artifacts SET state = ?, updated_at = ? WHERE id = ?').run(
    state,
    updatedAt,
    id,
  );
}

export function getArtifact(db: DatabaseSync, id: string): Artifact | null {
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as unknown as
    | ArtifactRow
    | undefined;
  return row === undefined ? null : rowToArtifact(row);
}

export function listArtifactsForDemand(db: DatabaseSync, demandId: string): Artifact[] {
  const rows = db
    .prepare('SELECT * FROM artifacts WHERE demand_id = ? ORDER BY created_at ASC')
    .all(demandId) as unknown as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function insertArtifactVersion(db: DatabaseSync, version: ArtifactVersion): void {
  db.prepare(
    `INSERT INTO artifact_versions (
      artifact_id, version, content_ref, content_type, checksum, summary, author_type,
      author_id, stale, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.artifactId,
    version.version,
    version.contentRef,
    version.contentType,
    version.checksum,
    version.summary,
    version.authorType,
    version.authorId,
    version.stale ? 1 : 0,
    version.createdAt,
  );
}

export function getArtifactVersion(
  db: DatabaseSync,
  artifactId: string,
  version: number,
): ArtifactVersion | null {
  const row = db
    .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
    .get(artifactId, version) as unknown as ArtifactVersionRow | undefined;
  return row === undefined ? null : rowToArtifactVersion(row);
}

export interface ArtifactWithVersion {
  artifact: Artifact;
  version: ArtifactVersion;
}

export function listArtifactVersionsForDemand(
  db: DatabaseSync,
  demandId: string,
): ArtifactVersion[] {
  const rows = db
    .prepare(
      `SELECT av.* FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id
       WHERE a.demand_id = ? ORDER BY av.created_at ASC`,
    )
    .all(demandId) as unknown as ArtifactVersionRow[];
  return rows.map(rowToArtifactVersion);
}

/** Latest committed version per artifact kind for a demand. */
export function latestVersionsByKind(
  db: DatabaseSync,
  demandId: string,
): Map<ArtifactKind, ArtifactWithVersion> {
  const rows = db
    .prepare(
      `SELECT a.*, av.version AS av_version, av.content_ref AS av_content_ref,
              av.content_type AS av_content_type, av.checksum AS av_checksum,
              av.summary AS av_summary, av.author_type AS av_author_type,
              av.author_id AS av_author_id, av.stale AS av_stale, av.created_at AS av_created_at
       FROM artifacts a
       JOIN artifact_versions av ON av.artifact_id = a.id AND av.version = a.current_version
       WHERE a.demand_id = ?
       ORDER BY a.created_at ASC`,
    )
    .all(demandId) as unknown as Array<
    ArtifactRow & {
      av_version: number;
      av_content_ref: string;
      av_content_type: string;
      av_checksum: string;
      av_summary: string | null;
      av_author_type: string;
      av_author_id: string;
      av_stale: number;
      av_created_at: string;
    }
  >;
  const latest = new Map<ArtifactKind, ArtifactWithVersion>();
  for (const row of rows) {
    const artifact = rowToArtifact(row);
    const version = rowToArtifactVersion({
      artifact_id: artifact.id,
      version: row.av_version,
      content_ref: row.av_content_ref,
      content_type: row.av_content_type,
      checksum: row.av_checksum,
      summary: row.av_summary,
      author_type: row.av_author_type,
      author_id: row.av_author_id,
      stale: row.av_stale,
      created_at: row.av_created_at,
    });
    const previous = latest.get(artifact.kind);
    if (previous === undefined || previous.artifact.createdAt <= artifact.createdAt) {
      latest.set(artifact.kind, { artifact, version });
    }
  }
  return latest;
}

/** Only the artifact references, shaped for the core stage helpers. */
export function latestArtifactRefsByKind(
  db: DatabaseSync,
  demandId: string,
): Map<ArtifactKind, ArtifactRef> {
  const refs = new Map<ArtifactKind, ArtifactRef>();
  for (const [kind, entry] of latestVersionsByKind(db, demandId)) {
    refs.set(kind, { artifactId: entry.artifact.id, version: entry.version.version });
  }
  return refs;
}
