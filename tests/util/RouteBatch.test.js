/** @jest-environment jsdom */
BR = {};
require('../../js/util/RouteBatch.js');

let xhr;
beforeEach(() => {
    xhr = {
        status: 200,
        responseText: '',
        open: jest.fn(),
        send: jest.fn(),
        setRequestHeader: jest.fn(),
        getResponseHeader: () => 'application/x-ndjson; charset=utf-8',
        abort: jest.fn(() => xhr.onabort()),
    };
    jest.spyOn(global, 'XMLHttpRequest').mockImplementation(() => xhr);
});
afterEach(() => jest.restoreAllMocks());

test('delivers complete lines before the stream ends, retaining partial lines', async () => {
    const event = jest.fn();
    const handle = BR.RouteBatch.request('/brouter/batch', new URLSearchParams({ 'scenario.current': '' }), event);
    xhr.responseText = '{"type":"start","message":"Mün';
    xhr.onprogress();
    expect(event).not.toHaveBeenCalled();
    xhr.responseText += 'chen"}\n{"type":"result","id":"current"}\n{"type":"com';
    xhr.onprogress();
    expect(event).toHaveBeenCalledTimes(2);
    expect(event.mock.calls[0][0].message).toBe('München');
    xhr.responseText += 'plete"}\n';
    xhr.onload();
    await handle.promise;
    expect(event).toHaveBeenCalledTimes(3);
    expect(xhr.timeout).toBe(310000);
    expect(xhr.send).toHaveBeenCalledWith('scenario.current=');
});

test('rejects truncated streams, malformed events and events after completion', async () => {
    for (const text of ['{"type":"start"}\n', '{bad}\n', '{"type":"complete"}\n{"type":"result"}\n']) {
        xhr.responseText = text;
        const handle = BR.RouteBatch.request('/batch', new URLSearchParams(), () => {});
        xhr.onload();
        await expect(handle.promise).rejects.toBeInstanceOf(Error);
    }
});

test('preserves HTTP status for fallback and rejects aborts', async () => {
    const missing = BR.RouteBatch.request('/batch', new URLSearchParams(), () => {});
    xhr.status = 404;
    xhr.onload();
    await expect(missing.promise).rejects.toMatchObject({ status: 404 });
    xhr.status = 200;
    const active = BR.RouteBatch.request('/batch', new URLSearchParams(), () => {});
    active.abort();
    await expect(active.promise).rejects.toMatchObject({ aborted: true });
});
