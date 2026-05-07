"use strict";

const { Transform } = require("node:stream");
const { spec } = require("node:test/reporters");

class SpacedSpecReporter extends Transform {
    constructor() {
        super({ writableObjectMode: true });
        this.pendingText = "";
        this.lastPrintedNonEmptyLine = "";
        this.previousLineWasBlank = false;
        this.reporter = spec();
        this.reporter.on("data", (chunk) => {
            this.push(this.rewriteText(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)));
        });
        this.reporter.on("error", (error) => {
            this.destroy(error);
        });
    }

    rewriteText(text) {
        this.pendingText += text;
        let output = "";
        let newlineIndex = this.pendingText.indexOf("\n");
        while (newlineIndex !== -1) {
            let line = this.pendingText.slice(0, newlineIndex + 1);
            this.pendingText = this.pendingText.slice(newlineIndex + 1);
            if (/^\s*▶ /.test(line) && this.lastPrintedNonEmptyLine && !this.previousLineWasBlank) line = "\n" + line;
            this.previousLineWasBlank = !line.trim();
            if (line.trim()) this.lastPrintedNonEmptyLine = line.trimEnd();
            output += line;
            newlineIndex = this.pendingText.indexOf("\n");
        }
        return output;
    }

    _transform(event, encoding, callback) {
        if (this.reporter.write(event, encoding)) return callback();
        this.reporter.once("drain", callback);
    }

    _flush(callback) {
        this.reporter.end();
        this.reporter.once("end", () => {
            if (this.pendingText) {
                let output = this.pendingText;
                if (/^\s*▶ /.test(output) && this.lastPrintedNonEmptyLine && !this.previousLineWasBlank) output = "\n" + output;
                this.push(output);
                this.pendingText = "";
            }
            callback();
        });
    }
}

module.exports = SpacedSpecReporter;
