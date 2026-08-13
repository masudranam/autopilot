import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ProblemType, type FieldError, type ProblemDetails } from '@repo/contracts';
import { DomainError } from '../errors/domain-error';
import { logger } from '../logging/logger';
import { currentTraceId } from '../trace/trace';

/**
 * The single owner of the error wire format (I3, AC1).
 *
 * Every error — domain, Zod, Nest HttpException, or a completely unexpected throw —
 * leaves the API as RFC 9457 Problem Details with a traceId matching the response
 * header and the logs.
 *
 * The production-mode rule (AC2) is the important one: an unexpected error's message
 * frequently contains a SQL fragment, a file path or a connection string. In
 * production the client gets a generic sentence and nothing else; the real detail
 * goes to the logs, correlated by traceId. Development keeps the message, because
 * debugging blind is its own hazard.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const traceId = currentTraceId();

    const problem = this.toProblem(exception, request, traceId);

    // Server-side faults are the ones worth a stack; client errors are noise at
    // error level. Either way the FULL detail is logged, never sent.
    if (problem.status >= 500) {
      logger.error('unhandled exception', {
        status: problem.status,
        path: request.originalUrl,
        error: serialiseError(exception),
      });
    } else {
      logger.warn('request failed', {
        status: problem.status,
        path: request.originalUrl,
        type: problem.type,
        detail: problem.detail,
      });
    }

    // Never set the header twice, and never crash the filter itself.
    if (!response.headersSent) {
      response.status(problem.status).type('application/problem+json').json(problem);
    }
  }

  private toProblem(exception: unknown, request: Request, traceId: string): ProblemDetails {
    const instance = request.originalUrl;

    if (exception instanceof DomainError) {
      return {
        type: exception.type,
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        instance,
        traceId,
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }

    if (exception instanceof ZodError) {
      return {
        type: ProblemType.VALIDATION_FAILED,
        title: 'Validation failed',
        status: 422,
        detail: 'The request did not match the expected shape.',
        instance,
        traceId,
        errors: zodToFieldErrors(exception),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: problemTypeForStatus(status),
        title: titleForStatus(status),
        status,
        // Suppression is keyed on STATUS, not on exception class. Keying it on class
        // let `new InternalServerErrorException(err.message)` — the most common way a
        // 500 is raised in Nest — return SQL and connection strings verbatim in
        // production while a plain Error was suppressed (found by pr-reviewer).
        detail: this.detailFor(status, httpExceptionDetail(exception)),
        instance,
        traceId,
      };
    }

    // body-parser and other express-layer errors carry their own status (413 for an
    // oversized payload, 400 for a bad content type). Honouring it stops an ordinary
    // client mistake becoming a 500 logged at error level with a stack.
    const carried = carriedStatus(exception);
    if (carried) {
      return {
        type: problemTypeForStatus(carried),
        title: titleForStatus(carried),
        status: carried,
        detail: this.detailFor(
          carried,
          exception instanceof Error ? exception.message : 'Request rejected.',
        ),
        instance,
        traceId,
      };
    }

    return {
      type: ProblemType.INTERNAL,
      title: 'Internal server error',
      status: 500,
      detail: this.detailFor(
        500,
        exception instanceof Error ? exception.message : String(exception),
      ),
      instance,
      traceId,
    };
  }

  /**
   * AC2: a 5xx message routinely carries SQL, file paths or credentials, whatever
   * threw it. In production the client gets a generic sentence and the real detail
   * goes to the logs, correlated by traceId. Client errors (4xx) describe the
   * caller's own mistake, so they stay informative.
   */
  private detailFor(status: number, message: string): string {
    if (status >= 500 && this.isProduction) {
      return 'An unexpected error occurred. Quote the traceId when reporting it.';
    }
    return message;
  }
}

/** Zod issues → the contract's flat field-error list (AC1). */
export function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * A `status`/`statusCode` carried by a non-HttpException error — express-layer errors
 * such as body-parser's PayloadTooLargeError (413) use this convention.
 */
function carriedStatus(exception: unknown): number | undefined {
  if (!exception || typeof exception !== 'object') return undefined;
  const candidate = exception as { status?: unknown; statusCode?: unknown };
  const value = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof value !== 'number') return undefined;
  // Only trust a plausible client/server status; anything else is coincidence.
  return value >= 400 && value <= 599 ? value : undefined;
}

function httpExceptionDetail(exception: HttpException): string {
  const body: unknown = exception.getResponse();
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = body.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return exception.message;
}

const STATUS_TYPES: Readonly<Record<number, string>> = {
  400: ProblemType.VALIDATION_FAILED,
  401: ProblemType.UNAUTHENTICATED,
  403: ProblemType.FORBIDDEN,
  404: ProblemType.NOT_FOUND,
  409: ProblemType.CONFLICT,
  // A client's oversized upload or wrong content type is their mistake, not ours —
  // typing it INTERNAL would have clients switching on the wrong problem type.
  413: ProblemType.PAYLOAD_TOO_LARGE,
  415: ProblemType.UNSUPPORTED_MEDIA_TYPE,
  422: ProblemType.VALIDATION_FAILED,
  429: ProblemType.RATE_LIMITED,
};

function problemTypeForStatus(status: number): string {
  return STATUS_TYPES[status] ?? ProblemType.INTERNAL;
}

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Unauthenticated',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  429: 'Too many requests',
};

function titleForStatus(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? 'Internal server error' : 'Request failed');
}

/** Full error detail for the logs only — never for a response body. */
function serialiseError(exception: unknown): Record<string, unknown> {
  if (exception instanceof Error) {
    return { name: exception.name, message: exception.message, stack: exception.stack };
  }
  return { value: String(exception) };
}
