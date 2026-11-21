// Copyright 2026 yakc. All rights reserved. MIT license.

// Build MIME articles (RFC 2045/2046, RFC 2231 filenames) suitable for
// `NNTP.post()`. Attachments are base64-encoded, so every generated line is
// 7-bit ASCII, except for the text part, which is sent as UTF-8 8bit.
//
// Deliberately free of `node:` dependencies so it can be imported on its own.

export interface Attachment {
  filename: string;
  /** Defaults to `application/octet-stream` */
  contentType?: string;
  data: Uint8Array;
}

export interface MimeMessageParts {
  /** Article headers like `From:`, `Newsgroups:`, `Subject:`, without MIME headers */
  headers: string[];
  /** Plain text body; line breaks may be LF or CRLF */
  text: string;
  attachments?: Attachment[];
}

/**
 * Headers controlled by the builder. If present in the input,
 * they are dropped (including any folded continuation lines).
 */
const MIME_HEADER = /^(mime-version|content-[\w-]+)\s*:/i;

const BASE64_BYTES_PER_LINE = 57; // encodes to 76 characters

/** Returns `{ headers, body }`, compatible with `MessageLines` for `NNTP.post()` */
export function buildMimeMessage(
  parts: MimeMessageParts,
): { headers: string[]; body: string[] } {
  const headers = stripMimeHeaders(parts.headers);
  headers.push("MIME-Version: 1.0");

  const textLines = splitLines(parts.text);
  const attachments = parts.attachments ?? [];

  if (!attachments.length) {
    headers.push(...textPartHeaders(textLines));
    return { headers, body: textLines };
  }

  const encoded = attachments.map((a) => ({
    headers: attachmentHeaders(a),
    lines: base64Lines(a.data),
  }));

  // Base64 lines can never contain "=_" mid-line, but text and filenames can
  // contain anything, so make sure the boundary is unique.
  let boundary: string;
  do {
    boundary = `=_deno-nntp_${crypto.randomUUID()}`;
  } while (
    textLines.some((l) => l.includes(boundary)) ||
    encoded.some((e) => e.headers.some((h) => h.includes(boundary)))
  );
  const delimiter = "--" + boundary;

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const body: string[] = ["This is a multi-part message in MIME format.", ""];
  if (parts.text.length) {
    body.push(delimiter, ...textPartHeaders(textLines), "", ...textLines);
  }
  for (const e of encoded) {
    body.push(delimiter, ...e.headers, "", ...e.lines);
  }
  body.push(delimiter + "--");

  return { headers, body };
}

function stripMimeHeaders(input: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of input) {
    if (/^[ \t]/.test(line)) { // folded continuation
      if (!skipping) out.push(line);
    } else {
      skipping = MIME_HEADER.test(line);
      if (!skipping) out.push(line);
    }
  }
  return out;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop(); // trailing newline
  }
  return lines;
}

function textPartHeaders(lines: string[]): string[] {
  // deno-lint-ignore no-control-regex
  const ascii = lines.every((l) => /^[\x00-\x7f]*$/.test(l));
  return [
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${ascii ? "7bit" : "8bit"}`,
  ];
}

function attachmentHeaders(a: Attachment): string[] {
  const type = a.contentType?.trim() || "application/octet-stream";
  const param = filenameParam(a.filename);
  return [
    `Content-Type: ${type}; ${param.replace(/^filename/, "name")}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; ${param}`,
  ];
}

/** Quoted string for printable ASCII, RFC 2231 extended value otherwise */
function filenameParam(filename: string): string {
  // Strip any path, Windows or POSIX
  const name = filename.replace(/^.*[\\/]/, "") || "attachment";
  if (/^[\x20-\x7e]*$/.test(name)) {
    return `filename="${name.replace(/["\\]/g, "\\$&")}"`;
  }
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `filename*=utf-8''${encoded}`;
}

export function base64Lines(data: Uint8Array): string[] {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += BASE64_BYTES_PER_LINE) {
    const chunk = data.subarray(i, i + BASE64_BYTES_PER_LINE);
    lines.push(btoa(String.fromCharCode(...chunk)));
  }
  return lines;
}
