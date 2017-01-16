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
import url from 'url';
import { createCipher, createDecipher } from 'crypto';

import {
  parseRequest,
  parseBody,
  parseQuery,
  parseGraphQLParams,
  getOperationType
} from './parse';
import type {
  Payload
} from './parsers';
import { renderGraphiQL } from './renderGraphiQL';
import {
  handleResult,
  handleError,
  canDisplayGraphiQL,
  exec
} from './handler';

import type {
  DocumentNode,
  GraphQLError,
  GraphQLSchema
} from 'graphql';
import type { Response } from 'express';

export type Request = {
  method: string;
  url: string;
  body: mixed;
  headers: {[header: string]: mixed};
  pipe<T>(stream: T): T;
};

/**
 * Used to configure the graphqlHTTP middleware by providing a schema
 * and other configuration options.
 *
 * Options can be provided as an Object, a Promise for an Object, or a Function
 * that returns an Object or a Promise for an Object.
 */
export type Options = OptionsFetch | OptionsResult;
export type OptionsFetch = (req: Request, res: Response) => OptionsResult;
export type PrivateKeyFetch = (keyID: string) => Promise<string>;
export type OptionsResult = OptionsData | Promise<OptionsData>;
export type OptionsData = {
  /**
   * A GraphQL schema from graphql-js.
   */
  schema: GraphQLSchema,

  /**
   * A value to pass as the context to the graphql() function.
   */
  context?: ?mixed,

  /**
   * An object to pass as the rootValue to the graphql() function.
   */
  rootValue?: ?mixed,

  /**
   * A boolean to configure whether the output should be pretty-printed.
   */
  pretty?: ?boolean,

  /**
   * An optional function which will be used to format any errors produced by
   * fulfilling a GraphQL operation. If no function is provided, GraphQL's
   * default spec-compliant `formatError` function will be used.
   */
  formatError?: ?(error: GraphQLError) => mixed,

  /**
   * An optional array of validation rules that will be applied on the document
   * in additional to those defined by the GraphQL spec.
   */
  validationRules?: ?Array<mixed>,

  /**
   * An optional function for adding additional metadata to the GraphQL response
   * as a key-value object. The result will be added to "extensions" field in
   * the resulting JSON. This is often a useful place to add development time
   * info such as the runtime of a query or the amount of resources consumed.
   *
   * Information about the request is provided to be used.
   *
   * This function may be async.
   */
  extensions?: ?(info: RequestInfo) => {[key: string]: mixed};

  /**
   * A boolean to optionally enable GraphiQL mode.
   */
  graphiql?: ?boolean,

  getPrivateKey?: PrivateKeyFetch;

  acceptedCipherAlgorithms?: string[];
};

/**
 * All information about a GraphQL request.
 */
export type RequestInfo = {
  /**
   * The parsed GraphQL document.
   */
  document: DocumentNode,

  /**
   * The variable values used at runtime.
   */
  variables: ?{[name: string]: mixed};

  /**
   * The (optional) operation name requested.
   */
  operationName: ?string;

  /**
   * The result of executing the operation.
   */
  result: ?mixed;
};

type Middleware = (request: Request, response: Response) => Promise<void>;

function validateOptions(optionsData) {
  // Assert that optionsData is in fact an Object.
  if (!optionsData || typeof optionsData !== 'object') {
    throw new Error(
      'GraphQL middleware option function must return an options object ' +
      'or a promise which will be resolved to an options object.'
    );
  }

  // Assert that schema is required.
  if (!optionsData.schema) {
    throw new Error(
      'GraphQL middleware options must contain a schema.'
    );
  }

  return optionsData;
}

/**
 * Middleware for express; takes an options object or function as input to
 * configure behavior, and returns an express middleware.
 */
