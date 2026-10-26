import { Injectable, Logger } from '@nestjs/common';
import type { ActorType, Prisma } from '@ssrs/database';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';

export interface AuditEvent {
  /** Dotted action name, e.g. `auth.login.success`. */
  action: string;
  actorUserId?: string | null;
  actorType?: ActorType;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  context?: RequestMeta;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|private.?key|hash|cookie|authorization|credential/i;
const MAX_DEPTH = 4;
const MAX_STRING = 500;

/** Removes secrets and bounds size before metadata reaches the audit table. */
export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubMetadata(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrubMetadata(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an audit entry. Pass `tx` to make the entry part of a business transaction;
   * otherwise failures are logged and swallowed so auditing never blocks the user action.
   */
  async record(event: AuditEvent, tx?: AuditWriter): Promise<void> {
    const data = {
      action: event.action,
      actorUserId: event.actorUserId ?? null,
      actorType: event.actorType ?? (event.actorUserId ? 'USER' : 'SYSTEM'),
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      metadata: (scrubMetadata(event.metadata ?? {}) ?? {}) as Prisma.InputJsonValue,
      ip: event.context?.ip ?? null,
      userAgent: event.context?.userAgent ?? null,
      requestId: event.context?.requestId ?? null,
    } satisfies Prisma.AuditLogUncheckedCreateInput;

    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.client.auditLog.create({ data });
    } catch (err) {
      this.logger.error(
        `Failed to write audit event ${event.action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
