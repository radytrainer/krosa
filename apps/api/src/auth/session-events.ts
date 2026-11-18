import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../config/env.js';

/** Same value as SESSION_ENDED_CHANNEL in session.service.ts (kept here to avoid a cycle). */
const CHANNEL = 'ssrs:v1:auth:session-ended';

export type SessionEndedListener = (reason: string) => void;

/**
 * One dedicated Redis subscriber per API process for `ssrs:v1:auth:session-ended`, and the map
 * sessionId → open live streams on this process. A message only reaches the streams of the
 * session it names: the filter is the session id taken from each stream's own access token.
 */
@Injectable()
export class SessionEvents implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionEvents.name);
  private readonly listeners = new Map<string, Set<SessionEndedListener>>();
  private readonly closers = new Set<() => void>();
  private subscriber: Redis | null = null;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  onModuleInit(): void {
    const sub = new Redis(this.env.REDIS_URL, {
      connectionName: 'ssrs-api-session-events',
      // Reconnects and re-subscribes on its own; the live backstop covers the gap.
      maxRetriesPerRequest: null,
    });
    sub.on('error', (err: Error) => this.logger.warn(`Redis subscriber error: ${err.message}`));
    sub.on('message', (channel: string, message: string) => {
      if (channel !== CHANNEL) return;
      try {
        const parsed = JSON.parse(message) as { sessionId?: unknown; reason?: unknown };
        if (typeof parsed.sessionId === 'string' && typeof parsed.reason === 'string') {
          this.dispatchLocal(parsed.sessionId, parsed.reason);
        }
      } catch {
        // Ignore malformed messages.
      }
    });
    sub.subscribe(CHANNEL).catch((err: unknown) => {
      this.logger.warn(
        `Could not subscribe to session events: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.subscriber = sub;
  }

  /** Registers a stream of `sessionId`; returns the function that unregisters it. */
  listen(sessionId: string, listener: SessionEndedListener, close: () => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    this.closers.add(close);
    return () => {
      this.closers.delete(close);
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** Ends this process's streams of a session (also called directly when Redis is down). */
  dispatchLocal(sessionId: string, reason: string): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        listener(reason);
      } catch (err) {
        this.logger.warn(
          `Live listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Open streams on this process (tests and diagnostics). */
  openStreams(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  async onModuleDestroy(): Promise<void> {
    // Close streams without `ended`: clients reconnect to another start of the API.
    for (const close of Array.from(this.closers)) close();
    this.closers.clear();
    this.listeners.clear();
    const sub = this.subscriber;
    this.subscriber = null;
    if (sub) await sub.quit().catch(() => sub.disconnect());
  }
}
