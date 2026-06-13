export const html = {
  'Content-Type': 'text/html; charset=utf-8',
} as const;

export const json = {
  'Content-Type': 'application/json',
} as const;

export const createResponseInit = (
  kind: 'html' | 'json',
  status?: number,
): ResponseInit => ({
  headers: kind === 'html' ? html : json,
  status: status ?? 200,
});

export const headers = {
  json,
  html,
};
