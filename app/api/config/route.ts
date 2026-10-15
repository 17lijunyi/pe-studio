import { configuredProviders } from "../../../lib/providers";
import { jsonResponse } from "../../../lib/request-validation";

export function GET(): Response {
  return jsonResponse({ configured: configuredProviders() });
}
