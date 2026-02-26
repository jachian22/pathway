export interface CircuitBreakerEvent {
  sourceName: string;
  state: "open";
  failureCount: number;
}

export class TurnCircuitBreaker {
  private readonly threshold: number;
  private readonly failureCounts = new Map<string, number>();
  private readonly openSources = new Set<string>();
  private readonly events: CircuitBreakerEvent[] = [];

  constructor(threshold = 1) {
    this.threshold = threshold;
  }

  canRun(sourceName: string): boolean {
    return !this.openSources.has(sourceName);
  }

  markSuccess(sourceName: string): void {
    this.failureCounts.set(sourceName, 0);
  }

  markFailure(sourceName: string): void {
    const next = (this.failureCounts.get(sourceName) ?? 0) + 1;
    this.failureCounts.set(sourceName, next);
    if (next >= this.threshold && !this.openSources.has(sourceName)) {
      this.openSources.add(sourceName);
      this.events.push({
        sourceName,
        state: "open",
        failureCount: next,
      });
    }
  }

  getEvents(): CircuitBreakerEvent[] {
    return [...this.events];
  }
}
