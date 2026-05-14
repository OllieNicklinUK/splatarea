export function createMockResponse() {
    const result = {
        statusCode: 200,
        headers: {},
        body: null,
        writableEnded: false,
        destroyed: false
    };

    return {
        result,
        status(code) {
            result.statusCode = code;
            return this;
        },
        json(payload) {
            result.body = payload;
            result.writableEnded = true;
            return this;
        },
        setHeader(name, value) {
            result.headers[name.toLowerCase()] = value;
        },
        write(chunk) {
            result.lastChunk = chunk;
        },
        end(chunk) {
            if (typeof chunk !== 'undefined') result.lastChunk = chunk;
            result.writableEnded = true;
            return this;
        }
    };
}
