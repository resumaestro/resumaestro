export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"]/g, (char) => {
    const escaped = ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] as string);
    return escaped;
  });

const pageStyle = `
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 640px; margin: 6vh auto; padding: 0 5%; color: #111 }
  h1 { font-size: 1.4rem }
  label { display: block; font-weight: 600; margin: 18px 0 6px }
  textarea { width: 100%; min-height: 64px; padding: 10px; border: 1px solid #ccc; border-radius: 8px; font: inherit; box-sizing: border-box }
  button { margin-top: 24px; padding: 12px 22px; border: 0; border-radius: 10px; background: #111; color: #fff; font: inherit; cursor: pointer }
  .ok { color: #0a7 }
  .muted { color: #666 }
`;

export const createPage = (title: string, body: string) => `\
<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageStyle}</style>
<body>
  ${body}
</body>`;

export const createConfirmPage = (submission: Record<string, unknown>, token: string) =>
  createPage(
    'Submit Application',
    `\
<h1>Submit application to ${escapeHtml(submission.company)}?</h1>
<p class=muted>${escapeHtml(submission.role)} &middot; ${escapeHtml(submission.ats)}</p>
<form method=POST>
  <input type=hidden name=token value="${escapeHtml(token)}">
  <button type=submit>Confirm and submit</button>
</form>`,
  );

export const createEditPage = (submission: Record<string, unknown>, token: string) => {
  const inputs = ((submission.fields as Array<Record<string, unknown>>) ?? [])
    .filter((field) => field.class !== 'file')
    .map((field) => `<label>${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>\n<textarea name="${escapeHtml(field.name)}">${escapeHtml(field.value)}</textarea>`)
    .join('\n');
  return createPage(
    'Edit Application',
    `\
<h1>Edit application</h1>
<p class=muted>${escapeHtml(submission.company)} &middot; ${escapeHtml(submission.role)}</p>
<form method=POST>
  <input type=hidden name=token value="${escapeHtml(token)}">
  ${inputs}
  <button type=submit>Save changes</button>
</form>`,
  );
};
