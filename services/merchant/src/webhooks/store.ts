import type { Prisma, PrismaClient } from "@handshake/db";

export interface StoredWebhookEvent {
  eventId: string;
  type: string;
  payload: unknown;
}

export interface WebhookEventStore<Tx = unknown> {
  /**
   * Records the event and runs `apply` in one transaction. Returns "duplicate"
   * (without running `apply`) if the event id was already recorded. If `apply`
   * throws, nothing is recorded and the error propagates, so PayPal's
   * redelivery is processed as new.
   */
  record(event: StoredWebhookEvent, apply: (tx: Tx) => Promise<void>): Promise<"new" | "duplicate">;
}

// Dedupe rides on the paypal_events primary key via ON CONFLICT DO NOTHING: a
// concurrent second delivery blocks on the index until the first commits, then
// inserts nothing. Only that zero-row insert means "duplicate"; a unique
// violation raised inside `apply` propagates as a failure, not a duplicate.
// Neon over the pooler can take >2 s (Prisma's default) to hand out a connection on a cold start.
const TX = { maxWait: 10_000, timeout: 15_000 };

export function prismaWebhookStore(db: PrismaClient): WebhookEventStore<Prisma.TransactionClient> {
  return {
    async record({ eventId, type, payload }, apply) {
      return db.$transaction(async (tx) => {
        const { count } = await tx.paypalEvent.createMany({
          data: [{ eventId, type, payloadJson: payload as Prisma.InputJsonValue }],
          skipDuplicates: true,
        });
        if (count === 0) return "duplicate";
        await apply(tx);
        return "new";
      }, TX);
    },
  };
}

/** In-memory store for tests only: concurrent deliveries are not isolated. server.ts must not use it. */
export function memoryWebhookStore(): WebhookEventStore<undefined> & { events: StoredWebhookEvent[] } {
  const events: StoredWebhookEvent[] = [];
  return {
    events,
    async record(event, apply) {
      if (events.some((e) => e.eventId === event.eventId)) return "duplicate";
      await apply(undefined);
      events.push(event);
      return "new";
    },
  };
}
