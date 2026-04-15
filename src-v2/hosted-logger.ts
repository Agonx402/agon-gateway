import type { EventRecord } from "./types";

export function logEvent(event: EventRecord): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
