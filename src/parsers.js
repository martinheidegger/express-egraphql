/* @flow */
/**
 *  Fork Copyright (c) 2016, Martin Heidegger,
 *
 *  Original Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */
import querystring from 'querystring';
import httpError from 'http-errors';

export type Payload = { [param: string]: mixed };
export type Parser = (string) => Payload;
export type Parsers = { [type: string]: Parser };

/**
 * RegExp to match an Object-opening brace "{" as the first non-space
 * in a string. Allowed whitespace is defined in RFC 7159:
 *
 *     x20  Space
 *     x09  Horizontal tab
 *     x0A  Line feed or New line
 *     x0D  Carriage return
 */
const jsonObjRegex = /^[\x20\x09\x0a\x0d]*\{/;

export default {
  'application/graphql': (body: string): Payload => {
    return { query: body };
  },
  'application/json': (body: string): Payload => {
    if (jsonObjRegex.test(body)) {
      /* eslint-disable no-empty */
      try {
        return JSON.parse(body);
      } catch (error) {
        // Do nothing
      }
      /* eslint-enable no-empty */
    }
    throw httpError(400, 'POST body sent invalid JSON.');
  },
  'application/x-www-form-urlencoded':
    (body: string): Payload => querystring.parse(body)
};
