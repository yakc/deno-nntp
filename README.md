# deno-nntp

NNTP library for Usenet newsgroups, in Deno-flavored TypeScript.

This is a port of [robinvdvleuten/node-nntp](https://github.com/robinvdvleuten/node-nntp)@0.6.1,
tagged June 2017. It's a protocol-level library that gets raw article content
(arrays of strings for the headers and body) from news servers, usually over
port 119.

## Testing

The tests require a news server and group name to test against.

```bash
deno test --allow-env --allow-net -- --host news.example.com --group alt.something.or.other
```

## Rationale and caveats

`node-nntp` does not work with Deno (as of v1.23.4) because Deno does not
implement the deprecated `node:domain` package, which attempted to unify event
handling from emitters. The usage here is fairly light, and is coverted to use
promises, which is already part of the overall code modernization.

Deno also does not (currently?) implement `node:tls`, so the library cannot use
NNTPS, which is usually on port 563. This is controlled by the `secure` option
when creating the `NNTP` object.

The library attempts to support the non-standard `XZVER` command, which is a
compressed variant of the more-standard `XOVER` extension. But `XZVER` and the
`CompressedStream` are currently untested.
