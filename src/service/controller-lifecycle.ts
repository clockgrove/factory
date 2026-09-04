import type {
  ControllerInput,
  ControllerLifecycle,
} from "../application/services.js";
import {
  SystemdUserService,
  type SystemdStatus,
} from "./systemd-user-service.js";

export interface ControllerLifecycleResult extends SystemdStatus {
  operation: "start" | "stop" | "restart" | "status" | "install" | "uninstall";
  repository: string;
  checkout: string;
  requestId: string;
  accepted: true;
}

/** Real Linux/WSL lifecycle adapter shared by CLI and MCP transports. */
export class SystemdControllerLifecycle implements ControllerLifecycle {
  constructor(private readonly systemd: SystemdUserService) {}

  start(input: ControllerInput): Promise<ControllerLifecycleResult> {
    return this.#perform("start", input);
  }

  stop(input: ControllerInput): Promise<ControllerLifecycleResult> {
    return this.#perform("stop", input);
  }

  restart(input: ControllerInput): Promise<ControllerLifecycleResult> {
    return this.#perform("restart", input);
  }

  status(input: ControllerInput): Promise<ControllerLifecycleResult> {
    return this.#perform("status", input);
  }

  install(input: ControllerInput): Promise<ControllerLifecycleResult> {
    return this.#perform("install", input);
  }

  uninstall(input: ControllerInput): Promise<ControllerLifecycleResult> {
    return this.#perform("uninstall", input);
  }

  async #perform(
    operation: ControllerLifecycleResult["operation"],
    input: ControllerInput,
  ): Promise<ControllerLifecycleResult> {
    const status = await this.systemd[operation](input);
    return { operation, ...input, ...status, accepted: true };
  }
}
