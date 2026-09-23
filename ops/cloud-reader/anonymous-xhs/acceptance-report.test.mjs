import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeAcceptance} from './acceptance-report.mjs';

const samples = [{sampleId: 'positive', expected: 'complete'}, {sampleId: 'negative', expected: 'platform_failure'}];
const positive = {sampleId: 'positive', status: 'complete', noteId: 'a'.repeat(24), mediaDelivered: true,
  textChars: 4, textSha256: 'b'.repeat(64), imageCount: 1, imageHashes: ['c'.repeat(64)]};
const report = () => ({finishedAt: '2026-09-23T00:00:00Z', unsignedRejected: true,
  executionEnvironment: {declared: 'ecs', platform: 'linux', uid: 1001, locationSource: 'operator-declared'},
  rows: [{...positive, round: 1}, {...positive, round: 2, comparison: {noteIdEqual: true, textEqual: true,
    imageCountEqual: true, imageBytesInOrderEqual: true}},
  {sampleId: 'negative', round: 1, status: 'failed', error: 'note_unavailable'}]});

test('cloud verification requires completed expectations and both positive rounds', () => {
  const good = report();
  assert.equal(summarizeAcceptance(good, samples).cloudVerified, true);
  assert.equal(summarizeAcceptance(good, samples).websiteEndToEndVerified, false);
  for (const bad of [
    {...good, rows: []}, {...good, finishedAt: undefined}, {...good, unsignedRejected: false},
    {...good, executionError: 'interrupted'}, {...good, rows: good.rows.slice(0, 1)},
    {...good, rows: good.rows.map(row => ({...row, status: 'failed', error: 'worker_failed'}))},
    {...good, rows: good.rows.map(row => row.round === 2 ? {...row, comparison: {...row.comparison, textEqual: false}} : row)},
    {...good, rows: good.rows.map(row => row.sampleId === 'negative' ? {...row, error: 'worker_failed'} : row)},
    {...good, rows: good.rows.map(row => row.round === 2 ? {...row, mediaDelivered: false} : row)},
  ]) assert.equal(summarizeAcceptance(bad, samples).cloudVerified, false);
  assert.equal(summarizeAcceptance(good, []).cloudVerified, false);
});

test('local or root execution never becomes verified ECS from a CLI label alone', () => {
  for (const change of [{declared: 'local-only'}, {platform: 'win32'}, {uid: 0}, {uid: null}]) {
    const value = report(); Object.assign(value.executionEnvironment, change);
    const summary = summarizeAcceptance(value, samples);
    assert.equal(summary.acceptancePassed, true);
    assert.equal(summary.cloudVerified, false);
  }
});