module.exports = graphqlHTTP;
function graphqlHTTP(options: Options): Middleware {
  const resolveOptions = createOptionResolver(options);

  return (request: Request, response: Response) => {
    // Higher scoped variables are used when finishing the request.

    // These options can be overwritten but need to be set to default
    // values in case resolving the options
    let pretty = false;
    let formatErrorFn;
    let showGraphiQL = false;

    // The input will be used to render showGraphiQl if given.
    let query;
    let variables;
    let operationName;

    // Promises are used as a mechanism for capturing any thrown errors during
    // the asynchronous process below.
    return resolveOptions(request, response).then(optionsData => {
      // GraphQL HTTP only supports GET and POST methods.
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        throw httpError(405, 'GraphQL only supports GET and POST requests.');
      }

      // Collect information from the options data object.
      pretty = optionsData.pretty;
      formatErrorFn = optionsData.formatError;

      // Parse the Request to get GraphQL request parameters.
      return getGraphQLParams(
        request, response,
        optionsData.getPrivateKey,
        optionsData.acceptedCipherAlgorithms || [ 'aes256', 'des' ]
      ).then(params => {
        // Get GraphQL params from the request and POST body data.
        query = params.query;
        variables = params.variables;
        operationName = params.operationName;
        showGraphiQL = optionsData.graphiql &&
          canDisplayGraphiQL(request, params);

        // If there is no query, but GraphiQL will be displayed, do not produce
        // a result, otherwise return a 400: Bad Request.
        if (!query) {
          if (showGraphiQL) {
            return null;
          }
          throw httpError(400, 'Must provide query string.');
        }

        return parseQuery(optionsData.schema, query,
            optionsData.validationRules
          ).then(documentAST => {

            // Only query operations are allowed on GET requests.
            if (request.method === 'GET') {
              // Determine if this GET request will perform a non-query.
              const operation = getOperationType(documentAST, operationName);
              if (operation !== 'query') {
                // If GraphiQL can be shown, do not perform this query, but
                // provide it to GraphiQL so that the requester may perform it
                // themselves if desired.
                if (showGraphiQL) {
                  return null;
                }

                // Otherwise, report a 405: Method Not Allowed error.
                response.setHeader('Allow', 'POST');
                throw httpError(
                  405,
                  `Can only perform a ${operation} operation ` +
                  'from a POST request.'
                );
              }
            }
            return exec(
              optionsData.schema,
              optionsData.rootValue,
              optionsData.context || request,
              optionsData.extensions,
              documentAST,
              variables,
              operationName
            );
          });
      });
    })
    .catch(error => handleError(response, error))
    .then(result => handleResult(formatErrorFn, response, result))
    .then(result => {
      // If allowed to show GraphiQL, present it instead of JSON.
      if (response.cipher) {
        var data = {
          t: Date.now(),
          status: response.statusCode,
          payload: result
        };
        response.statusCode = 200;
        var res = response.cipher(data);
        sendResponse(response, res);
      } else if (showGraphiQL) {
        const payload = renderGraphiQL({
          query, variables,
          operationName, result
        });
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        sendResponse(response, payload);
      } else {
        // Otherwise, present JSON directly.
        const payload = JSON.stringify(result, null, pretty ? 2 : 0);
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        sendResponse(response, payload);
      }
    });
  };
}

type OptionsResolver =
  (request: Request, response: Response) => Promise<OptionsData>;

module.exports.createOptionResolver = createOptionResolver;
function createOptionResolver(options: Options): OptionsResolver {
  if (!options) {
    throw new Error('GraphQL middleware requires options.');
  }
  if (typeof options === 'function') {
    const optionsFetch: OptionsFetch = options;
    return (request: Request, response: Response) =>
      new Promise(
        resolve => resolve(optionsFetch(request, response))
      ).then(validateOptions);
  }
  validateOptions(options);
  return () => Promise.resolve(options);
}

export type GraphQLParams = {
  query: ?string;
  variables: ?{[name: string]: mixed};
  operationName: ?string;
  raw: ?boolean;
};

/**
 * Provided a "Request" provided by express or connect (typically a node style
 * HTTPClientRequest), Promise the GraphQL request parameters.
 */
