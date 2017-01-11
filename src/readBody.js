/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */
import httpError from 'http-errors';
import zlib from 'zlib';
import getBody from 'raw-body';
import type { Request } from './index';

// Return a decompressed stream, given an encoding.
function decompressed(req, encoding) {
  switch (encoding) {
    case 'identity': return req;
    case 'deflate': return req.pipe(zlib.createInflate());
    case 'gzip': return req.pipe(zlib.createGunzip());
  }
  throw httpError(415, `Unsupported content-encoding "${encoding}".`);
}

// Read and parse a request body.
export default function (req: Request, charset: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Assert charset encoding per JSON RFC 7159 sec 8.1
    if (charset.slice(0, 4) !== 'utf-') {
      throw httpError(415, `Unsupported charset "${charset.toUpperCase()}".`);
    }

    // Get content-encoding (e.g. gzip)
    const contentEncoding = req.headers['content-encoding'];
    const encoding = typeof contentEncoding === 'string' ?
      contentEncoding.toLowerCase() :
      'identity';
    const length = encoding === 'identity' ?
      req.headers['content-length'] : null;
    const limit = 100 * 1024; // 100kb
    const stream = decompressed(req, encoding);

    // Read body from stream.
    getBody(stream, { encoding: charset, length, limit }, (err, body) => {
      if (err) {
        return reject(
          err.type === 'encoding.unsupported' ?
            httpError(415, `Unsupported charset "${charset.toUpperCase()}".`) :
            httpError(400, `Invalid body: ${err.message}.`)
        );
      }

      try {
        return resolve(body);
      } catch (error) {
        return reject(error);
      }
    });
  });
}
