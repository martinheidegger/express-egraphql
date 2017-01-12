/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import accepts from 'accepts';
import {
  Source,
  parse,
  validate,
  execute,
  formatError,
  getOperationAST,
  specifiedRules
} from 'graphql';
import httpError from 'http-errors';
import url from 'url';

import { parseRequest } from './parse';
import { renderGraphiQL } from './renderGraphiQL';

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

class GraphQLRawError {
  status: number
  errors: [any]
  constructor(status: number, errors: [any]) {
    this.status = status;
    this.errors = errors;
  }
}

function graphqlError(status, errors) {
  return new GraphQLRawError(status, errors);
}

function parseQuery(schema, query, validationRules) {
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

function getOperationType(documentAST, operationName) {
  const operationAST = getOperationAST(documentAST, operationName);
  if (!operationAST) {
    // No operation is basically same as a 'query' operation for no content
    return 'query';
  }
  return operationAST.operation;
}

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
  if (!options) {
    throw new Error('GraphQL middleware requires options.');
  }

  let resolveOptions;
  if (typeof options === 'function') {
    const optionsFetch: OptionsFetch = options;
    resolveOptions = (request: Request, response: Response) =>
      new Promise(
        resolve => resolve(optionsFetch(request, response))
      ).then(validateOptions);
  } else {
    validateOptions(options);
    resolveOptions = () => Promise.resolve(options);
  }

  return (request: Request, response: Response) => {
    // Higher scoped variables are referred to at various stages in the
    // asynchronous state machine below.
    let pretty;
    let graphiql;
    let formatErrorFn;
    let showGraphiQL;
    let query;
    let variables;
    let operationName;

    // Promises are used as a mechanism for capturing any thrown errors during
    // the asynchronous process below.

    // Resolve the Options to get OptionsData.
    return resolveOptions(request, response).then(optionsData => {
      // GraphQL HTTP only supports GET and POST methods.
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        throw httpError(405, 'GraphQL only supports GET and POST requests.');
      }

      // Collect information from the options data object.
      pretty = optionsData.pretty;
      graphiql = optionsData.graphiql;
      formatErrorFn = optionsData.formatError;

      // Parse the Request to get GraphQL request parameters.
      return getGraphQLParams(request).then(params => {
        // Get GraphQL params from the request and POST body data.
        query = params.query;
        variables = params.variables;
        operationName = params.operationName;
        showGraphiQL = graphiql && canDisplayGraphiQL(request, params);

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
    .catch(handleError.bind(null, response))
    .then(result => {
      // If no data was included in the result, that indicates a runtime query
      // error, indicate as such with a generic status code.
      // Note: Information about the error itself will still be contained in
      // the resulting JSON payload.
      // http://facebook.github.io/graphql/#sec-Data
      if (result && result.data === null) {
        response.statusCode = 500;
      }
      // Format any encountered errors.
      if (result && result.errors) {
        (result: any).errors = result.errors.map(formatErrorFn || formatError);
      }
      // If allowed to show GraphiQL, present it instead of JSON.
      if (showGraphiQL) {
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
module.exports.exec = exec;
function exec(
  schema, rootValue, context, extensionsInput,
  documentAST, variables, operationName
) {
  let executor;
  try {
    executor = execute(
      schema,
      documentAST,
      rootValue,
      context,
      variables,
      operationName
    );
  } catch (contextError) {
    return Promise.reject(graphqlError(400, [ contextError ]));
  }
  if (typeof extensionsInput === 'function') {
    const extensionsFn = extensionsInput;
    executor.then(result => Promise.resolve(extensionsFn({
      document: documentAST,
      variables,
      operationName,
      result
    })).then(extensions => {
      result.extensions = extensions;
      return result;
    }));
  }
  return executor;
}

module.exports.handleError = handleError;
function handleError(response, error) {
  // If an error was caught, report the httpError status, or 500.
  response.statusCode = error.status || 500;

  if (error instanceof GraphQLRawError) {
    return { errors: error.errors };
  }
  return { errors: [ error ] };
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
function getGraphQLParams(request: Request): Promise<GraphQLParams> {
  return parseRequest(request).then(bodyData => {
    const urlData = request.url && url.parse(request.url, true).query || {};
    return parseGraphQLParams(Object.assign(urlData, bodyData));
  });
}

/**
 * Helper function to get the GraphQL params from the request.
 */
module.exports.parseGraphQLParams = parseGraphQLParams;
function parseGraphQLParams(data): GraphQLParams {
  // GraphQL Query string.
  let query = data.query;
  if (typeof query !== 'string') {
    query = null;
  }

  // Parse the variables if needed.
  let variables = data.variables;
  if (typeof variables === 'string') {
    try {
      variables = JSON.parse(variables);
    } catch (error) {
      throw httpError(400, 'Variables are invalid JSON.');
    }
  } else if (typeof variables !== 'object') {
    variables = null;
  }

  // Name of GraphQL operation to execute.
  let operationName = data.operationName;
  if (typeof operationName !== 'string') {
    operationName = null;
  }

  const raw = data.raw !== undefined;

  return { query, variables, operationName, raw };
}

/**
 * Helper function to determine if GraphiQL can be displayed.
 */
function canDisplayGraphiQL(
  request: Request,
  params: GraphQLParams
): boolean {
  // If `raw` exists, GraphiQL mode is not enabled.
  // Allowed to show GraphiQL if not requested as raw and this request
  // prefers HTML over JSON.
  return !params.raw && accepts(request).types([ 'json', 'html' ]) === 'html';
}

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
