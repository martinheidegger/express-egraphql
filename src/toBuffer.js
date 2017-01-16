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

module.exports = (input: any, encoding?: 'base64' | 'utf-8' | 'ascii' | 'buffer'
) =>
  Buffer.from ?
    Buffer.from(input, encoding) :
    new Buffer(input, encoding);
