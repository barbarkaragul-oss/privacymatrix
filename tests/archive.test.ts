import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveRawUrl, archiveViewUrl, captureDate, parseAvailability, parseCdx } from '../src/archive.js';

const URL_ = 'https://openai.com/policies/privacy-policy/';

test('archiveRawUrl puts id_ right after the timestamp, so the capture comes back unmodified', () => {
  assert.equal(archiveRawUrl('20260921065036', URL_), 'https://web.archive.org/web/20260921065036id_/https://openai.com/policies/privacy-policy/');
  assert.equal(archiveViewUrl('20260921065036', URL_), 'https://web.archive.org/web/20260921065036/https://openai.com/policies/privacy-policy/');
});

test('captureDate reads a 14-digit Wayback timestamp and rejects anything else', () => {
  assert.equal(captureDate('20260921065036'), '2026-09-21');
  assert.equal(captureDate('2026092106503'), null);
  assert.equal(captureDate('2026-09-21'), null);
  assert.equal(captureDate(''), null);
});

test('parseAvailability returns the closest 200 capture and nothing else', () => {
  const ok = { archived_snapshots: { closest: { available: true, url: 'http://web.archive.org/web/20260921065036/https://openai.com/policies/privacy-policy/', timestamp: '20260921065036', status: '200' } } };
  assert.deepEqual(parseAvailability(ok, URL_), { timestamp: '20260921065036', rawUrl: archiveRawUrl('20260921065036', URL_) });
  // what the API returns when it has nothing, or when a timestamp parameter hides recent captures
  assert.equal(parseAvailability({ archived_snapshots: {} }, URL_), null);
  assert.equal(parseAvailability({ ...ok, archived_snapshots: { closest: { ...ok.archived_snapshots.closest, status: '404' } } }, URL_), null);
  assert.equal(parseAvailability({ ...ok, archived_snapshots: { closest: { ...ok.archived_snapshots.closest, available: false } } }, URL_), null);
  assert.equal(parseAvailability({ ...ok, archived_snapshots: { closest: { ...ok.archived_snapshots.closest, timestamp: 'soon' } } }, URL_), null);
  assert.equal(parseAvailability(null, URL_), null);
  assert.equal(parseAvailability('not json', URL_), null);
});

test('parseCdx returns the newest 200 capture from a CDX answer, and null when there is none', () => {
  const header = ['timestamp', 'statuscode'];
  assert.deepEqual(parseCdx([header, ['20260921065036', '200']], URL_), { timestamp: '20260921065036', rawUrl: archiveRawUrl('20260921065036', URL_) });
  // limit=-1 gives one row; if several come back, the last is the newest
  assert.deepEqual(parseCdx([header, ['20260901000000', '200'], ['20260921065036', '200']], URL_)?.timestamp, '20260921065036');
  // a row that is not a 200, or has a broken timestamp, is passed over
  assert.deepEqual(parseCdx([header, ['20260921065036', '200'], ['20260924024611', '204']], URL_)?.timestamp, '20260921065036');
  assert.equal(parseCdx([header, ['soon', '200']], URL_), null);
  // what the CDX API returns when it has no capture
  assert.equal(parseCdx([], URL_), null);
  assert.equal(parseCdx([header], URL_), null);
  assert.equal(parseCdx(null, URL_), null);
  assert.equal(parseCdx({ archived_snapshots: {} }, URL_), null);
});
