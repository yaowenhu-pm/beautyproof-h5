// Passing this suite verifies only the reader on the executing host. It does
// not exercise the public website, its queue, TLS endpoint or outbound bridge.
export function summarizeAcceptance(report, samples) {
  const rows = report.rows;
  const comparisons = ['noteIdEqual', 'textEqual', 'imageCountEqual', 'imageBytesInOrderEqual'];
  const complete = row => row?.status === 'complete' && row.mediaDelivered === true
    && row.textChars > 0 && /^[a-f\d]{64}$/.test(row.textSha256 || '')
    && /^[a-f\d]{24}$/.test(row.noteId || '') && row.imageCount > 0
    && row.imageHashes?.length === row.imageCount
    && row.imageHashes.every(hash => /^[a-f\d]{64}$/.test(hash));
  const positives = samples.filter(sample => sample.expected === 'complete');
  const expectedRows = samples.reduce((count, sample) => count + (sample.expected === 'complete' ? 2 : 1), 0);
  const manifestValid = samples.length > 0 && positives.length > 0
    && new Set(samples.map(sample => sample.sampleId)).size === samples.length
    && samples.every(sample => ['complete', 'platform_failure'].includes(sample.expected));
  const passed = Boolean(report.finishedAt && !report.executionError && report.unsignedRejected === true
    && manifestValid && rows.length === expectedRows && samples.every(sample => {
      const matched = rows.filter(row => row.sampleId === sample.sampleId);
      if (sample.expected === 'platform_failure') return matched.length === 1
        && matched[0].round === 1 && matched[0].status === 'failed'
        && ['unavailable_or_login', 'note_unavailable'].includes(matched[0].error);
      const first = matched.find(row => row.round === 1), second = matched.find(row => row.round === 2);
      return matched.length === 2 && complete(first) && complete(second)
        && (!sample.noteId || first.noteId === sample.noteId)
        && comparisons.every(key => second.comparison?.[key] === true);
    }));
  const host = report.executionEnvironment;
  return {
    counts: {attempts: rows.length, complete: rows.filter(row => row.status === 'complete').length,
      failed: rows.filter(row => row.status === 'failed').length,
      incomplete: rows.filter(row => !['complete', 'failed'].includes(row.status)).length},
    acceptancePassed: passed,
    // Host location is declared by the operator, never inferred from --out.
    // Keep its declared provenance explicit in executionEnvironment.
    cloudVerified: passed && host?.declared === 'ecs' && host.platform === 'linux'
      && Number.isInteger(host.uid) && host.uid > 0,
    websiteEndToEndVerified: false,
  };
}
