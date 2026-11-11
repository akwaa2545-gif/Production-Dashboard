import request from 'supertest';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('JSON request body encodings', () => {
  const json = Buffer.from(JSON.stringify({ sample: 'read-only test' }));

  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ])('rejects %s bodies before decompression or application routing', async (encoding, compress) => {
    const response = await request(createApp({ environment: {} }))
      .post('/__body_encoding_check__')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', encoding)
      .send(compress(json));
    expect(response.status).toBe(415);
  });

  it('continues routing ordinary uncompressed JSON', async () => {
    const response = await request(createApp({ environment: {} }))
      .post('/__body_encoding_check__')
      .send({ sample: 'read-only test' });
    expect(response.status).toBe(404);
  });

  it('keeps the existing eight-kilobyte JSON body limit', async () => {
    const response = await request(createApp({ environment: {} }))
      .post('/__body_encoding_check__')
      .send({ sample: 'x'.repeat(9 * 1024) });
    expect(response.status).toBe(413);
  });
});
