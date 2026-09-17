import type { BackendRegistry } from "../execution/registry.js";
import type { ManagementBackend } from "../management/backend.js";
import { destinationAllowedByPolicy, type RunPolicy } from "../protocol/policy.js";
import { TOOLCHAIN_AUTHORITY_ADAPTERS } from "../toolchains/authority.js";

export function repositoryCapturePlanningCapabilities(args: {
  registry: BackendRegistry;
  policy: RunPolicy;
  management: ManagementBackend;
}) {
  const selected = args.policy.backendOrder
    .map((id) => args.registry.get(id))
    .filter((backend) => backend !== null);
  const localManagedRuntimeSupported = selected.some(
    (backend) =>
      backend.capabilities.hostExecution &&
      !backend.capabilities.requiresPaidRuntime &&
      backend.capabilities.supportsManagedToolchainExecution === true,
  );
  const localManagedRuntimeAdapterIds = localManagedRuntimeSupported
    ? TOOLCHAIN_AUTHORITY_ADAPTERS.filter(
        (adapter) =>
          adapter.provisioning === "factory-provisioned" &&
          adapter.runtimeRequirement !== undefined,
      )
        .map(({ id }) => id)
        .sort()
    : [];
  // Isolated execution is independent from expected-byte egress. Capture
  // commands never receive the immutable expected payload; Factory applies
  // exact and threshold comparison after repository-controlled code exits.
  const isolatedBackendIds = selected
    .filter(
      (backend) =>
        backend.validate !== undefined &&
        backend.probeValidation !== undefined &&
        backend.validationEnvironmentIdentity !== undefined &&
        backend.validationEnvironmentIdentity() !== null &&
        ["container", "microvm", "managed"].includes(backend.capabilities.isolation) &&
        (!backend.capabilities.requiresPaidRuntime ||
          args.policy.allowedPaidBackends.includes(backend.capabilities.id)),
    )
    .map(({ capabilities }) => capabilities.id)
    .sort();
  const candidate = args.management.repositoryCaptureReviewerCapability ?? null;
  const reviewerCapability =
    candidate &&
    args.policy.repositoryCaptureEgress.review.mode !== "denied" &&
    args.policy.repositoryCaptureEgress.review.reviewerCapabilityIds.includes(candidate.id) &&
    candidate.networkDestinations.every((destination) =>
      destinationAllowedByPolicy(destination, args.policy.allowedNetworkDestinations),
    )
      ? candidate
      : null;
  return {
    execution: { localManagedRuntimeAdapterIds, isolatedBackendIds },
    reviewerCapability,
  };
}