module.exports.getGraphQLParams = getGraphQLParams;
function getGraphQLParams(request: Request, response: Reponse,
  getPrivateKey?: PrivateKeyFetch, acceptedCipherAlgorithms: string[]
): Promise<GraphQLParams> {
  if (request.method === 'POST' && getPrivateKey) {
    const cipherAlgorithm: mixed = request.headers['x-cipher'];
    const keyID: mixed = request.headers['x-key-id'];

    if (!keyID) {
      if (!cipherAlgorithm) {
        return getRegularGraphQLParams(request);
      }
      return Promise.reject(httpError(400,
        'The header "x-cipher" requires the use of "x-key-id".'));
    }
    if (!cipherAlgorithm) {
      return Promise.reject(httpError(400,
        'The header "x-key-id" requires the use of "x-cipher".'));
    }
    return isEncryptedRequest(getPrivateKey, acceptedCipherAlgorithms,
      String(cipherAlgorithm), String(keyID)).then(credentials => {
        return parseBody(request, 'utf-8', credentials.decipher)
          .then(data => {
            response.cipher = credentials.cipher;
            if (!data.payload) {
              return Promise.reject(httpError(400, 'Payload missing'));
            }
            return parseGraphQLParams(data.payload);
          })
          .catch(e => {
            if (e.statusCode === 401) {
              return Promise.reject(e);
            }
            response.cipher = credentials.cipher;
            return Promise.reject(e);
          });
      });
  }
  return getRegularGraphQLParams(request);
}

type CryptoHandler = {
  cipher: (input: Payload) => string,
  decipher: (encrypted: string) => any
};

function isEncryptedRequest(
  getPrivateKey: PrivateKeyFetch,
  acceptedCipherAlgorithms: string[],
  cipherAlgorithm: string,
  keyID: string
): Promise<CryptoHandler> {
  if (acceptedCipherAlgorithms.indexOf(cipherAlgorithm) === -1) {
    return Promise.reject(httpError(400,
      `"x-cipher" set to "${cipherAlgorithm}" is not acceptable.
Acceptable options are: ${acceptedCipherAlgorithms.join(', ')}.`));
  }
  return getPrivateKey(keyID)
    .catch(() => {
      // should getPrivateKey fail for some reason its content could contain
      // potentially reveal information about how getPrivateKey works. In order
      // to cover that we just return with a delay.
      return delayedReject();
    })
    .then(privateKey => {
      if (!privateKey) {
        return delayedReject();
      }
      return {
        cipher(data) {
          const c = createCipher(cipherAlgorithm, privateKey);
          return Buffer.concat([
            c.update(Buffer.from(JSON.stringify(data))),
            c.final()
          ]).toString('base64');
        },
        decipher(data) {
          try {
            const d = createDecipher(cipherAlgorithm, privateKey);
            const str = Buffer.concat([
              d.update(Buffer.from(data, 'base64')),
              d.final()
            ]).toString();
            return Promise.resolve(JSON.parse(str));
          } catch (e) {
            // There is no simple way to figure out if the error occurs
            // because of malformatted JSON content or wrong encryption
            // so we need to go with authentication error since it is
            // not good to inform a possible hacker that the JSON might
            // be malformated (indicating that the user actually exists)
            // Delaying response
            return delayedReject();
          }
        }
      };
    });
}

function delayedReject() {
  // In order for a possible attacker to not know
  // if a request failed because the user exists
  // or not we need to reject with a random delay
  return new Promise( (_, reject) =>
    setTimeout(() =>
      reject(httpError(401, 'Authentication failed.'))
    , Math.random() * 500)
  );
}

function getRegularGraphQLParams(request: Request): Promise<GraphQLParams> {
  return parseRequest(request).then(bodyData => {
    const urlData = request.url && url.parse(request.url, true).query || {};
    return parseGraphQLParams(Object.assign(urlData, bodyData));
  });
}

module.exports.parseGraphQLParams = parseGraphQLParams;

/**
 * Helper function for sending the response data. Use response.send it method
 * exists (express), otherwise use response.end (connect).
 */
function sendResponse(response: Response, data: string): void {
  if (typeof response.send === 'function') {
    response.send(data);
  } else {
    response.end(data);
  }
}
