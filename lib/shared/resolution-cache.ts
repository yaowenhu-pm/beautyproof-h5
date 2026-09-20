type CacheableResolution = {
  resolved?: boolean; reasonCode?: string; contentStatus?: string;
  extraction?: { textStatus?: string; pageText?: string };
};

// A readable title or media address is not a completed content read.
export function hasFullBody(result: CacheableResolution) {
  return result.resolved === true && result.reasonCode === 'ok' && result.contentStatus === 'body'
    && result.extraction?.textStatus === 'full' && Boolean(result.extraction.pageText?.trim());
}
export const resolutionCacheTtl = (result: CacheableResolution) => hasFullBody(result) ? 300_000 : 10_000;
