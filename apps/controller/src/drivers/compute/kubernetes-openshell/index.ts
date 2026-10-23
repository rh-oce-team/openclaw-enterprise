import {
  requireConfiguration,
  type ComputeAgentBinding,
  type ErrorDetail,
} from "@openclaw-enterprise/contracts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../kubernetes/index.ts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { currentComputeAbortSignal } from "../operation-context.ts";
import { ManagedOpenShellSandbox } from "./managed-sandbox.ts";

export interface KubernetesOpenShellComputeOptions extends KubernetesComputeDriverOptions {
  readonly managedOpenShell: {
    /** Explicit opt-in until generation-fenced lifecycle operations exist upstream. */
    readonly experimentalSingleWorker: true;
    readonly gatewayId: string;
  };
}

/** Stable OpenShell workloads with Kubernetes-owned Agent Gateways. */
export class KubernetesOpenShellComputeDriver extends KubernetesComputeDriver {
  static override readonly configurationSchema = Object.freeze({
    ...KubernetesComputeDriver.configurationSchema,
    required: [...KubernetesComputeDriver.configurationSchema.required, "managedOpenShell"],
    properties: {
      ...KubernetesComputeDriver.configurationSchema.properties,
      managedOpenShell: {
        type: "object",
        additionalProperties: false,
        required: ["experimentalSingleWorker", "gatewayId"],
        properties: {
          experimentalSingleWorker: { const: true },
          gatewayId: {
            type: "string",
            minLength: 1,
            maxLength: 63,
            pattern: "^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$",
          },
        },
      },
    },
  });

  static override validateConfiguration(
    configuration: Readonly<KubernetesComputeDriverOptions>,
  ): readonly ErrorDetail[] {
    const errors = [...KubernetesComputeDriver.validateConfiguration(configuration)];
    if (
      configuration.executionCluster !== undefined ||
      configuration.servicePrincipalCredentials.mode !== "disabled" ||
      configuration.runtime === undefined
    ) {
      errors.push({
        path: "",
        code: "INVALID_VALUE",
        message:
          "Managed OpenShell requires one Gateway cluster, a configured runtime, and disabled ServicePrincipal projection.",
      });
    }
    return errors;
  }

  private readonly managedSandbox: ManagedOpenShellSandbox;

  constructor(
    options: KubernetesOpenShellComputeOptions,
    selection: NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]> & {
      readonly sandboxDriver: ManagedOpenShellSandbox;
    },
  ) {
    requireConfiguration(KubernetesOpenShellComputeDriver, options);
    const { managedOpenShell: _managedOpenShell, ...kubernetes } = options;
    super(kubernetes, { ...selection, implementation: "occ/kubernetes-openshell" });
    this.managedSandbox = selection.sandboxDriver;
  }

  override validateHarnessAuth(
    ...args: Parameters<KubernetesComputeDriver["validateHarnessAuth"]>
  ): void {
    if (args[0].mode !== "dedicated") {
      throw new ConfigurationHarnessError(
        "Kubernetes + OpenShell Compute requires a dedicated Harness.",
      );
    }
    super.validateHarnessAuth(...args);
  }

  override async deleteAgentRuntimeCredentials(binding: ComputeAgentBinding): Promise<void> {
    const owner = currentComputeAbortSignal();
    const timeout = AbortSignal.timeout(300_000);
    await this.managedSandbox.deleteAgent(
      { ...binding, namespace: await this.resolveSandboxNamespace(binding.namespace) },
      owner === undefined ? timeout : AbortSignal.any([owner, timeout]),
    );
    await super.deleteAgentRuntimeCredentials(binding);
  }
}

export { ManagedOpenShellSandbox } from "./managed-sandbox.ts";
