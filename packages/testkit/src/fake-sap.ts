import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// H2 placeholder: in-memory stand-in for the SAP ICF JSON API (docs/004 §3.2).
// Phase A of H2 replaces this with a fake ICF server wired into the server
// integration tests; H0 only needs the shape so the harness exists.
// ---------------------------------------------------------------------------

export interface FakeSapDemand {
  demandId: string;
  demandNo: string;
  title: string;
  description: string;
  status: import('@sap-superagent/protocol').DemandStatus;
  createdAt: string;
  changedAt: string;
}

export interface FakeSapEvent {
  eventId: string;
  type: 'demand.submitted' | 'demand.updated' | 'artifact.approved' | 'artifact.rejected';
  demandId: string;
  payload: unknown;
  state: 'NEW' | 'SENT' | 'DEAD';
}

export interface FakeSapResponse {
  status: number;
  body: unknown;
}

export class FakeSap {
  readonly demands = new Map<string, FakeSapDemand>();
  readonly events: FakeSapEvent[] = [];
  private sequence = 0;

  createDemand(input: { title: string; description: string; status?: FakeSapDemand['status'] }): FakeSapDemand {
    this.sequence += 1;
    const now = new Date().toISOString();
    const demand: FakeSapDemand = {
      demandId: randomUUID().replace(/-/g, ''),
      demandNo: `R-${String(2000 + this.sequence)}`,
      title: input.title,
      description: input.description,
      status: input.status ?? 'submitted',
      createdAt: now,
      changedAt: now,
    };
    this.demands.set(demand.demandId, demand);
    this.enqueue('demand.submitted', demand.demandId, demand);
    return demand;
  }

  enqueue(type: FakeSapEvent['type'], demandId: string, payload: unknown): FakeSapEvent {
    const event: FakeSapEvent = {
      eventId: randomUUID().replace(/-/g, ''),
      type,
      demandId,
      payload,
      state: 'NEW',
    };
    this.events.push(event);
    return event;
  }

  /** Minimal JSON route table matching docs/004 §3.2 / H2 §1.2. */
  handle(request: { method: string; path: string; body?: unknown }): FakeSapResponse {
    if (request.method === 'GET' && request.path === '/api/health') {
      return { status: 200, body: { status: 'ok', system: 'FAKE' } };
    }
    if (request.method === 'GET' && request.path === '/api/demands') {
      return { status: 200, body: { demands: [...this.demands.values()] } };
    }
    if (request.method === 'POST' && request.path === '/api/demands') {
      const body = (request.body ?? {}) as { title?: string; description?: string };
      const demand = this.createDemand({
        title: body.title ?? '未命名需求',
        description: body.description ?? '',
      });
      return { status: 200, body: { demand } };
    }
    return {
      status: 404,
      body: { error: { code: 'not_found', message: `unknown route ${request.method} ${request.path}` } },
    };
  }

  reset(): void {
    this.demands.clear();
    this.events.length = 0;
    this.sequence = 0;
  }
}
