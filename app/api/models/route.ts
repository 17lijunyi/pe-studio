import { listProviderModels } from "../../../lib/providers";
import { jsonResponse, readRequestJson, requestErrorResponse, validateModelCatalogConnection } from "../../../lib/request-validation";

/** Local POST keeps credentials out of URLs; the provider receives GET /models. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readRequestJson(request);
    const connection = validateModelCatalogConnection(body.connection);
    const result = await listProviderModels(connection);
    return jsonResponse(result, result.ok ? 200 : 502);
  } catch (error) {
    const response = requestErrorResponse(error);
    const payload = await response.json() as { error: string };
    return jsonResponse({ ok: false, error: payload.error }, response.status);
  }
}
