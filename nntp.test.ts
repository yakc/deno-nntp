// Copyright 2022 yakc. All rights reserved. MIT license.

import { decodeString, default as NNTP } from "./nntp.ts";
import { parse } from "https://deno.land/std@0.148.0/flags/mod.ts";
import { Buffer } from "node:buffer";
import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.148.0/testing/asserts.ts";

const args = parse(Deno.args);
assertExists(args.host);
assertExists(args.group);

Deno.test("throws when not connected", () => {
  const nntp = new NNTP({
    host: args.host,
  });

  assertRejects(() => nntp.disconnect(), Error, "not connected");
});

Deno.test("gets article and overviews", async () => {
  const nntp = new NNTP({
    host: args.host,
  });

  console.log("connect", await nntp.connectAndAuthenticate());
  console.log("groups", await nntp.listActiveGroups());
  const numbers = await nntp.group(args.group);
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
