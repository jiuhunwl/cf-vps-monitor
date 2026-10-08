export interface PendingIngressLimits {
  perClientMessages: number;
  perClientBytes: number;
  globalMessages: number;
  globalBytes: number;
}

// Account for retained wire payloads, not exact JavaScript heap consumption.
const DEFAULT_LIMITS: PendingIngressLimits = {
  perClientMessages: 2,
  perClientBytes: 1024 * 1024,
  globalMessages: 32,
  globalBytes: 4 * 1024 * 1024,
};

type ClientUsage = { messages: number; bytes: number };
export interface PendingIngressLease { release(): void }

/** Synchronous admission; never creates an unbounded semaphore waiter queue. */
export class PendingIngressBudget {
  private limits: PendingIngressLimits;
  private clients = new Map<string, ClientUsage>();
  private messages = 0;
  private bytes = 0;

  constructor(limits: Partial<PendingIngressLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid pending ingress limit');
    }
  }

  tryReserve(clientId: string, bytes: number): PendingIngressLease | null {
    if (!clientId || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    const current = this.clients.get(clientId) || { messages: 0, bytes: 0 };
    if (current.messages >= this.limits.perClientMessages
      || bytes > this.limits.perClientBytes - current.bytes
      || this.messages >= this.limits.globalMessages
      || bytes > this.limits.globalBytes - this.bytes) return null;

    current.messages++;
    current.bytes += bytes;
    this.messages++;
    this.bytes += bytes;
    this.clients.set(clientId, current);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      current.messages--;
      current.bytes -= bytes;
      this.messages--;
      this.bytes -= bytes;
      if (current.messages === 0) this.clients.delete(clientId);
    } };
  }

  snapshot(): { messages: number; bytes: number; clients: number } {
    return { messages: this.messages, bytes: this.bytes, clients: this.clients.size };
  }
}
