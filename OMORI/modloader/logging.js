{
    let fs = require('fs');
    let fd = fs.openSync("latest.log", "w");
    let startTime = new Date().getTime();
    // Web build: some patch errors (e.g. fast-json-patch's OperationError) stringify
    // the ENTIRE document being patched, producing a single multi-hundred-thousand-line
    // log call. That bloats latest.log until localStorage throws QuotaExceededError and
    // kills the boot. Cap each call so one bad error can never blow up the log.
    const MAX_LOG_CALL = 4000;
    window._logLine = function(text) {
        let currTime = new Date().getTime();
        let diff = currTime - startTime;
        diff /= 1000;
        text = (text === undefined || text === null) ? String(text) : String(text);
        if (text.length > MAX_LOG_CALL) {
            text = text.slice(0, MAX_LOG_CALL) +
                `... [truncated: ${text.length - MAX_LOG_CALL} chars omitted]`;
        }
        logLine = `[${diff.toFixed(3).padStart(10, " ")}] ${text}\n`;
        fs.writeSync(fd, logLine);
    }
}