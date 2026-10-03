import { errorResponse } from '../../../../../server/responses.js';
import { getJobManager } from '../../../../../server/transcription-jobs.js';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const { text, name } = await getJobManager().result(id);
    return new Response(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="transcription.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
