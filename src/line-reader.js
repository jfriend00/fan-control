"use strict";
var fs = require('fs');


// readSize is optional (defaults to 1024)
// throws if file can't be opened or read
function LineByLineSync(fname, readSize) {
    readSize = readSize || 1024;
    var buffer = new Buffer(readSize);
    var data = "";
    var fd = fs.openSync(fname, "r");
    var done = false;
    
    // if you read to the end, the file will auto-close
    // so this does not need to be called
    this.close = function() {
        data = "";
        buffer = null;
        done = true;
        if (fd) {
            fs.closeSync(fd);
            fd = null;
        }
    };

    this.readLineSync = function() {
        var result;
        try {
            if (done) { return null; }

            var pos, bytesRead = 1;
            while ((pos = data.indexOf('\n')) === -1 && bytesRead > 0) {
                bytesRead = fs.readSync(fd, buffer, 0, readSize, null);
                data += buffer.slice(0, bytesRead).toString();
            }
            if (pos !== -1) {
                result = data.slice(0, pos + 1).replace(/[\r\n]/g, "");
                data = data.slice(pos + 1);
            } else {
                result = data;
                this.close();
            }
        } catch(e) {
            // clean up, then rethrow
            if (fd) {
                this.close();
            }
            throw e;
        }
        return result;
    };
}

// caller subscribes to:
// s.on("line", function(line) {...});
// s.on("done", function() {...});
// s.on("error", function(err) {...});
// options is optional (supports same options as fs.createReadStream(fname, options)
// options will take all readStream defaults if not present except encoding will be set to ascii
function createReadLineStream(fname, options) {
    options = options || {};
    options.encoding = options.encoding || "ascii";
    var self = fs.createReadStream(fname, options);
    var regex = /[\r\n]/g;
    var data = "", pos, line;
    // flow the stream
    self.on("data", function(chunk) {
        try {
            data += chunk;
            while ((pos = data.indexOf('\n')) !== -1) {
                line = data.slice(0, pos + 1).replace(regex, "");
                data = data.slice(pos + 1);
                self.emit("line", line);
            }
        } catch(e) {
            self.emit("error", e);
            self.destroy();            
        }
    });
    self.on("end", function() {
        if (data.length) {
            self.emit("line", data.replace(regex, ""));
        }
        self.emit("done");
    });
    return self;    
}

module.exports = {sync: LineByLineSync, readLineStream: createReadLineStream};



/* Example Code

var lineReader = require("./src/line-reader.js");
try {
    var lr = new lineReader(fname), line;
    while ((line = lr.readLineSync()) !== null) {
        // code here to process line
        // newline characters have been stripped
    }
} catch(e) {

}

*/ 