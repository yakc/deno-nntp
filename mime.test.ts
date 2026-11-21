// Copyright 2026 yakc. All rights reserved. MIT license.

// No server required:
//   deno test mime.test.ts

import { base64Lines, buildMimeMessage } from "./mime.ts";
import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.148.0/testing/asserts.ts";

const baseHeaders = [
  "From: Tester <test@example.com>",
  "Newsgroups: alt.test",
  "Subject: hello",
];

function decodeBase64Lines(lines: string[]): Uint8Array {
  return Uint8Array.from(atob(lines.join("")), (c) => c.charCodeAt(0));
}

Deno.test("text only, ASCII", () => {
  const msg = buildMimeMessage({ headers: baseHeaders, text: "line 1\nline 2\n" });
  assertEquals(msg.headers, [
    ...baseHeaders,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
  ]);
  assertEquals(msg.body, ["line 1", "line 2"]);
});

Deno.test("text only, non-ASCII is 8bit", () => {
  const msg = buildMimeMessage({ headers: baseHeaders, text: "café\r\n€5" });
  assert(msg.headers.includes("Content-Transfer-Encoding: 8bit"));
  assertEquals(msg.body, ["café", "€5"]);
});

Deno.test("strips caller MIME headers, including folded lines", () => {
  const msg = buildMimeMessage({
    headers: [
      ...baseHeaders,
      "Content-Type: text/html;",
      "\tcharset=us-ascii",
      "MIME-Version: 1.0",
      "X-Extra: kept",
      " folded kept",
    ],
    text: "hi",
  });
  assertEquals(msg.headers.filter((h) => /^mime-version/i.test(h)).length, 1);
  assert(!msg.headers.some((h) => h.includes("text/html")));
  assert(!msg.headers.some((h) => h.includes("us-ascii")));
  assert(msg.headers.includes("X-Extra: kept"));
  assert(msg.headers.includes(" folded kept"));
});

Deno.test("base64 lines are 76 chars and round-trip", () => {
  const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
  const lines = base64Lines(data);
  for (const l of lines.slice(0, -1)) assertEquals(l.length, 76);
  assert(lines[lines.length - 1].length <= 76);
  assertEquals(decodeBase64Lines(lines), data);
  assertEquals(base64Lines(new Uint8Array()), []);
});

Deno.test("multipart with attachments", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const bin = Uint8Array.from({ length: 200 }, (_, i) => 255 - i);
  const msg = buildMimeMessage({
    headers: baseHeaders,
    text: "see attached\n.leading dot\n",
    attachments: [
      { filename: "C:\\pics\\dot.png", contentType: "image/png", data: png },
      { filename: "résumé \"v2\".bin", data: bin },
    ],
  });

  const ct = msg.headers.find((h) => h.startsWith("Content-Type:"))!;
  const m = /boundary="([^"]+)"/.exec(ct)!;
  assert(m, ct);
  assertMatch(ct, /^Content-Type: multipart\/mixed;/);
  const delim = "--" + m[1];

  // every line is 7-bit except the declared 8bit text part (none here)
  // deno-lint-ignore no-control-regex
  for (const l of msg.body) assertMatch(l, /^[\x00-\x7f]*$/);

  assertEquals(msg.body.filter((l) => l === delim).length, 3);
  assertEquals(msg.body[msg.body.length - 1], delim + "--");

  // Split into parts and check each
  const parts: string[][] = [];
  for (const l of msg.body) {
    if (l === delim || l === delim + "--") parts.push([]);
    else if (parts.length) parts[parts.length - 1].push(l);
  }
  parts.pop(); // after closing delimiter

  const split = (p: string[]) => {
    const blank = p.indexOf("");
    return { h: p.slice(0, blank), b: p.slice(blank + 1) };
  };

  const text = split(parts[0]);
  assert(text.h.includes("Content-Type: text/plain; charset=utf-8"));
  assertEquals(text.b, ["see attached", ".leading dot"]);

  const img = split(parts[1]);
  assertEquals(img.h, [
    'Content-Type: image/png; name="dot.png"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="dot.png"',
  ]);
  assertEquals(decodeBase64Lines(img.b), png);

  const other = split(parts[2]);
  assertEquals(other.h, [
    "Content-Type: application/octet-stream; name*=utf-8''r%C3%A9sum%C3%A9%20%22v2%22.bin",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9%20%22v2%22.bin",
  ]);
  assertEquals(decodeBase64Lines(other.b), bin);
});

Deno.test("attachment-only message omits text part", () => {
  const msg = buildMimeMessage({
    headers: baseHeaders,
    text: "",
    attachments: [{ filename: "a.txt", contentType: "text/plain", data: new Uint8Array([65]) }],
  });
  const delim = msg.body.find((l) => l.startsWith("--=_deno-nntp_"))!;
  assertEquals(msg.body.filter((l) => l === delim).length, 1);
  assert(!msg.body.some((l) => l.includes("charset=utf-8")));
});
