# deno-nntp

NNTP library for Usenet newsgroups, in Deno-flavored TypeScript.

This is a port of [robinvdvleuten/node-nntp](https://github.com/robinvdvleuten/node-nntp)@0.6.1,
tagged June 2017. It's a protocol-level library that gets raw article content
(arrays of strings for the headers and body) from news servers, usually over
port 119.

## Testing

The MIME builder tests need no server:

```bash
deno test mime.test.ts
```

The protocol tests require a news server and group name to test against.

```bash
deno test --allow-env --allow-net nntp.test.ts -- --host news.example.com --group alt.something.or.other
```

Add `--secure` for NNTPS, and `--port` for a non-default port.

## Posting with attachments

`buildMimeMessage` (in `mime.ts`, re-exported from `nntp.ts`) produces the
`MessageLines` for `post()`. Attachments are sent as MIME `multipart/mixed`
with base64 encoding.

```ts
import NNTP, { buildMimeMessage } from "./nntp.ts";

const msg = buildMimeMessage({
  headers: ["From: Me <me@example.com>", "Newsgroups: alt.test", "Subject: pic"],
  text: "See attached.\n",
  attachments: [{
    filename: "cat.png",
    contentType: "image/png",
    data: await Deno.readFile("cat.png"),
  }],
});
await nntp.post(msg);
```

Many text-only servers and groups reject binary attachments regardless of
encoding, in which case `post()` returns `false`.

## Rationale and caveats

`node-nntp` does not work with Deno (as of v1.23.4) because Deno does not
implement the deprecated `node:domain` package, which attempted to unify event
handling from emitters. The usage here is fairly light, and is coverted to use
promises, which is already part of the overall code modernization.

NNTPS (implicit TLS, usually on port 563) is enabled with the `secure` option
when creating the `NNTP` object; the port then defaults to 563. Extra
`tls.connect()` options, such as `ca` for a private certificate authority, can
be passed as `tls`. STARTTLS is not supported.

The library attempts to support the non-standard `XZVER` command, which is a
compressed variant of the more-standard `XOVER` extension. But `XZVER` and the
`CompressedStream` are currently untested.
