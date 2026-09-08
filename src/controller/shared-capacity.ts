import { createHash } from "node:crypto";
import { z } from "zod";
import { type LeaseStore, LeaseManager } from "../control/lease.js";
import { observeLeaseAssertion } from "../control/mutation-observation.js";
import {
  CapacityLedger,
  capacityReservationKey,
  type CapacityLimits,
  type CapacityReservation,
  type CapacityRejectionCode,
  type CapacitySnapshot,
} from "../scheduling/capacity-ledger.js";

export const SHARED_CAPACITY_REF = "refs/clockgrove-factory/coordination/capacity";
const PREFIX = "Factory-Shared-Capacity: ";
const RETIRED_ROOT = ".clockgrove-factory-capacity-retired";
const RETIRED_MARKER = Buffer.from("clockgrove.factory/shared-capacity-retired-v1\n", "utf8");
export const SHARED_CAPACITY_COMPACT_AT = 3072;
export const SHARED_CAPACITY_ACTION_REQUIRED_AT = 3840;
export const SHARED_CAPACITY_HARD_LIMIT = 4096;
const number = z.number().finite().nonnegative();
const ownerSchema = z
  .object({
    objective: z.number().int().positive(),
    runId: z.string().min(1).max(160),
    directorEpoch: z.number().int().nonnegative(),
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SharedCapacityOwner = z.infer<typeof ownerSchema>;
export interface SharedCapacityImport {
  owner: SharedCapacityOwner;
  reservation: CapacityReservation;
}
const reservationSchema = z
  .object({
    key: z.string(),
    objective: z.number().int().positive(),
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    phase: z.enum(["execution", "validation"]),
    backendId: z.string().min(1),
    admissionClass: z.enum(["local", "remote-required", "burst"]),
    local: z.boolean(),
    cpu: number,
    memoryMb: number,
    paidUnits: number,
    paths: z.array(z.string()).max(1024),
    exclusiveResources: z.array(z.string()).max(1024),
  })
  .strict();
const limitsSchema = z
  .object({
    maxParallel: number,
    maxLocalParallel: number,
    maxCloudParallel: number,
    backendMaxParallel: z.record(z.string(), number),
    cpuCapacity: number,
    memoryCapacityMb: number,
    maxPaidUnits: number,
  })
  .strict();
const claimSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    owner: ownerSchema,
    reservation: reservationSchema,
    released: z.boolean(),
  })
  .strict();
const stateV1Schema = z
  .object({
    protocol: z.literal("clockgrove.factory/shared-capacity-v1"),
    repository: z.string().min(3),
    generation: z.number().int().positive(),
    limits: limitsSchema,
    claims: z.array(claimSchema).max(SHARED_CAPACITY_HARD_LIMIT),
  })
  .strict();
const stateSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/shared-capacity-v2"),
    repository: z.string().min(3),
    generation: z.number().int().positive(),
    limits: limitsSchema,
    claims: z.array(claimSchema).max(SHARED_CAPACITY_HARD_LIMIT),
    retired: z
      .object({
        count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        markerOid: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (state) => (state.retired.count === 0) === (state.retired.markerOid === null),
    "shared capacity retired count and marker must agree",
  );
type State = z.infer<typeof stateSchema>;
type Claim = z.infer<typeof claimSchema>;
export type SharedCapacityResult =
  | { reserved: true; claimId: string }
  | { reserved: false; code: CapacityRejectionCode | "released-reservation" };
export interface SharedCapacityRetentionStatus {
  journalClaims: number;
  activeClaims: number;
  releasedClaims: number;
  retiredClaims: number;
  compactAt: number;
  actionRequiredAt: number;
  hardLimit: number;
  status: "healthy" | "compaction-due" | "action-required";
  action: string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function sharedCapacityClaimId(owner: SharedCapacityOwner, key: string): string {
  return createHash("sha256")
    .update(canonical({ owner: ownerSchema.parse(owner), key }))
    .digest("hex");
}
function reservationDigest(reservation: CapacityReservation): string {
  return createHash("sha256")
    .update(canonical(reservationSchema.parse(reservation)))
    .digest("hex");
}
function retiredDirectory(id: string): string {
  return `${RETIRED_ROOT}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)}/${id}`;
}
function globalLimits(input: CapacityLimits): State["limits"] {
  const finite = (value: number) =>
    value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : value;
  return limitsSchema.parse({
    maxParallel: finite(input.maxParallel),
    maxLocalParallel: finite(input.maxLocalParallel),
    maxCloudParallel: finite(input.maxCloudParallel),
    backendMaxParallel: Object.fromEntries(
      Object.entries(input.backendMaxParallel).map(([key, value]) => [key, finite(value)]),
    ),
    cpuCapacity: finite(input.cpuCapacity),
    memoryCapacityMb: finite(input.memoryCapacityMb),
    maxPaidUnits: finite(input.maxPaidUnits),
  });
}
function effectiveLimits(global: State["limits"], local: CapacityLimits): CapacityLimits {
  const requested = globalLimits(local);
  return {
    ...local,
    ...Object.fromEntries(
      Object.entries(global)
        .filter(([key]) => key !== "backendMaxParallel")
        .map(([key, value]) => [
          key,
          Math.min(value as number, requested[key as keyof typeof requested] as number),
        ]),
    ),
    backendMaxParallel: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(global.backendMaxParallel),
          ...Object.keys(requested.backendMaxParallel),
        ]),
      ].map((key) => [
        key,
        Math.min(
          global.backendMaxParallel[key] ?? global.maxParallel,
          requested.backendMaxParallel[key] ?? requested.maxParallel,
        ),
      ]),
    ),
  };
}
function ledger(state: State): CapacityLedger {
  const result = new CapacityLedger();
  const active = state.claims.filter((claim) => !claim.released);
  const keys = new Set<string>();
  for (const claim of active) {
    if (keys.has(claim.reservation.key))
      throw new Error("shared capacity has conflicting active run identities");
    keys.add(claim.reservation.key);
  }
  result.reconcile(
    state.generation,
    active.map((claim) => claim.reservation),
  );
  return result;
}

