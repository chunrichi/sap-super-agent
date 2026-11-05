import type { DatabaseSync } from 'node:sqlite';
import type { Task, TaskSummary } from '@sap-superagent/protocol';
import { asNullableString, asString, decodeJson, encodeJson } from './rows.js';

interface TaskRow {
  id: string;
  demand_id: string;
  stage_run_id: string | null;
  title: string;
  executor_kind: string;
  required_roles: string;
  workspace_binding: string | null;
  priority: string;
  due_at: string | null;
  state: string;
  last_holder_user_ids: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  const workspaceBinding = asNullableString(row.workspace_binding);
  return {
    id: asString(row.id),
    demandId: asString(row.demand_id),
    stageRunId: asNullableString(row.stage_run_id),
    title: asString(row.title),
    executorKind: asString(row.executor_kind) as Task['executorKind'],
    requiredRoles: decodeJson<Task['requiredRoles']>(row.required_roles),
    workspaceBinding:
      workspaceBinding === null
        ? null
        : decodeJson<NonNullable<Task['workspaceBinding']>>(workspaceBinding),
    priority: asString(row.priority) as Task['priority'],
    dueAt: asNullableString(row.due_at),
    state: asString(row.state) as Task['state'],
    lastHolderUserIds: decodeJson<string[]>(row.last_holder_user_ids),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function taskToSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    demandId: task.demandId,
    title: task.title,
    executorKind: task.executorKind,
    requiredRoles: task.requiredRoles,
    workspaceBinding: task.workspaceBinding,
    priority: task.priority,
    dueAt: task.dueAt,
  };
}

export function insertTask(db: DatabaseSync, task: Task): void {
  db.prepare(
    `INSERT INTO tasks (
      id, demand_id, stage_run_id, title, executor_kind, required_roles, workspace_binding,
      priority, due_at, state, last_holder_user_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.demandId,
    task.stageRunId,
    task.title,
    task.executorKind,
    encodeJson(task.requiredRoles),
    task.workspaceBinding === null ? null : encodeJson(task.workspaceBinding),
    task.priority,
    task.dueAt,
    task.state,
    encodeJson(task.lastHolderUserIds),
    task.createdAt,
    task.updatedAt,
  );
}

export function updateTask(db: DatabaseSync, task: Task): void {
  db.prepare(
    `UPDATE tasks SET stage_run_id = ?, title = ?, executor_kind = ?, required_roles = ?,
      workspace_binding = ?, priority = ?, due_at = ?, state = ?, last_holder_user_ids = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    task.stageRunId,
    task.title,
    task.executorKind,
    encodeJson(task.requiredRoles),
    task.workspaceBinding === null ? null : encodeJson(task.workspaceBinding),
    task.priority,
    task.dueAt,
    task.state,
    encodeJson(task.lastHolderUserIds),
    task.updatedAt,
    task.id,
  );
}

export function getTask(db: DatabaseSync, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as
    | TaskRow
    | undefined;
  return row === undefined ? null : rowToTask(row);
}

export function listPendingTasks(db: DatabaseSync, executorKind: Task['executorKind']): Task[] {
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE state = 'pending' AND executor_kind = ? ORDER BY created_at ASC",
    )
    .all(executorKind) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export function listTasksByState(
  db: DatabaseSync,
  state: Task['state'],
  limit: number,
): Task[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE state = ? ORDER BY created_at ASC LIMIT ?')
    .all(state, limit) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export function listTasksForDemand(db: DatabaseSync, demandId: string): Task[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE demand_id = ? ORDER BY created_at ASC')
    .all(demandId) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/** Newest-first, de-duplicated, capped at 3 (docs/003 §2.3). */
export function addLastHolder(existing: readonly string[], userId: string): string[] {
  const next = [userId, ...existing.filter((candidate) => candidate !== userId)];
  return next.slice(0, 3);
}
