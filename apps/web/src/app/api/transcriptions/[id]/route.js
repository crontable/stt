import { errorResponse, jsonResponse } from '../../../../server/responses.js';
import { getJobManager } from '../../../../server/transcription-jobs.js';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    return jsonResponse(getJobManager().get(id));
  } catch (error) {
    return errorResponse(error);
  }
}
