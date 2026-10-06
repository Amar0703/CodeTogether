export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CodeTogether': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({
    error: { message: 'The server is unavailable. Please try again.', code: 'UNAVAILABLE' },
  }));
  if (!response.ok)
    throw new ApiError(
      data.error?.message ?? 'Request failed.',
      data.error?.code ?? 'UNKNOWN',
      response.status,
    );
  return data as T;
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
