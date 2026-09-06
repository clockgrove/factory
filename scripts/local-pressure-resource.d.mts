import type {
  SchedulingPort,
  ServiceIdentity,
  ServiceObservation,
} from "./verify-local-scheduling.mjs";
export interface PressurePort extends SchedulingPort {
  children(path: string): string[];
  inode(path: string): string | null;
}
export const MB: number;
export const PRESSURE_BOUNDS: Readonly<{
  sliceBytes: number;
  allocationBytes: number;
  pressureBytes: number;
  minimumHostFreeBytes: number;
  baselineMaximumBytes: number;
  emergencyHeadroomBytes: number;
  pressureCpu: number;
  durationSeconds: number;
}>;
export const pressurePort: PressurePort;
export function pressureSlice(unit: string): string;
export function pressureProperties(
  unit: string,
  names: string[],
  port?: PressurePort,
): Record<string, string>;
export function pressureMemory(
  cgroup: string,
  port?: PressurePort,
): {
  cgroup: string;
  inode: string | null;
  memoryMax: number | null;
  memoryCurrent: number;
  swapMax: number | null;
  cpu: number | null;
  cpuRaw: string;
  cpuUsageUsec: number;
  events: Record<string, number>;
  observedAt: string;
};
export function pressureInputs(primary: unknown, port?: PressurePort): Record<string, unknown>;
export function observePressureSlice(
  expected: unknown,
  allowed: string[],
  port?: PressurePort,
  capped?: boolean,
): Record<string, unknown>;
export function assertPressureHeadroom(
  slice: unknown,
  port?: PressurePort,
): Record<string, unknown>;
export function pressureLaunch(identity: ServiceIdentity, slice: string): string[];
export function observePressureResource(
  expected: unknown,
  slice: unknown,
  port?: PressurePort,
): ServiceObservation;
export function observePressureDirector(expected: unknown, port?: PressurePort): ServiceObservation;
export function stopPressureResource(
  expected: unknown,
  slice: unknown,
  port?: PressurePort,
): Promise<ServiceObservation>;
export function pressureSliceOverrides(
  slice: unknown,
  uid: number,
  port?: PressurePort,
): { path: string; digest: string }[];
