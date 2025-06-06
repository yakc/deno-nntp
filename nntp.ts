// Copyright 2022-2025 yakc. All rights reserved. MIT license.

// Ported from https://github.com/robinvdvleuten/node-nntp
// Original MIT license:
/*
Copyright (c) 2013-2014 Robin van der Vleuten

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

import { Buffer, TranscodeEncoding } from "node:buffer";
import { connect, Socket } from "https://deno.land/std@0.148.0/node/net.ts";
import { Transform } from "https://deno.land/std@0.148.0/node/stream.ts";
import zlib from "https://deno.land/std@0.148.0/node/zlib.ts";

type Chunk = Buffer | string;

export class Response {
  lines: string[] = [];

  constructor(public status: number, public message: string) {}

  // RFC 3977 (Oct 2006) supersedes RFC 997 (Feb 1986)
  static readonly POSTING_ALLOWED = 200;
  static readonly POSTING_PROHIBITED = 201;
  static readonly GROUP_SELECTED = 211;
  static readonly MULTILINE_FOLLOWS = 215;
  static readonly NO_SUCH_GROUP = 411;
  static readonly NO_SUCH_ARTICLE = 430;
  static readonly ARTICLE_RETRIEVED = 220;
  static readonly OVERVIEW_FOLLOWS = 224;
  static readonly SYNTAX_ERROR = 501;
  // RFC 4643 (Oct 2006)
  static readonly PASSWORD_REQUIRED = 381;

  static isMultiLine(firstThreeChars: string): boolean {
    switch (parseInt(firstThreeChars)) {
      // case this.GROUP_SELECTED:  // no, only with LISTGROUP, which we don't use
      case this.MULTILINE_FOLLOWS:
      case this.ARTICLE_RETRIEVED:
      case this.OVERVIEW_FOLLOWS:
        return true;
      case this.SYNTAX_ERROR:
      default:
        return false;
    }
  }

  static createFromString(arg: string) {
    const matches = /^(\d{3}) ([\S\s]+)$/g.exec(arg.trim());
    if (!matches) {
      throw new Error(`Invalid response given: ${arg}`);
    }

    const status = parseInt(matches[1], 10);
    if (status < 100 || status >= 600) {
      throw new Error(`Invalid status code given: ${matches[1]}`);
    }

    return new Response(status, matches[2]);
  }
}

class ResponseStream extends Transform {
  constructor(public multiline: boolean) {
    super({ objectMode: true });
  }

  #response?: Response;

  override _transform(chunk: Chunk, _encoding: string, done: () => void) {
    if (undefined === this.#response) {
      this.#response = Response.createFromString(
        chunk.toString(defaultEncoding),
      );

      if (false === this.multiline) {
        this.push(this.#response);
        this.end();
      }
    } else {
      this.#response.lines.push(chunk.toString(defaultEncoding));
    }

    done();
  }

  override _flush(done: () => void) {
    this.push(this.#response);
    done();
  }
}

const defaultEncoding = "latin1"; // aka 'binary'

// This originally returned `string`, but should actually be
// BufferEncoding for the functions that use it. However, that
// is or was defined globally in Node, with no clean way to
// import it? TranscodeEncoding is exported in the usual way,
// and only lacks 'hex', which is not applicable.
function charset2encoding(charset: string): TranscodeEncoding {
  switch (charset.toLowerCase()) {
    case "utf-8":
    case "utf8":
      return "utf8";
    case "utf-16le":
    case "utf16le":
      return "utf16le";
    case "iso-8859-1":
    case "latin1":
      return "latin1";
  }
  return defaultEncoding;
}

const windows1252x80 = [
  "€ ‚ƒ„…†‡ˆ‰Š‹Œ Ž ",
  " ‘’“”•–—˜™š›œ žŸ",
].join("");

export function patchWindows1252(arg: string) {
  return arg.replaceAll(/[\x80-\x9f]/g, (match: string) => {
    const code = match.charCodeAt(0);
    const r = windows1252x80.charAt(code - 0x80);
    return r === " " ? match : r;
  });
}

export function decodeString(buffer: Buffer, encoding: TranscodeEncoding): string {
  let s = buffer.toString(encoding);
  if (encoding === "latin1") {
    s = patchWindows1252(s);
  }
  return s;
}

class MultilineStream extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  #chunks: Buffer[] = [];

  static reencode(part: string): string {
    const blank = part.indexOf("\r\n\r\n");
    if (blank > 0) {
      const headers = part.slice(0, blank);
      const match = /\nContent-Type:.*;\s*charset=([^\s;]+)/i.exec(
        headers,
      );
      if (match) {
        const encoding = charset2encoding(match[1]);
        if (encoding !== defaultEncoding) {
          part = Buffer.from(part, defaultEncoding).toString(encoding);
        }
      }
    }
    return part;
  }

  override _transform(chunk: Chunk, _encoding: string, done: () => void) {
    const firstChunk = !this.#chunks.length;
    this.#chunks.push(
      chunk instanceof Buffer ? chunk : Buffer.from(chunk),
    );

    let buffer = Buffer.concat(this.#chunks).toString(defaultEncoding);
    let lines: string[];
    if (firstChunk && !Response.isMultiLine(buffer)) {  // syntax error, like with invalid Article ID
      this.push(buffer);
      this.push(null);
    } else if (".\r\n" === buffer.slice(-3)) {
      const blank = buffer.indexOf("\r\n\r\n");
      if (blank > 0) {
        const headers = buffer.slice(0, blank);
        const match = /\nContent-Type:\s*multipart.*;\s*boundary="?([^\s";]+)/i.exec(
          headers,
        );
        if (match) {
          const boundary = "--" + match[1];
          let parts = buffer.split(boundary)
          parts = parts.map(MultilineStream.reencode);
          buffer = parts.join(boundary);
        } else {
          buffer = MultilineStream.reencode(buffer);
        }
      }
      lines = buffer.slice(0, -3).trim().split("\r\n");

      for (const line of lines) {
        this.push(line);
      }

      this.push(null);
    }

    done();
  }
}

class CompressedStream extends Transform {
  #chunks: Buffer[] = [];
  #response?: string;

  override _transform(chunk: Chunk, _encoding: string, done: () => void) {
    this.#chunks.push(
      chunk instanceof Buffer ? chunk : Buffer.from(chunk),
    );

    if (undefined === this.#response) {
      const buffer = Buffer.concat(this.#chunks);
      // Any string encoding can mangle content, especially for a compressed stream
      let crlf: number;
      if (-1 !== (crlf = buffer.indexOf("\r\n"))) {
        crlf += 2;
        this.#response = buffer.slice(0, crlf).toString(defaultEncoding);
        this.#chunks = [
          buffer.slice(crlf),
        ];

        this.push(this.#response);
      }
    }

    done();
  }

  override _flush(done: () => void) {
    zlib.inflate(
      Buffer.concat(this.#chunks),
      (_error: Error, result?: Buffer) => {
        // only care about the end, so slice before converting to string
        if (
          undefined !== result &&
          ".\r\n" === result.slice(-3).toString(defaultEncoding)
        ) {
          this.push(result);
          this.push(null);
        }

        done();
      },
    );
  }
}

export interface ActiveGroup {
  name: string;
  high: number;
  low: number;
  count?: number;
  posting?: boolean;
}

export interface ActiveGroupDict {
  [groupName: string]: {
    high: number;
    low: number;
    posting: boolean;
  };
}

export interface OverviewFieldIsFullDict {
  [fieldName: string]: boolean;
}

export interface MessageOverviewRaw {
  [fieldName: string]: string;
}

export interface MessageLines {
  headers: string[];
  body: string[];
}

export interface NNTPOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
}

const defaults: NNTPOptions = {
  host: "localhost",
  port: 119,
  secure: false,
};

export default class NNTP {
  options: NNTPOptions;
  isConnected = false;
  isReadOnly = false;

  constructor(options?: NNTPOptions) {
    this.options = Object.assign({}, defaults, options);
  }

  #socket?: Socket;

  #throwIfNotConnected(): Socket {
    if (!this.#socket) {
      throw new Error(`not connected`);
    }
    return this.#socket;
  }

  async connect() {
    // TODO Deno does not have `node:tls` module for `secure` option
    this.#socket = connect(this.options.port as number, this.options.host);

    const response = await this.#getResponse(false, false);
    this.isConnected = true;
    switch (response.status) {
      case Response.POSTING_PROHIBITED:
        this.isReadOnly = true;
        // fallthrough
      case Response.POSTING_ALLOWED:
        return response;
    }
    throw new Error(`Service unavailable ${JSON.stringify(response)}`);
  }

  /** Shorthand function for connect and authenticate in one call. */
  async connectAndAuthenticate() {
    const response = await this.connect();
    if (!this.options.username) {
      return response;
    }
    return this.authenticate();
  }

  disconnect() {
    return new Promise<void>((resolve) => {
      const socket = this.#throwIfNotConnected();

      socket.once("end", () => {
        this.isConnected = false;
        resolve();
      });

      socket.end();
    });
  }

  async authenticate() {
    if (!this.options.username) {
      throw new Error(`no username specified`);
    }

    const response = await this.authInfo("USER", this.options.username);

    if (Response.PASSWORD_REQUIRED === response.status) {
      if (undefined === this.options.password) {
        throw new Error(`Password is required`);
      }

      return this.authInfo("PASS", this.options.password);
    }

    return response;
  }

  authInfo(type: string, value: string) {
    return this.#getResponse(false, false, `AUTHINFO ${type} ${value}"`);
  }

  /** messageId can also be message number in current group */
  async article(messageId: string): Promise<MessageLines> {
    if (!this.#socket) {
      throw new Error(`not connected`);
    }

    const response = await this.#getResponse(
      true,
      false,
      `ARTICLE ${messageId}`,
    );

    if (Response.NO_SUCH_ARTICLE === response.status) {
      throw new Error(`No such article`);
    }

    if (Response.SYNTAX_ERROR === response.status) {
      throw new Error(`Invalid syntax for article ID`);
    }

    if (Response.ARTICLE_RETRIEVED !== response.status) {
      throw new Error(
        `Unexpected response received: ${JSON.stringify(response)}`,
      );
    }

    let inBody = false;
    const body: string[] = [];
    const headers: string[] = [];
    response.lines.forEach((line: string) => {
      if (line.trim().length === 0 && inBody === false) {
        inBody = true;
      } else {
        const first = line[0];
        if (inBody) {
          if (first === ".") {
            if (line.length === 1) {
              line = "";
            } else if (line[1] === ".") {
              line = line.slice(1);
            }
          }
          body.push(line);
        } else {
          if ((first === " " || first === "\t") && headers.length) {
            headers[headers.length - 1] += line;
          } else {
            headers.push(line);
          }
        }
      }
    });

    return { headers, body };
  }

  async listActiveGroups(): Promise<ActiveGroupDict> {
    const response = await this.#getResponse(
      true,
      false,
      "LIST ACTIVE",
    );
    if (Response.MULTILINE_FOLLOWS !== response.status) {
      throw new Error(
        `Unexpected response received: ${JSON.stringify(response)}`,
      );
    }
    return response.lines.map((line) => {
      const match = /^(\S+)\s+(\d+)\s+(\d+)(?:\s+(\S+))?/.exec(line.trim()) ||
        [];
      return {
        name: match[1],
        high: parseInt(match[2], 10),
        low: parseInt(match[3], 10),
        posting: match[4] === "y",
      };
    })
      .filter((x) => x.name)
      .reduce((ac: ActiveGroupDict, ag: ActiveGroup) => {
        const { high, low, posting } = ag;
        ac[ag.name] = { high, low, posting: posting || false };
        return ac;
      }, {});
  }

  async group(group: string): Promise<ActiveGroup> {
    const response = await this.#getResponse(
      false,
      false,
      `GROUP ${group}`,
    );

    if (Response.NO_SUCH_GROUP === response.status) {
      throw new Error(`No such group`);
    }

    if (Response.GROUP_SELECTED !== response.status) {
      throw new Error(
        `Unexpected response received: ${JSON.stringify(response)}`,
      );
    }

    const messageParts = response.message.split(/\s+/);

    return {
      name: messageParts[3],
      count: parseInt(messageParts[0], 10),
      low: parseInt(messageParts[1], 10),
      high: parseInt(messageParts[2], 10),
    };
  }

  async overviewFormat() {
    const response = await this.#getResponse(true, false, "LIST OVERVIEW.FMT");

    const format: OverviewFieldIsFullDict = {};
    response.lines.forEach((line: string) => {
      if (line.slice(-5).toLowerCase() === ":full") {
        format[line.slice(0, -5).toLowerCase()] = true;
      } else {
        format[line.slice(0, -1).toLowerCase()] = false;
      }
    });

    return format;
  }

  /** Older overview extension; RFC 2980 (Oct 2000) */
  async xover(range: string, format: OverviewFieldIsFullDict) {
    format = Object.assign({ number: false }, format);

    const response = await this.#getResponse(true, false, `XOVER ${range}`);
    return this.#parseOverview(response.lines, format);
  }

  /** Non-standard compressed overview extension; q.v. RFC 8054 (Jan 2017) */
  async xzver(range: string, format: OverviewFieldIsFullDict) {
    format = Object.assign({ number: false }, format);

    const response = await this.#getResponse(true, true, `XZVER ${range}`);
    return this.#parseOverview(response.lines, format);
  }

  #getResponse(
    multiline: boolean,
    compressed: boolean,
    command?: string,
  ): Promise<Response> {
    const socket = this.#throwIfNotConnected();

    interface Pipeable {
      pipe(destination: Transform): Pipeable;
      on(event: string, handler: (data: Response) => void): void;
    }

    return new Promise<Response>((resolve, reject) => {
      socket.on("error", (error) => {
        reject(error);
      });

      let pipeable: Pipeable = socket;

      if (compressed) {
        pipeable = pipeable.pipe(new CompressedStream());
      }

      if (multiline) {
        pipeable = pipeable.pipe(new MultilineStream());
      }

      pipeable = pipeable.pipe(new ResponseStream(multiline));

      let response: Response;
      pipeable.on("data", (data: Response) => {
        response = data;
      });

      pipeable.on("end", () => {
        resolve(response);
      });

      if (command) {
        socket.write(command + "\r\n");
      }
    })
      .finally(() => {
        socket.unpipe();

        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
      });
  }

  #parseOverview(overview: string[], format: OverviewFieldIsFullDict) {
    return overview.map((line) => {
      const messageParts = line.split("\t");
      const message: MessageOverviewRaw = {};

      for (const [field, full] of Object.entries(format)) {
        const messagePart = messageParts.shift() || "";
        message[field] = full
          ? messagePart.slice(messagePart.indexOf(":") + 1).trim()
          : messagePart;
      }

      return message;
    });
  }
}
