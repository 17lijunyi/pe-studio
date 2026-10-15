import { judgeCandidates } from "../../../lib/judge";
import { jsonResponse, readRequestJson, requestErrorResponse, validateBrief, validateCandidates, validateJudgeConnection } from "../../../lib/request-validation";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readRequestJson(request);
    const brief = validateBrief(body.brief);
    const candidates = validateCandidates(body.candidates);
    const connection = validateJudgeConnection(body.connection);
    return jsonResponse(await judgeCandidates(brief, candidates, connection));
  } catch (error) { return requestErrorResponse(error); }
}
