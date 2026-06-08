const { requestHandler } = require("../../server");

exports.handler = async function handler(event) {
  const params = new URLSearchParams(event.queryStringParameters || {});
  const route = params.get("route") || (params.has("symbol") ? "market" : "context");
  params.delete("route");
  const query = params.toString();

  return new Promise((resolve) => {
    let statusCode = 200;
    let headers = {};
    const req = {
      url: `/api/${route}${query ? `?${query}` : ""}`,
      headers: { host: event.headers?.host || "localhost" }
    };
    const res = {
      writeHead(status, responseHeaders) {
        statusCode = status;
        headers = responseHeaders || {};
      },
      end(body = "") {
        resolve({
          statusCode,
          headers,
          body: Buffer.isBuffer(body) ? body.toString("base64") : String(body),
          isBase64Encoded: Buffer.isBuffer(body)
        });
      }
    };
    requestHandler(req, res);
  });
};
