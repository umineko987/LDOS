import { m } from "#lib/paraglide/messages.js";

import { isApiError } from "./errors.ts";

const CLIENT_MESSAGES: Readonly<Record<string, () => string>> = {
  http_error: m.api_error_http,
  invalid_response: m.api_error_invalid_response,
  network_error: m.api_error_network,
  response_read_failed: m.api_error_read_failed,
  response_too_large: m.api_error_too_large,
};

/**
 * 给用户看的错误说明：客户端错误码按当前语言翻译，后端错误用后端给的文案，
 * 其余情况（契约不符、未知异常）给一句通用说明，不暴露原始异常文本。
 */
export function apiErrorMessage(error: unknown): string {
  if (!isApiError(error)) return m.api_error_unexpected();
  const message = Object.hasOwn(CLIENT_MESSAGES, error.code) ? CLIENT_MESSAGES[error.code] : undefined;
  if (message) return error.code === "http_error" && error.status ? m.api_error_http_status({ status: error.status }) : message();
  return error.message === error.code ? m.api_error_unexpected() : error.message;
}
