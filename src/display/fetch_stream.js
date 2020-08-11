/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint no-var: error */

import {
  AbortException,
  assert,
  createPromiseCapability,
} from "../shared/util.js";
import {
  createResponseStatusError,
  extractFilenameFromHeader,
  validateRangeRequestCapabilities,
  validateResponseStatus,
} from "./network_utils.js";

function createFetchOptions(headers, withCredentials, abortController) {
  return {
    method: "GET",
    headers,
    signal: abortController && abortController.signal,
    mode: "cors",
    credentials: withCredentials ? "include" : "same-origin",
    redirect: "follow",
  };
}

function createHeaders(httpHeaders) {
  const headers = new Headers();
  for (const property in httpHeaders) {
    const value = httpHeaders[property];
    if (typeof value === "undefined") {
      continue;
    }
    headers.append(property, value);
  }
  return headers;
}

/** @implements {IPDFStream} */
class PDFFetchStream {
  constructor(source) {
    this.source = source;
    this.isHttp = /^https?:/i.test(source.url);
    this.httpHeaders = (this.isHttp && source.httpHeaders) || {};

    this._fullRequestReader = null;
    this._rangeRequestReaders = [];
  }

  get _progressiveDataLength() {
    return this._fullRequestReader ? this._fullRequestReader._loaded : 0;
  }

  getFullReader() {
    assert(!this._fullRequestReader);
    this._fullRequestReader = new PDFFetchStreamReader(this);
    return this._fullRequestReader;
  }

  getRangeReader(begin, end) {
    if (end <= this._progressiveDataLength) {
      return null;
    }
    const reader = new PDFFetchStreamRangeReader(this, begin, end);
    this._rangeRequestReaders.push(reader);
    return reader;
  }

  cancelAllRequests(reason) {
    if (this._fullRequestReader) {
      this._fullRequestReader.cancel(reason);
    }
    const readers = this._rangeRequestReaders.slice(0);
    readers.forEach(function(reader) {
      reader.cancel(reason);
    });
  }
}

/** @implements {IPDFStreamReader} */
class PDFFetchStreamReader {
  constructor(stream) {
    this._stream = stream;
    this._reader = null;
    this._loaded = 0;
    this._filename = null;
    this._response = null;
    const source = stream.source;
    this._withCredentials = source.withCredentials || false;
    this._contentLength = source.length;
    this._headersCapability = createPromiseCapability();
    this._disableRange = source.disableRange || false;
    this._rangeChunkSize = source.rangeChunkSize;
    if (!this._rangeChunkSize && !this._disableRange) {
      this._disableRange = true;
    }

    if (typeof AbortController !== "undefined") {
      this._abortController = new AbortController();
    }
    this._isStreamingSupported = !source.disableStream;
    this._isRangeSupported = !source.disableRange;

    this._headers = createHeaders(this._stream.httpHeaders);

    const url = source.url;
    fetch(
      url,
      createFetchOptions(
        this._headers,
        this._withCredentials,
        this._abortController
      )
    )
      .then(response => {
        if (!validateResponseStatus(response.status)) {
          throw createResponseStatusError(response.status, url);
        }
        this._reader = response.body.getReader();
        this._headersCapability.resolve();

        const getResponseHeader = name => {
          return response.headers.get(name);
        };
        const {
          allowRangeRequests,
          suggestedLength,
        } = validateRangeRequestCapabilities({
          getResponseHeader,
          isHttp: this._stream.isHttp,
          rangeChunkSize: this._rangeChunkSize,
          disableRange: this._disableRange,
        });

        this._isRangeSupported = allowRangeRequests;
        // Setting right content length.
        this._contentLength = suggestedLength || this._contentLength;

        this._filename = extractFilenameFromHeader(getResponseHeader);

        // We need to stop reading when range is supported and streaming is
        // disabled.
        if (!this._isStreamingSupported && this._isRangeSupported) {
          this.cancel(new AbortException("Streaming is disabled."));
        }
      })
      .catch(this._headersCapability.reject);

    this.onProgress = null;
  }

  get headersReady() {
    return this._headersCapability.promise;
  }

  get filename() {
    return this._filename;
  }

