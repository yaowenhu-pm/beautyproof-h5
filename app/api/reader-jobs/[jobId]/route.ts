import { anonymousReader } from '@/lib/server/anonymous-reader';
export async function GET(request: Request, context: {params: Promise<{jobId: string}>}) {
  return anonymousReader.poll(request, (await context.params).jobId);
}
