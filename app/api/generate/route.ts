import { generateCandidate } from "../../../lib/providers";
import { jsonResponse, readRequestJson, requestErrorResponse, validateBrief, validateConnection } from "../../../lib/request-validation";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readRequestJson(request);
    const brief = validateBrief(body.brief);
    const connection = validateConnection(body.connection);
    return jsonResponse(await generateCandidate(brief, connection));
  } catch (error) { return requestErrorResponse(error); }
}
