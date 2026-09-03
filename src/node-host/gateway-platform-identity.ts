import { resolveMachineModelIdentifier } from "../infra/machine-model.js";
import {
  resolveGatewayClientDeviceFamily,
  resolveGatewayClientPlatform,
} from "../shared/gateway-client-platform.js";

export function resolveNodeHostGatewayPlatformIdentity(
  platform: NodeJS.Platform,
  resolveModel = resolveMachineModelIdentifier,
): {
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
} {
  const modelIdentifier = resolveModel(platform);
  const deviceFamily = resolveGatewayClientDeviceFamily(platform);
  const identity = {
    platform: resolveGatewayClientPlatform(platform),
  };
  return deviceFamily ? { ...identity, deviceFamily, modelIdentifier } : identity;
}
