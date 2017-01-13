import type { Response } from 'express';

export class GraphQLRawError {
  status: number
  errors: [any]
  constructor(status: number, errors: [any]) {
    this.status = status;
    this.errors = errors;
  }
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
