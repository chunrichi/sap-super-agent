import type { FastifyRequest } from 'fastify';
import type { TokenKind } from '@sap-superagent/protocol';
import { verifyToken, type TokenClaims } from '../auth.js';
import { forbidden, unauthorized } from '../errors.js';
import type { ServerContext } from '../types.js';

/** Resolve and verify the `Authorization: Bearer <token>` header (docs/003 §4.1). */
export function authenticate(ctx: ServerContext, request: FastifyRequest): TokenClaims {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw unauthorized('missing Authorization: Bearer <token> header');
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) throw unauthorized('missing bearer token');
  try {
    return verifyToken(token, ctx.secret);
  } catch {
    throw unauthorized('invalid or expired token');
  }
}

export function requireKinds(
  ctx: ServerContext,
  request: FastifyRequest,
  kinds: readonly TokenKind[],
): TokenClaims {
  const claims = authenticate(ctx, request);
  if (!kinds.includes(claims.kind)) {
    throw forbidden(`token kind "${claims.kind}" cannot access this endpoint`);
  }
  return claims;
}

export function requireUserOrAdmin(
  ctx: ServerContext,
  request: FastifyRequest,
): TokenClaims {
  return requireKinds(ctx, request, ['user', 'admin']);
}

export function requireAdmin(ctx: ServerContext, request: FastifyRequest): TokenClaims {
  return requireKinds(ctx, request, ['admin']);
}

export interface ExecutorClaims extends TokenClaims {
  executorId: string;
}

export function requireExecutor(
  ctx: ServerContext,
  request: FastifyRequest,
): ExecutorClaims {
  const claims = requireKinds(ctx, request, ['executor']);
  if (claims.executorId === undefined) {
    throw unauthorized('executor token is missing its executorId');
  }
  return { ...claims, executorId: claims.executorId };
}
