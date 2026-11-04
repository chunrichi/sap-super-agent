import type { DatabaseSync } from 'node:sqlite';
import type { Executor } from '@sap-superagent/protocol';
import { asBoolean, asNullableString, asNumber, asString, decodeJson, encodeJson } from './rows.js';

interface ExecutorRow {
  id: string;
  kind: string;
  user: string;
  machine_id_hash: string | null;
  capabilities: string;
  roles: string;
  workspaces: string;
  active_workspace_key: string | null;
  presence: string;
  accepting: number;
  max_concurrent: number;
  protocol_version: string;
  cli_version: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutorRecord {
  executor: Executor;
  lastHeartbeatAt: string | null;
}

function rowToRecord(row: ExecutorRow): ExecutorRecord {
  return {
    executor: {
      id: asString(row.id),
      kind: asString(row.kind) as Executor['kind'],
      user: asString(row.user),
      machineIdHash: asNullableString(row.machine_id_hash),
      capabilities: decodeJson<string[]>(row.capabilities),
      roles: decodeJson<Executor['roles']>(row.roles),
      workspaces: decodeJson<Executor['workspaces']>(row.workspaces),
      activeWorkspaceKey: asNullableString(row.active_workspace_key),
      presence: asString(row.presence) as Executor['presence'],
      accepting: asBoolean(row.accepting),
      maxConcurrent: asNumber(row.max_concurrent),
      protocolVersion: asString(row.protocol_version),
      cliVersion: asNullableString(row.cli_version),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    },
    lastHeartbeatAt: asNullableString(row.last_heartbeat_at),
  };
}

export function insertExecutor(
  db: DatabaseSync,
  executor: Executor,
  lastHeartbeatAt: string | null,
): void {
  db.prepare(
    `INSERT INTO executors (
      id, kind, user, machine_id_hash, capabilities, roles, workspaces, active_workspace_key,
      presence, accepting, max_concurrent, protocol_version, cli_version, last_heartbeat_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    executor.id,
    executor.kind,
    executor.user,
    executor.machineIdHash,
    encodeJson(executor.capabilities),
    encodeJson(executor.roles),
    encodeJson(executor.workspaces),
    executor.activeWorkspaceKey,
    executor.presence,
    executor.accepting ? 1 : 0,
    executor.maxConcurrent,
    executor.protocolVersion,
    executor.cliVersion,
    lastHeartbeatAt,
    executor.createdAt,
    executor.updatedAt,
  );
}

export function updateExecutor(
  db: DatabaseSync,
  executor: Executor,
  lastHeartbeatAt: string | null,
): void {
  db.prepare(
    `UPDATE executors SET kind = ?, user = ?, machine_id_hash = ?, capabilities = ?, roles = ?,
      workspaces = ?, active_workspace_key = ?, presence = ?, accepting = ?, max_concurrent = ?,
      protocol_version = ?, cli_version = ?, last_heartbeat_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    executor.kind,
    executor.user,
    executor.machineIdHash,
    encodeJson(executor.capabilities),
    encodeJson(executor.roles),
    encodeJson(executor.workspaces),
    executor.activeWorkspaceKey,
    executor.presence,
    executor.accepting ? 1 : 0,
    executor.maxConcurrent,
    executor.protocolVersion,
    executor.cliVersion,
    lastHeartbeatAt,
    executor.updatedAt,
    executor.id,
  );
}

export function getExecutor(db: DatabaseSync, id: string): ExecutorRecord | null {
  const row = db.prepare('SELECT * FROM executors WHERE id = ?').get(id) as unknown as
    | ExecutorRow
    | undefined;
  return row === undefined ? null : rowToRecord(row);
}

export function listExecutors(db: DatabaseSync): ExecutorRecord[] {
  const rows = db.prepare('SELECT * FROM executors ORDER BY created_at ASC').all() as unknown as ExecutorRow[];
  return rows.map(rowToRecord);
}

export function listStaleExecutors(db: DatabaseSync, cutoffIso: string): ExecutorRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM executors WHERE presence != 'offline' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)",
    )
    .all(cutoffIso) as unknown as ExecutorRow[];
  return rows.map(rowToRecord);
}
