import type { DatabaseSync } from 'node:sqlite';
import type { Demand } from '@sap-superagent/protocol';
import { asNullableString, asNumber, asString, decodeJson, encodeJson } from './rows.js';

interface DemandRow {
  id: string;
  no: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  requester: string;
  priority: string;
  template_id: string;
  template_version: number;
  status: string;
  workspace_binding: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

function rowToDemand(row: DemandRow): Demand {
  const no = asNullableString(row.no);
  const workspaceBinding = asNullableString(row.workspace_binding);
  return {
    id: asString(row.id),
    ...(no === null ? {} : { no }),
    title: asString(row.title),
    description: asString(row.description),
    acceptanceCriteria: decodeJson<string[]>(row.acceptance_criteria),
    requester: decodeJson<Demand['requester']>(row.requester),
    priority: asString(row.priority) as Demand['priority'],
    templateId: asString(row.template_id),
    templateVersion: asNumber(row.template_version),
    status: asString(row.status) as Demand['status'],
    workspaceBinding:
      workspaceBinding === null
        ? null
        : decodeJson<NonNullable<Demand['workspaceBinding']>>(workspaceBinding),
    source: asString(row.source) as Demand['source'],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function insertDemand(db: DatabaseSync, demand: Demand): void {
  db.prepare(
    `INSERT INTO demands (
      id, no, title, description, acceptance_criteria, requester, priority, template_id,
      template_version, status, workspace_binding, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    demand.id,
    demand.no ?? null,
    demand.title,
    demand.description,
    encodeJson(demand.acceptanceCriteria),
    encodeJson(demand.requester),
    demand.priority,
    demand.templateId,
    demand.templateVersion,
    demand.status,
    demand.workspaceBinding === null ? null : encodeJson(demand.workspaceBinding),
    demand.source,
    demand.createdAt,
    demand.updatedAt,
  );
}

export function updateDemand(db: DatabaseSync, demand: Demand): void {
  db.prepare(
    `UPDATE demands SET
      no = ?, title = ?, description = ?, acceptance_criteria = ?, requester = ?, priority = ?,
      template_id = ?, template_version = ?, status = ?, workspace_binding = ?, source = ?,
      created_at = ?, updated_at = ?
    WHERE id = ?`,
  ).run(
    demand.no ?? null,
    demand.title,
    demand.description,
    encodeJson(demand.acceptanceCriteria),
    encodeJson(demand.requester),
    demand.priority,
    demand.templateId,
    demand.templateVersion,
    demand.status,
    demand.workspaceBinding === null ? null : encodeJson(demand.workspaceBinding),
    demand.source,
    demand.createdAt,
    demand.updatedAt,
    demand.id,
  );
}

export function getDemand(db: DatabaseSync, id: string): Demand | null {
  const row = db.prepare('SELECT * FROM demands WHERE id = ?').get(id) as unknown as
    | DemandRow
    | undefined;
  return row === undefined ? null : rowToDemand(row);
}

export interface ListDemandsOptions {
  status?: string;
  q?: string;
  limit: number;
}

export function listDemands(db: DatabaseSync, options: ListDemandsOptions): Demand[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.status !== undefined) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.q !== undefined) {
    clauses.push('(title LIKE ? OR description LIKE ?)');
    const pattern = `%${options.q}%`;
    params.push(pattern, pattern);
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
  params.push(options.limit);
  const rows = db
    .prepare(`SELECT * FROM demands ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as unknown as DemandRow[];
  return rows.map(rowToDemand);
}
