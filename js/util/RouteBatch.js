// XHR progress keeps streaming available without requiring ReadableStream support.
BR.RouteBatch = {
    request(url, params, onEvent) {
        const xhr = new XMLHttpRequest();
        let resolve, reject;
        const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        let offset = 0;
        let settled = false;
        let complete = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve();
        };
        const fail = (error) => {
            finish(error);
            xhr.abort();
        };
        const progress = () => {
            if (settled || xhr.status !== 200) return;
            try {
                if (!(xhr.getResponseHeader('Content-Type') || '').startsWith('application/x-ndjson'))
                    throw new Error('Unexpected batch response');
                const text = xhr.responseText;
                let end;
                while ((end = text.indexOf('\n', offset)) !== -1) {
                    const line = text.slice(offset, end).trim();
                    offset = end + 1;
                    if (!line) continue;
                    if (complete) throw new Error('Event after batch completion');
                    const event = JSON.parse(line);
                    if (event.type === 'complete') complete = true;
                    onEvent(event);
                }
            } catch (error) {
                fail(error);
            }
        };
        xhr.open('POST', url, true);
        xhr.timeout = 310000;
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
        xhr.onprogress = progress;
        xhr.onload = () => {
            if (settled) return;
            if (xhr.status !== 200) {
                const error = new Error('Batch request failed');
                error.status = xhr.status;
                finish(error);
                return;
            }
            progress();
            if (!settled && (!complete || xhr.responseText.slice(offset).trim()))
                finish(new Error('Incomplete batch stream'));
            else if (!settled) finish();
        };
        xhr.onerror = xhr.ontimeout = () => finish(new Error('Batch request interrupted'));
        xhr.onabort = () => {
            const error = new Error('Batch request aborted');
            error.aborted = true;
            finish(error);
        };
        xhr.send(params.toString());
        return { promise, abort: () => xhr.abort() };
    },
};
