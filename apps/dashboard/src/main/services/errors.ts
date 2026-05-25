import type { ServiceId } from "@mapos/contracts";

export class ServiceUnavailableError extends Error {
  readonly serviceId: ServiceId;

  constructor(serviceId: ServiceId, reason: string) {
    super(`Service "${serviceId}" unavailable: ${reason}`);
    this.name = "ServiceUnavailableError";
    this.serviceId = serviceId;
  }
}
