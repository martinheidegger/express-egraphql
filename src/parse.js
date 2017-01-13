/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import contentType from 'content-type';
import readBody from './readBody';
import parsers from './parsers';
import {
  parse,
  validate,
  Source,
  getOperationAST,
  specifiedRules
} from 'graphql';
import { graphqlError } from './handler';

import type { Request } from './index';
import type { Payload, Parser } from './parsers';
import type { GraphQLSchema, DocumentNode } from 'graphql';

export type Result = Promise<Payload>;

/**
 * Provided a "Request" provided by express or connect (typically a node style
 * HTTPClientRequest), Promise the body data contained.
 */
export function parseRequest(req: Request): Result {

  // Skip requests without content types.
  if (req.headers['content-type'] === undefined) {
    return Promise.resolve({});
  }

  const typeInfo = contentType.parse(req);

  // Use the correct body parser based on Content-Type header.
  const parseFn = parsers[typeInfo.type];

  const body = req.body;

  // If express has already parsed a body as a string, and the content-type
  // was application/graphql, parse the string body.
  if (typeof body === 'string' && typeInfo.type === 'application/graphql') {
    return Promise.resolve(parseFn(body));
  }

  const charset = (typeInfo.parameters.charset || 'utf-8').toLowerCase();

  return parseBody(req, charset, parseFn);
}

/**
 * Parses a given query following a provided Schema definition. Can be extended
 * by passing in optional validationRules.
 */
export function parseQuery(
  schema: GraphQLSchema, query: string, validationRules: ?Array<mixed>
): Promise<DocumentNode> {
  // GraphQL source.
  const source = new Source(query, 'GraphQL request');

  // Parse source to AST, reporting any syntax error.
  let documentAST;
  try {
    documentAST = parse(source);
  } catch (syntaxError) {
    return Promise.reject(graphqlError(400, [ syntaxError ] ));
  }

  let allValidationRules = specifiedRules;
  if (validationRules) {
    allValidationRules = allValidationRules.concat(validationRules);
  }

  // Validate AST, reporting any errors.
  const validationErrors = validate(schema, documentAST, allValidationRules);

  if (validationErrors.length > 0) {
    return Promise.reject(graphqlError(400, validationErrors));
  }

  return Promise.resolve(documentAST);
}

export function parseBody(
    req: Request, charset: string, parseFn: Parser
  ): Result {
  const body = req.body;

  // If express has already parsed a body as a keyed object, use it.
  if (typeof body === 'object' && !(body instanceof Buffer)) {
    return Promise.resolve((body: any));
  }

  // If no Content-Type header matches, parse nothing.
  if (!parseFn) {
    return Promise.resolve({});
  }

  // Already parsed body we didn't recognise? Parse nothing.
  if (body) {
    return Promise.resolve({});
  }

  return readBody(req, charset).then(parseFn);
}

export function getOperationType(documentAST: DocumentNode,
                                 operationName: ?string): string {
  const operationAST = getOperationAST(documentAST, operationName);
  if (!operationAST) {
    // No operation is basically same as a 'query' operation for no content
    return 'query';
  }
  return operationAST.operation;
}
