import { errorResponse, jsonResponse } from '../../../../../server/responses.js';
import { getJobManager } from '../../../../../server/transcription-jobs.js';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const { record, status } = getJobManager().cancel(id);
    return jsonResponse(record, status);
  } catch (error) {
    return errorResponse(error);
  }
}
