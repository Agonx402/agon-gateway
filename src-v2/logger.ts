import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EventRecord } from "./types.js";

export class EventLogger {
  private readonly eventLogPath: string;

  public constructor(eventLogPath: string) {
    this.eventLogPath = resolve(process.cwd(), eventLogPath);
    mkdirSync(dirname(this.eventLogPath), { recursive: true });
  }

  public log(event: EventRecord): void {
    const line = JSON.stringify(event);
    process.stdout.write(`${line}\n`);
    appendFileSync(this.eventLogPath, `${line}\n`, { encoding: "utf8" });
  }
}