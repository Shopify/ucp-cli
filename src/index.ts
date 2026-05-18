// Public library entry.
//
// v0.1 deliberately does not publish a plugin-author SDK. The plugin loader,
// subprocess contract, and plugin envelope are still draft surfaces tracked in
// local planning docs; exporting them now would freeze a contract before the
// dispatcher actually supports it.
//
// Keep this root export narrow until we have a real downstream library use case.

export {
  type ErrorCode,
  ErrorCodes,
  isUcpError,
  UcpError,
  type UcpErrorOptions,
} from './lib/errors.js'
