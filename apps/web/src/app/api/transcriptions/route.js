import { after } from 'next/server';

import { errorResponse, jsonResponse } from '../../../server/responses.js';
import { getJobManager } from '../../../server/transcription-jobs.js';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const manager = getJobManager();
    const record = await manager.accept(request, (complete) => after(complete));
    return jsonResponse(record, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