/** GitHub CAS serializes only reservation changes, never Objective execution or writes. */
export class SharedCapacityCoordinator {
  readonly #leases: LeaseManager;
  constructor(
    private readonly options: {
      store: LeaseStore & {
        withMutationFence?<T>(fence: () => Promise<void>, operation: () => Promise<T>): Promise<T>;
        createBlob(content: Buffer): Promise<string>;
        createTree(args: {
          baseTreeOid?: string;
          entries: Array<{
            path: string;
            mode: "100644" | "100755" | "120000";
            type: "blob";
            sha: string | null;
          }>;
        }): Promise<string>;
        readTreeDirectory(
          treeOid: string,
          path: string,
        ): Promise<Array<{ name: string; type: "blob" | "tree"; sha: string }> | null>;
      };
      repository: string;
      baseCommitSha: string;
      limits: CapacityLimits;
      /** Must prove legacy resources are absent/imported; expiry alone is not proof. */
      assertLegacyCompatible: () => Promise<void | readonly SharedCapacityImport[]>;
    },
  ) {
    this.#leases = new LeaseManager({ store: options.store });
  }

  async #read(): Promise<{ oid: string; treeOid: string; state: State } | null> {
    const oid = await this.options.store.readRef(SHARED_CAPACITY_REF);
    if (!oid) return null;
    const commit = await this.options.store.readCommit(oid);
    const encoded = commit.message
      .split("\n")
      .find((line) => line.startsWith(PREFIX))
      ?.slice(PREFIX.length);
    if (!encoded || encoded.length > 4 * 1024 * 1024)
      throw new Error("invalid shared capacity record");
    const raw: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const current = stateSchema.safeParse(raw);
    const state = current.success
      ? current.data
      : (() => {
          const legacy = stateV1Schema.parse(raw);
          return stateSchema.parse({
            ...legacy,
            protocol: "clockgrove.factory/shared-capacity-v2",
            retired: { count: 0, markerOid: null },
          });
        })();
    if (state.repository !== this.options.repository.toLowerCase())
      throw new Error("shared capacity repository mismatch");
    const ids = new Set<string>();
    for (const claim of state.claims) {
      if (
        claim.reservation.objective !== claim.owner.objective ||
        claim.reservation.key !== capacityReservationKey(claim.reservation) ||
        claim.id !== sharedCapacityClaimId(claim.owner, claim.reservation.key) ||
        ids.has(claim.id)
      )
        throw new Error("invalid shared capacity claim identity");
      ids.add(claim.id);
    }
    ledger(state);
    return { oid, treeOid: commit.treeOid, state };
  }

  async initialize(): Promise<void> {
    if (await this.#read()) return;
    const imported = await this.options.assertLegacyCompatible();
    const base = await this.options.store.readCommit(this.options.baseCommitSha);
    const state: State = {
      protocol: "clockgrove.factory/shared-capacity-v2",
      repository: this.options.repository.toLowerCase(),
      generation: 1,
      limits: globalLimits(this.options.limits),
      claims: (imported ?? []).map(({ owner, reservation }) => this.#claim(owner, reservation)),
      retired: { count: 0, markerOid: null },
    };
    ledger(state);
    const oid = await this.#commit(state, base.treeOid, base.oid);
    try {
      await this.options.store.createRef(SHARED_CAPACITY_REF, oid);
    } catch (error) {
      if (!(await this.#read())) throw error;
    }
    if (!(await this.#read())) throw new Error("shared capacity initialization was not observed");
  }

  async #commit(state: State, treeOid: string, parentOid: string): Promise<string> {
    const encoded = Buffer.from(JSON.stringify(stateSchema.parse(state))).toString("base64url");
    if (encoded.length > 4 * 1024 * 1024) throw new Error("shared capacity record exceeds bound");
    return this.options.store.createCommit({
      treeOid,
      parentOids: [parentOid],
      message: `Factory shared capacity\n\n${PREFIX}${encoded}`,
    });
  }

  async #assertOwner(owner: SharedCapacityOwner): Promise<void> {
    observeLeaseAssertion();
    ownerSchema.parse(owner);
    const lease = await this.#leases.read(owner.objective);
    if (
      !lease ||
      lease.runId !== owner.runId ||
      lease.epoch !== owner.directorEpoch ||
      lease.policyDigest !== owner.policyDigest ||
      lease.expiresAt <= (await this.options.store.serverTime())
    )
      throw new Error("shared capacity Objective ownership is not current");
  }

  async #change<T>(
    owner: SharedCapacityOwner,
    operation: (
      state: State,
      retiredDigest: (id: string) => Promise<string | null>,
    ) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean },
  ): Promise<T> {
    const captured = ownerSchema.parse(owner);
    if (this.options.store.withMutationFence)
      return this.options.store.withMutationFence(
        () => this.#assertOwner(captured),
        () => this.#changeFenced(captured, operation, true),
      );
    return this.#changeFenced(captured, operation, false);
  }

  async #changeFenced<T>(
    owner: SharedCapacityOwner,
    operation: (
      state: State,
      retiredDigest: (id: string) => Promise<string | null>,
    ) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean },
    transportFenced: boolean,
  ): Promise<T> {
    await this.initialize();
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = await this.#read();
      if (!current) throw new Error("shared capacity ref disappeared");
      await this.#assertOwner(owner);
      const next = structuredClone(current.state);
      const result = await operation(next, (id) => this.#retiredDigest(current, id));
      let treeOid = current.treeOid;
      let compacted = false;
      if (next.claims.length >= SHARED_CAPACITY_COMPACT_AT) {
        const compact = await this.#compactReleased(next, treeOid);
        treeOid = compact.treeOid;
        compacted = compact.removed > 0;
      }
      if (next.claims.length > SHARED_CAPACITY_HARD_LIMIT)
        throw new Error(
          `shared capacity journal has ${next.claims.length} active or unresolved claims; reconcile and explicitly release settled claims before the ${SHARED_CAPACITY_HARD_LIMIT}-record safety bound`,
        );
      if (!result.changed && !compacted) return result.value;
      next.generation++;
      ledger(next);
      const oid = await this.#commit(next, treeOid, current.oid);
      if (!transportFenced) await this.#assertOwner(owner);
      try {
        const compare = () =>
          this.options.store.compareAndSwapRef({
            ref: SHARED_CAPACITY_REF,
            beforeOid: current.oid,
            afterOid: oid,
          });
        const updated = await compare();
        if (updated) return result.value;
      } catch (error) {
        // Only reconcile an ambiguously accepted write; never replay uncertain work.
        const observed = await this.#read();
        if (observed?.oid === oid) return result.value;
        throw error;
      }
    }
    throw new Error("shared capacity contention; retry admission later");
  }

  async #retiredDigest(
    current: { treeOid: string; state: State },
    id: string,
  ): Promise<string | null> {
    if (current.state.retired.count === 0) return null;
    const entries = await this.options.store.readTreeDirectory(
      current.treeOid,
      retiredDirectory(id),
    );
    if (!entries) return null;
    if (
      entries.length !== 1 ||
      entries[0]?.type !== "blob" ||
      entries[0].sha !== current.state.retired.markerOid ||
      !/^[a-f0-9]{64}$/.test(entries[0].name)
    )
      throw new Error("invalid shared capacity retired identity evidence");
    return entries[0].name;
  }

  async #compactReleased(
    state: State,
    treeOid: string,
  ): Promise<{ treeOid: string; removed: number }> {
    const released = state.claims.filter((claim) => claim.released);
    if (released.length === 0) return { treeOid, removed: 0 };
    const markerOid =
      state.retired.markerOid ?? (await this.options.store.createBlob(RETIRED_MARKER));
    const compactedTree = await this.options.store.createTree({
      baseTreeOid: treeOid,
      entries: released.map((claim) => ({
        path: `${retiredDirectory(claim.id)}/${reservationDigest(claim.reservation)}`,
        mode: "100644" as const,
        type: "blob" as const,
        sha: markerOid,
      })),
    });
    state.claims = state.claims.filter((claim) => !claim.released);
    state.retired = {
      count: state.retired.count + released.length,
      markerOid,
    };
    return { treeOid: compactedTree, removed: released.length };
  }

  async snapshot(): Promise<CapacitySnapshot> {
    await this.initialize();
    const current = await this.#read();
    if (!current) throw new Error("shared capacity ref disappeared");
    return ledger(current.state).snapshot();
  }

  async retentionStatus(): Promise<SharedCapacityRetentionStatus> {
    await this.initialize();
    const current = await this.#read();
    if (!current) throw new Error("shared capacity ref disappeared");
    const activeClaims = current.state.claims.filter((claim) => !claim.released).length;
    const releasedClaims = current.state.claims.length - activeClaims;
    const status =
      activeClaims >= SHARED_CAPACITY_ACTION_REQUIRED_AT
        ? "action-required"
        : current.state.claims.length >= SHARED_CAPACITY_COMPACT_AT && releasedClaims > 0
          ? "compaction-due"
          : "healthy";
    return {
      journalClaims: current.state.claims.length,
      activeClaims,
      releasedClaims,
      retiredClaims: current.state.retired.count,
      compactAt: SHARED_CAPACITY_COMPACT_AT,
      actionRequiredAt: SHARED_CAPACITY_ACTION_REQUIRED_AT,
      hardLimit: SHARED_CAPACITY_HARD_LIMIT,
      status,
      action:
        status === "action-required"
          ? "Reconcile every retained liability and explicitly release settled claims; active or unresolved claims cannot be compacted."
          : status === "compaction-due"
            ? "Allow the next fenced capacity mutation to compact released identities."
            : null,
    };
  }

  /** Explicit controller configuration only; ordinary sessions cannot widen ceilings. */
  async configureLimits(
    limits: CapacityLimits,
    assertAuthority: () => Promise<void>,
    selected?: readonly ("maxLocalParallel" | "maxCloudParallel")[],
  ): Promise<void> {
    const complete = globalLimits(limits);
    const fields = selected ? [...selected] : undefined;
    const configure = async () => {
      await this.initialize();
      for (let attempt = 0; attempt < 16; attempt++) {
        const current = await this.#read();
        if (!current) throw new Error("shared capacity ref disappeared");
        await assertAuthority();
        const requested = fields ? { ...current.state.limits } : complete;
        if (fields) {
          for (const field of fields) requested[field] = complete[field];
          requested.maxParallel = requested.maxLocalParallel + requested.maxCloudParallel;
        }
        if (canonical(current.state.limits) === canonical(requested)) return;
        const next = {
          ...current.state,
          generation: current.state.generation + 1,
          limits: requested,
        };
        // Tightening never revokes or drops an existing resource obligation.
        const oid = await this.#commit(next, current.treeOid, current.oid);
        await assertAuthority();
        try {
          if (
            await this.options.store.compareAndSwapRef({
              ref: SHARED_CAPACITY_REF,
              beforeOid: current.oid,
              afterOid: oid,
            })
          )
            return;
        } catch (error) {
          if ((await this.#read())?.oid === oid) return;
          throw error;
        }
      }
      throw new Error("shared capacity policy contention; retry configuration later");
    };
    if (this.options.store.withMutationFence)
      await this.options.store.withMutationFence(assertAuthority, configure);
    else await configure();
  }

  #claim(owner: SharedCapacityOwner, reservation: CapacityReservation): Claim {
    const value = reservationSchema.parse(reservation);
    if (owner.objective !== value.objective || value.key !== capacityReservationKey(value))
      throw new Error("shared capacity reservation scope mismatch");
    return {
      id: sharedCapacityClaimId(owner, value.key),
      owner: ownerSchema.parse(owner),
      reservation: value,
      released: false,
    };
  }

  async reserve(
    owner: SharedCapacityOwner,
    reservation: CapacityReservation,
    limits: CapacityLimits,
  ): Promise<SharedCapacityResult> {
    const claim = this.#claim(owner, reservation);
    return this.#change<SharedCapacityResult>(owner, async (state, retiredDigest) => {
      const existing = state.claims.find((row) => row.id === claim.id);
      if (existing) {
        if (canonical(existing.reservation) !== canonical(claim.reservation))
          throw new Error("shared capacity identity changed resources");
        return {
          value: existing.released
            ? { reserved: false, code: "released-reservation" }
            : { reserved: true, claimId: claim.id },
          changed: false,
        };
      }
      const retired = await retiredDigest(claim.id);
      if (retired) {
        if (retired !== reservationDigest(claim.reservation))
          throw new Error("shared capacity identity changed resources");
        return {
          value: { reserved: false, code: "released-reservation" },
          changed: false,
        };
      }
      const current = ledger(state);
      const result = current.tryReserve(
        state.generation,
        claim.reservation,
        effectiveLimits(state.limits, limits),
      );
      if (!result.reserved) return { value: result, changed: false };
      state.claims.push(claim);
      return { value: { reserved: true, claimId: claim.id }, changed: true };
    });
  }

  /** Caller has independently proven exact cleanup/terminal accounting, not just expiry. */
  async release(owner: SharedCapacityOwner, key: string, originalOwner = owner): Promise<void> {
    if (originalOwner.objective !== owner.objective)
      throw new Error("capacity cleanup Objective mismatch");
    await this.#change(owner, (state) => {
      const claim = state.claims.find(
        (row) => row.id === sharedCapacityClaimId(originalOwner, key),
      );
      if (!claim || claim.released) return { value: undefined, changed: false };
      claim.released = true;
      return { value: undefined, changed: true };
    });
  }

  /** Reconstruct liabilities; absence from a snapshot NEVER frees an existing claim. */
  async reconcile(
    owner: SharedCapacityOwner,
    reservations: readonly CapacityReservation[],
    verifiedPredecessors: readonly SharedCapacityOwner[] = [],
  ): Promise<void> {
    if (verifiedPredecessors.some((prior) => prior.objective !== owner.objective))
      throw new Error("capacity adoption Objective mismatch");
    const claims = reservations.map((reservation) => this.#claim(owner, reservation));
    await this.#change(owner, async (state, retiredDigest) => {
      let changed = false;
      for (const claim of claims) {
        const prior = state.claims.find((row) => row.id === claim.id);
        if (prior) {
          if (canonical(prior.reservation) !== canonical(claim.reservation) || prior.released)
            throw new Error("reconstructed shared capacity conflicts with retained identity");
        } else {
          if (await retiredDigest(claim.id))
            throw new Error("reconstructed shared capacity conflicts with retained identity");
          const inherited = state.claims.find(
            (row) => !row.released && row.reservation.key === claim.reservation.key,
          );
          if (inherited) {
            const sameRun =
              inherited.owner.runId === owner.runId &&
              inherited.owner.policyDigest === owner.policyDigest &&
              inherited.owner.directorEpoch < owner.directorEpoch;
            const verified = verifiedPredecessors.some(
              (priorOwner) => canonical(priorOwner) === canonical(inherited.owner),
            );
            if (
              (!sameRun && !verified) ||
              canonical(inherited.reservation) !== canonical(claim.reservation)
            )
              throw new Error("capacity adoption requires exact verified predecessor");
            inherited.released = true;
          }
          state.claims.push(claim);
          changed = true;
        }
      }
      return { value: undefined, changed };
    });
  }

  async transition(
    owner: SharedCapacityOwner,
    fromKey: string,
    next: CapacityReservation,
    limits: CapacityLimits,
    fromOwner = owner,
  ): Promise<SharedCapacityResult> {
    if (fromOwner.objective !== owner.objective)
      throw new Error("capacity transition Objective mismatch");
    const claim = this.#claim(owner, next);
    return this.#change<SharedCapacityResult>(owner, async (state, retiredDigest) => {
      const priorId = sharedCapacityClaimId(fromOwner, fromKey);
      const prior = state.claims.find((row) => row.id === priorId);
      const existing = state.claims.find((row) => row.id === claim.id);
      const priorRetired = prior ? null : await retiredDigest(priorId);
      if (
        existing &&
        (prior?.released || priorRetired) &&
        !existing.released &&
        canonical(existing.reservation) === canonical(claim.reservation)
      )
        return { value: { reserved: true, claimId: claim.id }, changed: false };
      const existingRetired = existing ? null : await retiredDigest(claim.id);
      if (!prior || prior.released || existing || priorRetired || existingRetired)
        throw new Error("shared capacity transition identity mismatch");
      const current = ledger(state);
      const result = current.transition(
        state.generation,
        fromKey,
        claim.reservation,
        effectiveLimits(state.limits, limits),
      );
      if (!result.reserved) return { value: result, changed: false };
      prior.released = true;
      state.claims.push(claim);
      return { value: { reserved: true, claimId: claim.id }, changed: true };
    });
  }
}
