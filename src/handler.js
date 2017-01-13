import type { Response } from 'express';
import { formatError } from 'graphql';
import accepts from 'accepts';

export class GraphQLRawError {
  status: number
  errors: [any]
  constructor(status: number, errors: [any]) {
    this.status = status;
    this.errors = errors;
  }
}


/**
 * Helper function to determine if GraphiQL can be displayed.
 */
export function canDisplayGraphiQL(
  request: Request,
  params: GraphQLParams
): boolean {
  // If `raw` exists, GraphiQL mode is not enabled.
  // Allowed to show GraphiQL if not requested as raw and this request
  // prefers HTML over JSON.
  return !params.raw && accepts(request).types([ 'json', 'html' ]) === 'html';
}


export function handleResult(formatErrorFn: ?(any) => string,
                             response: Response, result: any) {
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

  return result;
}

export function handleError(response: Response, error) {
  // If an error was caught, report the httpError status, or 500.
  response.statusCode = error.status || 500;

  if (error instanceof GraphQLRawError) {
    return { errors: error.errors };
  }
  return { errors: [ error ] };
}

export function graphqlError(status, errors) {
  return new GraphQLRawError(status, errors);
}
