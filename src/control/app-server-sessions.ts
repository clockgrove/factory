import { createHash } from "node:crypto";
import type { CompiledGraphStore } from "./graphs.js";
import type { AttemptReservation } from "./attempts.js";
import type { LeaseManager, LeaseState } from "./lease.js";
import { durableAttemptId } from "../execution/session.js";
import {
  canonicalSessionJson,
  parseAppServerSessionCheckpoint,
  type AppServerSessionCheckpoint,
  type AppServerSessionStage,
} from "../execution/app-server-session.js";
import { PlatformUnavailableError } from "../platform.js";

const PATH = ".clockgrove-factory/control/app-server-session.json";
const MAX_BYTES = 192 * 1024;
export function appServerSessionRef(
  repository: string,
  reservation: AttemptReservation,
  stage: AppServerSessionStage,
): string {
  return `refs/clockgrove-factory/sessions/${durableAttemptId({ repository, ...reservation })}/${stage}`;
}
function assertReservation(
  repository: string,
  reservation: AttemptReservation,
  checkpoint: AppServerSessionCheckpoint,
): void {
  const binding = checkpoint.binding;
  if (
    reservation.backend !== "codex-app-server/local-worktree" ||
    binding.repository !== repository.toLowerCase() ||
    binding.attemptId !== durableAttemptId({ repository, ...reservation }) ||
    binding.baseSha !== reservation.baseSha ||
    binding.policyDigest !== reservation.policyDigest ||
    canonicalSessionJson(binding.localScopeBatch) !==
      canonicalSessionJson(reservation.localScopeBatch)
  )
    throw new Error("durable session differs from its immutable reservation");
}

/** Provider state is local; its ownership and every dispatch/result boundary are GitHub records. */
export class AppServerSessionManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}
  async load(
    repository: string,
    reservation: AttemptReservation,
    stage: AppServerSessionStage,
  ): Promise<AppServerSessionCheckpoint | null> {
    const checkpoint = await this.readStage(repository, reservation, stage);
    if (!checkpoint || stage === "prepared") return checkpoint;
    const prepared = await this.readStage(repository, reservation, "prepared");
    if (
      !prepared ||
      canonicalSessionJson(prepared.binding) !== canonicalSessionJson(checkpoint.binding)
    )
      throw new Error("durable session checkpoint lacks its exact prepared thread");
    if (stage === "terminal") {
      const turn = await this.readStage(repository, reservation, "turn");
      if (
        !turn ||
        turn.turnId !== checkpoint.turnId ||
        canonicalSessionJson(turn.binding) !== canonicalSessionJson(checkpoint.binding)
      )
        throw new Error("durable terminal checkpoint lacks its exact dispatch");
    }
    return checkpoint;
  }
  private async readStage(
    repository: string,
    reservation: AttemptReservation,
    stage: AppServerSessionStage,
  ): Promise<AppServerSessionCheckpoint | null> {
    const ref = appServerSessionRef(repository, reservation, stage);
    const oid = await this.store.readRef(ref);
    if (!oid) return null;
    const commit = await this.store.readCommit(oid);
    if (
      commit.oid !== oid ||
      commit.parentOids.length !== 1 ||
      commit.parentOids[0] !== reservation.oid
    )
      throw new Error("durable session checkpoint does not descend from its exact reservation");
    const blob = await this.store.readTreeEntry(commit.treeOid, PATH);
    if (!blob) throw new Error("durable session checkpoint document is missing");
    const bytes = await this.store.readBlob(blob);
    if (
      bytes.length > MAX_BYTES ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob
    )
      throw new Error("durable session checkpoint blob is invalid");
    const checkpoint = parseAppServerSessionCheckpoint(JSON.parse(bytes.toString("utf8")));
    if (checkpoint.stage !== stage) throw new Error("durable session checkpoint stage changed");
    assertReservation(repository, reservation, checkpoint);
    return checkpoint;
  }
  async persist(args: {
    repository: string;
    reservation: AttemptReservation;
    lease: LeaseState;
    checkpoint: AppServerSessionCheckpoint;
  }): Promise<void> {
    const checkpoint = parseAppServerSessionCheckpoint(args.checkpoint);
    assertReservation(args.repository, args.reservation, checkpoint);
    await this.leases.assertMutationAuthorized(args.lease);
    if (
      args.lease.objective !== args.reservation.objective ||
      args.lease.runId !== args.reservation.runId ||
      args.lease.policyDigest !== args.reservation.policyDigest ||
      args.lease.epoch < args.reservation.directorEpoch
    )
      throw new Error("durable session write is fenced from current run ownership");
    const bytes = Buffer.from(canonicalSessionJson(checkpoint));
    if (bytes.length > MAX_BYTES)
      throw new Error("durable session checkpoint exceeds its byte bound");
    const existing = await this.load(args.repository, args.reservation, checkpoint.stage);
    if (existing) {
      if (canonicalSessionJson(existing) !== bytes.toString())
        throw new Error("durable session already has a conflicting immutable checkpoint");
      return;
    }
    if (checkpoint.stage !== "prepared") {
      const prepared = await this.load(args.repository, args.reservation, "prepared");
      if (
        !prepared ||
        canonicalSessionJson(prepared.binding) !== canonicalSessionJson(checkpoint.binding)
      )
        throw new Error("durable session completion has no matching prepared thread");
      if (checkpoint.stage === "terminal") {
        const turn = await this.load(args.repository, args.reservation, "turn");
        if (
          !turn ||
          turn.turnId !== checkpoint.turnId ||
          canonicalSessionJson(turn.binding) !== canonicalSessionJson(checkpoint.binding)
        )
          throw new Error("durable terminal session has no exact immutable turn receipt");
      }
    }
    const blob = await this.store.createBlob(bytes);
    await this.leases.assertMutationAuthorized(args.lease);
    const treeOid = await this.store.createTree({
      entries: [{ path: PATH, mode: "100644", type: "blob", sha: blob }],
    });
    await this.leases.assertMutationAuthorized(args.lease);
    const commit = await this.store.createCommit({
      treeOid,
      parentOids: [args.reservation.oid],
      message: `Factory App Server ${checkpoint.stage}\n\nFactory-Session-Digest: ${createHash("sha256").update(bytes).digest("hex")}`,
    });
    await this.leases.assertMutationAuthorized(args.lease);
    try {
      if (
        await this.store.createRef(
          appServerSessionRef(args.repository, args.reservation, checkpoint.stage),
          commit,
        )
      )
        return;
    } catch (error) {
      if (error instanceof PlatformUnavailableError) throw error;
      const repaired = await this.load(args.repository, args.reservation, checkpoint.stage);
      if (repaired && canonicalSessionJson(repaired) === bytes.toString()) return;
      throw error;
    }
    const winner = await this.load(args.repository, args.reservation, checkpoint.stage);
    if (!winner || canonicalSessionJson(winner) !== bytes.toString())
      throw new Error("durable session checkpoint creation conflicted");
  }
}
