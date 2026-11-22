// Copyright 2022 yakc. All rights reserved. MIT license.

import { decodeString, default as NNTP } from "./nntp.ts";
import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { Buffer } from "node:buffer";
import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@^1";

const args = parseArgs(Deno.args, {
  boolean: ["secure"],
  string: ["host", "group", "article", "port"],
});
const port = args.port ? Number(args.port) : undefined;
assertExists(args.host);
assertExists(args.group);
const group = args.group; // narrowed for use inside test closures

Deno.test("throws when not connected", () => {
  const nntp = new NNTP({
    host: args.host,
    port,
    secure: args.secure,
  });

  assertRejects(() => nntp.disconnect(), Error, "not connected");
});

Deno.test("gets article and overviews", async () => {
  const nntp = new NNTP({
    host: args.host,
    port,
    secure: args.secure,
  });

  console.log("connect", await nntp.connectAndAuthenticate());
  console.log("groups", await nntp.listActiveGroups());
  const numbers = await nntp.group(group);
  console.log("group", numbers);
  if (args.article) {
    console.log("article", await nntp.article(args.article));
  } else {
    console.log("article", await nntp.article(String(numbers.high)));
  }
  console.log(
    "overview",
    await nntp.xover(`${numbers.high - 5}-`, await nntp.overviewFormat()),
  );
  return nntp.disconnect();
});

Deno.test("patches Windows-1252", () => {
  const want = "•bullet";
  const buf = Buffer.from("-bullet");
  buf.writeUInt8(0x95);
  const got = decodeString(buf, "latin1");
  assertEquals(got, want);
});
