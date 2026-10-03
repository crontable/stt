import { createJobEventStream } from '../../../../../server/event-stream.js';
import { errorResponse } from '../../../../../server/responses.js';
import { getJobManager } from '../../../../../server/transcription-jobs.js';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const body = createJobEventStream({
      manager: getJobManager(),
      id,
      lastEventId: request.headers.get('last-event-id'),
      signal: request.signal,
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