  get contentLength() {
    return this._contentLength;
  }

  get isRangeSupported() {
    return this._isRangeSupported;
  }

  get isStreamingSupported() {
    return this._isStreamingSupported;
  }

  async read() {
    await this._headersCapability.promise;
    const { value, done } = await this._reader.read();
    if (done) {
      return { value, done };
    }

    /* Sridhar Change - start */
    const buffer = new Uint8Array(value).buffer;
    let decryptedBuffer = buffer;

    let pdfUrl = undefined;
    if (this._response) {
      pdfUrl = this._response.url;
    }

    if (!pdfUrl) {
      pdfUrl = this._stream.source.url;
    }

    if ((pdfUrl.indexOf('.epdf') > 0) &&
    (pdfUrl.indexOf('/ldrm/') > 0) &&
    (value.byteLength > 0)) {
      let offset = this._loaded;
      decryptedBuffer = window['_x56x7823x90led'](buffer,
        offset,
        pdfUrl);
    }
    /* Sridhar Change - end */

    this._loaded += value.byteLength;
    if (this.onProgress) {
      this.onProgress({
        loaded: this._loaded,
        total: this._contentLength,
      });
    }

    return { value: decryptedBuffer, done: false, };
  }

  cancel(reason) {
    if (this._reader) {
      this._reader.cancel(reason);
    }
    if (this._abortController) {
      this._abortController.abort();
    }
  }
}

/** @implements {IPDFStreamRangeReader} */
class PDFFetchStreamRangeReader {
  constructor(stream, begin, end) {
    this._stream = stream;
    this._reader = null;
    this._loaded = 0;
    this._response = null;
    const source = stream.source;
    this._withCredentials = source.withCredentials || false;
    this._readCapability = createPromiseCapability();
    this._isStreamingSupported = !source.disableStream;

    if (typeof AbortController !== "undefined") {
      this._abortController = new AbortController();
    }

    this._headers = createHeaders(this._stream.httpHeaders);
    this._headers.append("Range", `bytes=${begin}-${end - 1}`);

    const url = source.url;
    fetch(
      url,
      createFetchOptions(
        this._headers,
        this._withCredentials,
        this._abortController
      )
    ).then(response => {
      if (!validateResponseStatus(response.status)) {
        throw createResponseStatusError(response.status, url);
      }
      this._readCapability.resolve();
      this._response = response;
      this._reader = response.body.getReader();
    });

    this.onProgress = null;
  }

  get isStreamingSupported() {
    return this._isStreamingSupported;
  }

  async read() {
    await this._readCapability.promise;
    const { value, done } = await this._reader.read();
    if (done) {
      return { value, done };
    }

    /* Sridhar Change - start */
    const buffer = new Uint8Array(value).buffer;
    let decryptedBuffer = buffer;

    if ((this._response.url.indexOf('.epdf') > 0) &&
    (this._response.url.indexOf('/ldrm/') > 0) &&
    (value.byteLength > 0)) {
      let rangeHeader = this._response.headers.get('Content-Range');
      if (!rangeHeader) {
        rangeHeader = this._response.headers.get('content-range');
      }

      let startOffsetInt = 0;
      if (rangeHeader) {
        if ((rangeHeader.indexOf('bytes ') === 0) &&
            (rangeHeader.indexOf('-') > 0)) {
          let startOffset = rangeHeader.substring(6, rangeHeader.indexOf('-'));

          if (startOffset.trim().length > 0) {
            startOffsetInt = parseInt(startOffset.trim(), 10);
          } else {
            throw new Error('Invalid offset during decrypt');
          }
        }
      }

      decryptedBuffer = window['_x56x7823x90led'](buffer,
        (startOffsetInt + this._loaded),
        this._response.url);
    }
    /* Sridhar Change - end */

    this._loaded += value.byteLength;
    if (this.onProgress) {
      this.onProgress({ loaded: this._loaded });
    }

    return { value: decryptedBuffer, done: false, };
  }

  cancel(reason) {
    if (this._reader) {
      this._reader.cancel(reason);
    }
    if (this._abortController) {
      this._abortController.abort();
    }
  }
}

export { PDFFetchStream };
