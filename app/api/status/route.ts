import { serviceStatus } from '@/lib/server/service-status';
export async function GET(){return Response.json(await serviceStatus(),{headers:{'Cache-Control':'no-store'}});}
