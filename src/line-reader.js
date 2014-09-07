"use strict";
var fs = require('fs');

// readSize is optional (defaults to 1024)
// throws if file can't be opened or read
module.exports = function(fname, readSize) {
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
    }

    this.readLineSync = function() {
        try {
            var result;
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
};

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